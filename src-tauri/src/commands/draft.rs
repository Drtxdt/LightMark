use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use super::file::{fingerprint_if_exists, transaction_index_root, write_text_file_at_root};
use super::models::{
    DraftListIssue, DraftListReceipt, DraftRecord, FileSnapshot, LargeFileError,
    TextFileWriteReceipt,
};

static DRAFT_WRITE_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>>
    = OnceLock::new();

fn draft_write_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    DRAFT_WRITE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn write_draft(app: AppHandle, record: DraftRecord) -> Result<TextFileWriteReceipt, LargeFileError> {
    let safe_id = sanitize_draft_id(&record.id)
        .map_err(|error| LargeFileError::new("draft-id-invalid", error))?;
    let path = drafts_dir(&app)
        .map_err(|error| LargeFileError::new("draft-directory-failed", error))?
        .join(format!("{safe_id}.json"));
    write_draft_at_path_locked(&safe_id, &path, &record)
}

fn write_draft_at_path_locked(
    safe_id: &str,
    path: &Path,
    record: &DraftRecord,
) -> Result<TextFileWriteReceipt, LargeFileError> {
    let write_lock = lock_for_draft(safe_id)?;
    let _write_guard = write_lock.lock().map_err(|_| {
        LargeFileError::new("draft-lock-poisoned", "draft write lock was poisoned")
    })?;
    write_draft_record_at_path(path, record)
}

fn write_draft_record_at_path(
    path: &std::path::Path,
    record: &DraftRecord,
) -> Result<TextFileWriteReceipt, LargeFileError> {
    let content = serde_json::to_string_pretty(&record)
        .map_err(|error| LargeFileError::new("draft-serialize-failed", error.to_string()))?;
    let expected = fingerprint_if_exists(&path)?;
    write_text_file_at_root(
        &path,
        &content,
        expected,
        transaction_index_root(path.parent().unwrap_or_else(|| std::path::Path::new("."))),
    )
}

fn lock_for_draft(safe_id: &str) -> Result<Arc<Mutex<()>>, LargeFileError> {
    let mut locks = draft_write_locks()
        .lock()
        .map_err(|_| LargeFileError::new("draft-lock-poisoned", "draft write lock was poisoned"))?;
    Ok(locks
        .entry(safe_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

#[tauri::command]
pub fn read_draft(app: AppHandle, draft_id: String) -> Result<DraftRecord, String> {
    let path = draft_file_path(&app, &draft_id)?;
    let content =
        fs::read_to_string(&path).map_err(|err| format!("Failed to read draft {}: {err}", path.display()))?;
    serde_json::from_str(&content).map_err(|err| format!("Failed to parse draft {}: {err}", path.display()))
}

#[tauri::command]
pub fn delete_draft(app: AppHandle, draft_id: String) -> Result<(), String> {
    let safe_id = sanitize_draft_id(&draft_id)?;
    let path = drafts_dir(&app)?.join(format!("{safe_id}.json"));
    delete_draft_at_path_locked(&safe_id, &path)
}

fn delete_draft_at_path_locked(safe_id: &str, path: &Path) -> Result<(), String> {
    let write_lock = lock_for_draft(safe_id).map_err(|error| error.to_string())?;
    let _write_guard = write_lock
        .lock()
        .map_err(|_| "Draft write lock was poisoned.".to_string())?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|err| format!("Failed to delete draft {}: {err}", path.display()))
}

#[tauri::command]
pub fn list_drafts(app: AppHandle) -> Result<DraftListReceipt, String> {
    let dir = drafts_dir(&app)?;
    list_drafts_at_dir(&dir)
}

fn list_drafts_at_dir(dir: &std::path::Path) -> Result<DraftListReceipt, String> {
    if !dir.exists() {
        return Ok(DraftListReceipt {
            records: Vec::new(),
            issues: Vec::new(),
        });
    }
    let mut records = Vec::new();
    let mut issues = Vec::new();
    for entry in fs::read_dir(dir)
        .map_err(|err| format!("Failed to read draft folder {}: {err}", dir.display()))?
    {
        let entry = entry.map_err(|err| {
            format!("Failed to inspect draft folder {}: {err}", dir.display())
        })?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) => {
                issues.push(DraftListIssue {
                    path: path.to_string_lossy().into_owned(),
                    code: "draft-read-failed".to_string(),
                    message: error.to_string(),
                });
                continue;
            }
        };
        match serde_json::from_str::<DraftRecord>(&content) {
            Ok(record) => records.push(record),
            Err(error) => issues.push(DraftListIssue {
                path: path.to_string_lossy().into_owned(),
                code: "draft-parse-failed".to_string(),
                message: error.to_string(),
            }),
        }
    }
    records.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(DraftListReceipt { records, issues })
}

