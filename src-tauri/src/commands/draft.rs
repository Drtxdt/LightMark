use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use super::models::{DraftRecord, FileSnapshot};

#[tauri::command]
pub fn write_draft(app: AppHandle, record: DraftRecord) -> Result<(), String> {
    let path = draft_file_path(&app, &record.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create draft folder {}: {err}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(&record)
        .map_err(|err| format!("Failed to serialize draft: {err}"))?;
    fs::write(&path, content).map_err(|err| format!("Failed to write draft {}: {err}", path.display()))
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
    let path = draft_file_path(&app, &draft_id)?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|err| format!("Failed to delete draft {}: {err}", path.display()))
}

#[tauri::command]
pub fn list_drafts(app: AppHandle) -> Result<Vec<DraftRecord>, String> {
    let dir = drafts_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|err| format!("Failed to read draft folder {}: {err}", dir.display()))? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(record) = serde_json::from_str::<DraftRecord>(&content) {
            records.push(record);
        }
    }
    records.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(records)
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
    use super::sanitize_draft_id;

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
}