#[tauri::command]
pub fn get_file_snapshot(path: String) -> Result<FileSnapshot, String> {
    let path = PathBuf::from(path);
    let Ok(metadata) = fs::metadata(&path) else {
        return Ok(FileSnapshot {
            exists: false,
            mtime: None,
            size: None,
        });
    };
    Ok(FileSnapshot {
        exists: true,
        mtime: metadata.modified().ok().map(system_time_millis),
        size: Some(metadata.len()),
    })
}

fn draft_file_path(app: &AppHandle, draft_id: &str) -> Result<PathBuf, String> {
    let safe_id = sanitize_draft_id(draft_id)?;
    Ok(drafts_dir(app)?.join(format!("{safe_id}.json")))
}

fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("drafts"))
        .map_err(|err| format!("Failed to locate app data folder: {err}"))
}

fn sanitize_draft_id(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.contains("..")
        || value.contains('/')
        || value.contains('\\')
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("Draft id is empty.".to_string());
    }
    Ok(value.to_string())
}

fn system_time_millis(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        delete_draft_at_path_locked, list_drafts_at_dir, sanitize_draft_id,
        write_draft_at_path_locked,
    };
    #[cfg(windows)]
    use crate::commands::file::set_text_write_transaction_hook;
    use crate::commands::file::transaction_index_root;
    use crate::commands::large_file_base::FileBaseSnapshot;
    use crate::commands::file_replace_transaction::{
        DiskWriteStatus, FileReplaceTransaction, TransactionOutcome,
    };
    use crate::commands::models::DraftRecord;
    use std::fs;
    use std::path::PathBuf;
    #[cfg(windows)]
    use std::sync::{mpsc, Arc, Barrier};
    #[cfg(windows)]
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};
    #[cfg(windows)]
    use std::time::Duration;

    #[test]
    fn rejects_empty_draft_id() {
        assert!(sanitize_draft_id("").is_err());
    }

    #[test]
    fn rejects_path_like_draft_id() {
        assert!(sanitize_draft_id("../escape").is_err());
        assert!(sanitize_draft_id("folder/name").is_err());
        assert!(sanitize_draft_id("folder\\name").is_err());
    }

    #[test]
    fn accepts_expected_draft_ids() {
        assert_eq!(sanitize_draft_id("file-abc_123").unwrap(), "file-abc_123");
        assert_eq!(sanitize_draft_id("untitled.abc").unwrap(), "untitled.abc");
    }

    #[test]
    fn write_draft_entry_serializes_and_publishes_a_receipt() {
        let dir = unique_test_dir("draft-entry-success");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("entry.json");
        let record = draft_record("entry", "new content", 7);

        let receipt = write_draft_at_path_locked("entry", &path, &record)
            .expect("the production draft writer should publish the record");

        assert_eq!(receipt.path, path.to_string_lossy());
        assert_eq!(receipt.outcome, "committed");
        assert_eq!(receipt.disk_written, "yes");
        let persisted: DraftRecord = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted.id, "entry");
        assert_eq!(persisted.content.as_deref(), Some("new content"));
        assert_eq!(persisted.updated_at, 7);

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn failed_draft_entry_keeps_previous_json_and_reports_recovery_artifact() {
        let dir = unique_test_dir("draft-entry-failure");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("entry.json");
        let previous = draft_record("entry", "previous", 1);
        write_draft_at_path_locked("entry", &path, &previous).unwrap();
        let previous_bytes = fs::read(&path).unwrap();

        set_text_write_transaction_hook(|transaction| transaction.with_target_share_violation());
        let next = draft_record("entry", "next", 2);
        let error = write_draft_at_path_locked("entry", &path, &next)
            .expect_err("a target held without DELETE sharing must fail the draft transaction");

        assert_eq!(error.outcome.as_deref(), Some("not-committed"));
        assert_eq!(error.disk_written.as_deref(), Some("no"));
        let artifact = error
            .recovery_artifact
            .as_ref()
            .expect("the failed write must expose its recovery material");
        let artifact_path = PathBuf::from(artifact);
        assert!(artifact_path.is_dir());
        assert!(artifact_path.join("output").is_file());
        assert!(error.message.contains("ReplaceFileW"));
        assert_eq!(fs::read(&path).unwrap(), previous_bytes);

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn draft_delete_waits_for_same_id_write_and_runs_after_it() {
        let dir = unique_test_dir("draft-write-delete-order");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("entry.json");
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let (started_tx, started_rx) = mpsc::channel();
        let writer_path = path.clone();
        let writer_entered = Arc::clone(&entered);
        let writer_release = Arc::clone(&release);
        let writer = thread::spawn(move || {
            set_text_write_transaction_hook(move |transaction| {
                started_tx.send(()).unwrap();
                writer_entered.wait();
                writer_release.wait();
                transaction
            });
            write_draft_at_path_locked(
                "entry",
                &writer_path,
                &draft_record("entry", "in-flight", 3),
            )
        });

        // The transaction hook is installed by the writer immediately before
        // entering the production writer. On Windows it runs after the
        // replacement has been prepared, while the per-id lock is held.
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("writer should reach its prepared transaction hook");

        // Let the writer announce that it owns the lock, then verify delete
        // cannot pass it. The release barrier is opened only after delete is
        // observed waiting, so deletion is ordered after publication.
        entered.wait();
        let delete_path = path.clone();
        let deleter = thread::spawn(move || delete_draft_at_path_locked("entry", &delete_path));
        thread::sleep(Duration::from_millis(25));
        assert!(!deleter.is_finished(), "delete must wait for the in-flight writer");
        release.wait();

        let write_result = writer.join().unwrap();
        assert!(write_result.is_ok(), "the real draft writer should finish first");
        assert!(deleter.join().unwrap().is_ok());
        assert!(!path.exists(), "the ordered delete should remove the published draft");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_keeps_valid_records_and_reports_corrupt_json() {
        let dir = unique_test_dir("draft-list-issues");
        fs::create_dir_all(&dir).unwrap();
        let valid = DraftRecord {
            id: "valid".to_string(),
            kind: "markdown".to_string(),
            schema_version: None,
            path: Some("note.md".to_string()),
            content: Some("# valid".to_string()),
            pending_edits: None,
            large_snapshot: None,
            file_mtime: None,
            file_size: None,
            updated_at: 2,
            editor_mode: Some("source".to_string()),
        };
        fs::write(
            dir.join("valid.json"),
            serde_json::to_vec_pretty(&valid).unwrap(),
        )
        .unwrap();
        let corrupt_path = dir.join("corrupt.json");
        fs::write(&corrupt_path, b"{ definitely not json").unwrap();

        let listed = list_drafts_at_dir(&dir).unwrap();
        assert_eq!(listed.records.len(), 1);
        assert_eq!(listed.records[0].id, "valid");
        assert_eq!(listed.issues.len(), 1);
        assert_eq!(listed.issues[0].code, "draft-parse-failed");
        assert_eq!(listed.issues[0].path, corrupt_path.to_string_lossy());
        assert_eq!(fs::read(&corrupt_path).unwrap(), b"{ definitely not json");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_draft_transaction_keeps_previous_json_and_new_output_recovery() {
        let dir = unique_test_dir("draft-transaction-failure");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("draft.json");
        let replacement = dir.join("replacement");
        let previous = br#"{"id":"draft","content":"previous"}"#.to_vec();
        let next = br#"{"id":"draft","content":"next"}"#.to_vec();
        fs::write(&target, &previous).unwrap();
        fs::write(&replacement, &next).unwrap();
        let expected = FileBaseSnapshot::fingerprint_path(&target, 64 * 1024).unwrap();
        let transaction = FileReplaceTransaction::prepare(
            &target,
            Some(expected),
            &replacement,
            transaction_index_root(&dir),
        )
        .unwrap()
        .with_target_share_violation();
        let receipt = transaction.commit();

        assert_eq!(receipt.outcome, TransactionOutcome::NotCommitted);
        assert_eq!(receipt.disk_written, DiskWriteStatus::No);
        assert_eq!(fs::read(&target).unwrap(), previous);
        assert!(receipt.recovery_artifact.is_some());
        assert!(receipt.output_path.is_file());

        fs::remove_dir_all(dir).unwrap();
    }

    fn draft_record(id: &str, content: &str, updated_at: u64) -> DraftRecord {
        DraftRecord {
            id: id.to_string(),
            kind: "markdown".to_string(),
            schema_version: None,
            path: Some("note.md".to_string()),
            content: Some(content.to_string()),
            pending_edits: None,
            large_snapshot: None,
            file_mtime: None,
            file_size: None,
            updated_at,
            editor_mode: Some("source".to_string()),
        }
    }

    fn unique_test_dir(label: &str) -> PathBuf {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        std::env::temp_dir().join(format!("lightmark-{label}-{}-{millis}", std::process::id()))
    }
}
