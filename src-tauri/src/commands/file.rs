use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use regex::RegexBuilder;
use rfd::FileDialog;
use tauri::{AppHandle, Emitter, Manager};

use super::models::{
    AssetFileInfo, AssetInspection, DirtyState, FileChunk, FileInfo, FileNode, FileWatchEvent,
    LargeCloseDisposition, LargeCloseReceipt, LargeCoordinateSpace, LargeFileError,
    LargeFileFingerprint, LargeFileSession, LargeFindMatch, LargeFindOptions, LargeFindResult,
    LargeOutlineItem, LargeSaveReceipt, SimilarFileCandidate, TextEdit, WorkspaceWatchEvent,
};
use super::large_file_base::{FileBaseSnapshot, SnapshotError, SourceFingerprint};
use super::large_text_view::{SegmentedTextView, ViewEdit, ViewError};

const LARGE_FILE_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;
const FILE_WATCH_EVENT: &str = "lightmark-file-watch-event";
const WORKSPACE_WATCH_EVENT: &str = "lightmark-workspace-watch-event";
const ASSET_WATCH_EVENT: &str = "lightmark-asset-watch-event";

#[derive(Clone)]
struct SessionState {
    path: PathBuf,
    snapshot_root: PathBuf,
    base: Arc<FileBaseSnapshot>,
    view: SegmentedTextView<FileBaseSnapshot>,
    size_bytes: u64,
    outline: Vec<LargeOutlineItem>,
    revision: u64,
    saved_revision: u64,
    pending_edit_count: usize,
    base_fingerprint: SourceFingerprint,
    disk_fingerprint: SourceFingerprint,
    persistence_generation: u64,
}

static LARGE_SESSIONS: OnceLock<Mutex<HashMap<String, SessionState>>> = OnceLock::new();
static FILE_WATCHERS: OnceLock<Mutex<HashMap<String, FileWatcherEntry>>> = OnceLock::new();
static WORKSPACE_WATCHER: OnceLock<Mutex<Option<FileWatcherEntry>>> = OnceLock::new();
static ASSET_WATCHER: OnceLock<Mutex<Option<FileWatcherEntry>>> = OnceLock::new();

#[cfg(test)]
static SAVE_PLAN_SYNC: OnceLock<Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>> =
    OnceLock::new();

struct FileWatcherEntry {
    _watcher: RecommendedWatcher,
}

fn sessions() -> &'static Mutex<HashMap<String, SessionState>> {
    LARGE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_watchers() -> &'static Mutex<HashMap<String, FileWatcherEntry>> {
    FILE_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn workspace_watcher() -> &'static Mutex<Option<FileWatcherEntry>> {
    WORKSPACE_WATCHER.get_or_init(|| Mutex::new(None))
}

fn asset_watcher() -> &'static Mutex<Option<FileWatcherEntry>> {
    ASSET_WATCHER.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
fn save_plan_sync() -> &'static Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>> {
    SAVE_PLAN_SYNC.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
fn pause_after_save_plan_capture() {
    let hook = save_plan_sync().lock().ok().and_then(|mut value| value.take());
    if let Some((captured, release)) = hook {
        captured.wait();
        release.wait();
    }
}

#[tauri::command]
pub fn open_file_dialog() -> Result<Option<String>, String> {
    let file = FileDialog::new()
        .add_filter("Markdown", &["md", "markdown"])
        .pick_file();
    Ok(file.map(path_to_string))
}

#[tauri::command]
pub fn open_folder_dialog() -> Result<Option<String>, String> {
    Ok(FileDialog::new().pick_folder().map(path_to_string))
}

#[tauri::command]
pub fn open_asset_file_dialog() -> Result<Option<String>, String> {
    Ok(FileDialog::new()
        .add_filter("附件", &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "mp3", "wav", "ogg", "m4a", "flac", "mp4", "webm", "mov", "mkv", "pdf"])
        .pick_file()
        .map(path_to_string))
}

#[tauri::command]
pub fn save_markdown_file_dialog(
    default_file_name: Option<String>,
) -> Result<Option<String>, String> {
    let file_name = default_file_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("未命名.md");
    let file = FileDialog::new()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(file_name)
        .save_file();
    Ok(file.map(path_to_string))
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    fs::read_to_string(&path).map_err(|err| format!("Failed to read {}: {err}", path.display()))
}

#[tauri::command]
pub fn get_file_info(path: String) -> Result<FileInfo, String> {
    let path_buf = PathBuf::from(&path);
    let metadata = fs::metadata(&path_buf)
        .map_err(|err| format!("Failed to inspect {}: {err}", path_buf.display()))?;
    let line_count = scan_line_offsets(&path_buf)?.len();
    Ok(FileInfo {
        path,
        size_bytes: metadata.len(),
        line_count,
        is_large: metadata.len() >= LARGE_FILE_THRESHOLD_BYTES,
        encoding: "utf-8".to_string(),
    })
}

#[tauri::command]
pub fn open_large_file(app: AppHandle, path: String) -> Result<LargeFileSession, LargeFileError> {
    let snapshot_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| {
            LargeFileError::new(
                "snapshot-root-unavailable",
                format!("failed to resolve the application local data directory: {error}"),
            )
        })?
        .join("large-file-snapshots");
    open_large_file_at_root(path, snapshot_root)
}

fn open_large_file_at_root(
    path: String,
    snapshot_root: PathBuf,
) -> Result<LargeFileSession, LargeFileError> {
    let path_buf = PathBuf::from(&path);
    let session_id = new_session_id();
    let base = Arc::new(
        FileBaseSnapshot::create(
            &path_buf,
            &snapshot_root,
            &session_id,
        )
        .map_err(|error| snapshot_error(error, &path_buf))?,
    );
    let view = SegmentedTextView::new(Arc::clone(&base));
    let outline = scan_outline_view(&view, &session_id)?;
    let total_lines = view.line_count();
    let base_fingerprint = base.fingerprint().clone();
    let size_bytes = base.size_bytes();
    let session = SessionState {
        path: path_buf.clone(),
        snapshot_root,
        base,
        view,
        size_bytes,
        outline: outline.clone(),
        revision: 0,
        saved_revision: 0,
        pending_edit_count: 0,
        base_fingerprint: base_fingerprint.clone(),
        disk_fingerprint: base_fingerprint.clone(),
        persistence_generation: 0,
    };
    sessions()
        .lock()
        .map_err(|_| lock_error())?
        .insert(session_id.clone(), session);

    Ok(LargeFileSession {
        session_id,
        path,
        size_bytes,
        total_lines,
        outline,
        revision: 0,
        saved_revision: 0,
        pending_edit_count: 0,
        base_fingerprint: fingerprint_model(&base_fingerprint),
        disk_fingerprint: fingerprint_model(&base_fingerprint),
        coordinate_space: LargeCoordinateSpace::Utf16CodeUnits,
    })
}

#[tauri::command]
pub fn read_file_chunk(
    session_id: String,
    start_line: usize,
    line_count: usize,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<FileChunk, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let session = sessions()
        .lock()
        .map_err(|_| lock_error())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| session_not_found(&session_id))?;
    require_revision(&session_id, expected_revision, session.revision)?;
    let chunk = session
        .view
        .read_chunk(start_line, line_count)
        .map_err(|error| view_error(&session_id, error))?;
    Ok(FileChunk {
        session_id,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        total_lines: chunk.total_lines,
        text: chunk.text,
        revision: chunk.revision,
        coordinate_space,
    })
}

#[tauri::command]
pub fn apply_file_edits(
    session_id: String,
    edits: Vec<TextEdit>,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<DirtyState, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let mut guard = sessions().lock().map_err(|_| lock_error())?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| session_not_found(&session_id))?;
    require_revision(&session_id, expected_revision, session.revision)?;
    let view_edits = edits.iter().map(view_edit).collect::<Vec<_>>();
    let next_revision = session
        .view
        .apply_batch(expected_revision, &view_edits)
        .map_err(|error| view_error(&session_id, error))?;
    session.revision = next_revision;
    session.pending_edit_count = session
        .pending_edit_count
        .saturating_add(edits.len());
    Ok(dirty_state(session, coordinate_space))
}

#[tauri::command]
pub fn search_large_file(
    session_id: String,
    query: String,
    options: LargeFindOptions,
    start_line: Option<usize>,
    limit: Option<usize>,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<LargeFindResult, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let session = sessions()
        .lock()
        .map_err(|_| lock_error())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| session_not_found(&session_id))?;
    require_revision(&session_id, expected_revision, session.revision)?;
    if query.is_empty() {
        return Ok(empty_find_result(session.revision, coordinate_space));
    }

    let matcher = match LargeMatcher::new(&query, &options) {
        Ok(matcher) => matcher,
        Err(error) => {
            return Ok(LargeFindResult {
                matches: Vec::new(),
                total: 0,
                truncated: false,
                error,
                revision: session.revision,
                coordinate_space,
            })
        }
    };
    let limit = limit.unwrap_or(2000).max(1);
    let start_line = start_line.unwrap_or(0);
    let mut matches = Vec::new();
    let mut total = 0_usize;
    for line_index in start_line.min(session.view.line_count())..session.view.line_count() {
        let line = session
            .view
            .read_line_content(line_index)
            .map_err(|error| view_error(&session_id, error))?;
        for item in matcher.find_line(&line, line_index) {
            total += 1;
            if matches.len() < limit {
                matches.push(item);
            }
        }
    }

    Ok(LargeFindResult {
        truncated: total > matches.len(),
        matches,
        total,
        error: String::new(),
        revision: session.revision,
        coordinate_space,
    })
}

#[tauri::command]
pub fn replace_large_file_matches(
    session_id: String,
    query: String,
    replacement: String,
    options: LargeFindOptions,
    current_match: Option<LargeFindMatch>,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<DirtyState, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let mut guard = sessions().lock().map_err(|_| lock_error())?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| session_not_found(&session_id))?;
    require_revision(&session_id, expected_revision, session.revision)?;
    if query.is_empty() {
        return Ok(dirty_state(session, coordinate_space));
    }
    let matcher = LargeMatcher::new(&query, &options)
        .map_err(|error| LargeFileError::new("invalid-query", error).with_session(&session_id))?;
    let edits = if let Some(item) = current_match {
        vec![TextEdit {
            start_line: item.line,
            start_column: item.start_column,
            end_line: item.line,
            end_column: item.end_column,
            text: matcher.replace_text(&item.text, &replacement),
        }]
    } else {
        collect_large_replace_edits_from_view(&session.view, &matcher, &replacement)
            .map_err(|error| view_error(&session_id, error))?
    };
    if edits.is_empty() {
        return Ok(dirty_state(session, coordinate_space));
    }
    let view_edits = edits.iter().map(view_edit).collect::<Vec<_>>();
    let next_revision = session
        .view
        .apply_batch(expected_revision, &view_edits)
        .map_err(|error| view_error(&session_id, error))?;
    session.revision = next_revision;
    session.pending_edit_count = session
        .pending_edit_count
        .saturating_add(edits.len());
    Ok(dirty_state(session, coordinate_space))
}

#[tauri::command]
pub fn save_large_file(
    session_id: String,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<LargeSaveReceipt, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let plan = capture_save_plan(&session_id, expected_revision)?;
    if plan.revision == plan.saved_revision && plan.pending_edit_count == 0 {
        return Ok(save_receipt(&session_id, &plan, false, coordinate_space));
    }

    let temp_path = unique_large_temp_path(&plan.path, &session_id, plan.revision);
    if let Err(error) = write_view_temp(&plan.view, &temp_path) {
        return Err(cleanup_temp_error(
            LargeFileError::new("save-write-failed", error.message)
                .with_session(&session_id)
                .with_path(plan.path.to_string_lossy()),
            &temp_path,
            error.owned,
        ));
    }
    let output_fingerprint = match FileBaseSnapshot::fingerprint_path(&temp_path, 64 * 1024) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            return Err(cleanup_temp_error(
                snapshot_error(error, &temp_path).with_session(&session_id),
                &temp_path,
                true,
            ))
        }
    };
    let prepared = match prepare_rebase(
        &plan,
        &temp_path,
        &plan.path,
        &session_id,
        &output_fingerprint,
    ) {
        Ok(prepared) => prepared,
        Err(error) => return Err(cleanup_temp_error(error, &temp_path, true)),
    };
    let live_fingerprint = match FileBaseSnapshot::fingerprint_path(&plan.path, 64 * 1024) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            return Err(discard_prepared_and_temp(
                prepared,
                &temp_path,
                snapshot_error(error, &plan.path)
                    .with_session(&session_id)
                    .with_path(plan.path.to_string_lossy()),
            ))
        }
    };
    if live_fingerprint != plan.disk_fingerprint {
        return Err(discard_prepared_and_temp(
            prepared,
            &temp_path,
            LargeFileError::new(
                "external-conflict",
                "the source changed while the large-file snapshot was being saved",
            )
            .with_session(&session_id)
            .with_path(plan.path.to_string_lossy()),
        ));
    }

    let mut guard = match sessions().lock() {
        Ok(guard) => guard,
        Err(_) => return Err(discard_prepared_and_temp(prepared, &temp_path, lock_error())),
    };
    let current = match guard.get_mut(&session_id) {
        Some(current) => current,
        None => {
            let error = session_not_found(&session_id);
            drop(guard);
            return Err(discard_prepared_and_temp(prepared, &temp_path, error));
        }
    };
    if current.persistence_generation != plan.persistence_generation
        || current.revision != plan.revision
        || current.path != plan.path
        || current.disk_fingerprint != plan.disk_fingerprint
    {
        let error = LargeFileError::new(
            "save-plan-stale",
            "the session identity changed while the large-file save was prepared",
        )
        .with_session(&session_id)
        .with_revision(plan.revision, current.revision)
        .with_path(plan.path.to_string_lossy());
        drop(guard);
        return Err(discard_prepared_and_temp(prepared, &temp_path, error));
    }
    if current.disk_fingerprint != live_fingerprint {
        let error = LargeFileError::new(
            "external-conflict",
            "the source changed during the save boundary",
        )
        .with_session(&session_id)
        .with_path(plan.path.to_string_lossy());
        drop(guard);
        return Err(discard_prepared_and_temp(prepared, &temp_path, error));
    }
    if let Err(error) = replace_file(&plan.path, &temp_path) {
        let error = LargeFileError::new("save-replace-failed", error)
            .with_session(&session_id)
            .with_path(plan.path.to_string_lossy());
        drop(guard);
        return Err(retain_temp_after_replace_error(prepared, &temp_path, error));
    }
    let old_base = Arc::clone(&current.base);
    let old_base_directory = old_base.snapshot_dir().to_path_buf();
    let PreparedRebase {
        base: new_base,
        view: new_view,
        outline,
    } = prepared;
    current.base = new_base;
    current.view = new_view;
    current.base_fingerprint = output_fingerprint.clone();
    current.outline = outline;
    current.size_bytes = output_fingerprint.size_bytes;
    current.disk_fingerprint = output_fingerprint;
    current.saved_revision = plan.revision;
    current.pending_edit_count = 0;
    let mut receipt = save_receipt(&session_id, current, true, coordinate_space);
    drop(guard);
    drop(plan);
    if let Err(warning) = cleanup_base_arc(old_base) {
        receipt.cleanup_warning = Some(warning.clone());
        receipt.recovery_artifact = Some(old_base_directory.to_string_lossy().to_string());
    }
    Ok(receipt)
}

#[tauri::command]
pub fn save_large_file_as(
    session_id: String,
    target_path: String,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
    expected_target_fingerprint: Option<LargeFileFingerprint>,
) -> Result<LargeSaveReceipt, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let target = PathBuf::from(&target_path);
    let plan = capture_save_plan(&session_id, expected_revision)?;
    let captured_target = fingerprint_if_exists(&target)?;
    if captured_target != expected_target_fingerprint {
        return Err(LargeFileError::new(
            "target-conflict",
            "the Save As target changed or was not authorized at the save boundary",
        )
        .with_session(&session_id)
        .with_path(target.to_string_lossy()));
    }
    let temp_path = unique_large_temp_path(&target, &session_id, plan.revision);
    if let Err(error) = write_view_temp(&plan.view, &temp_path) {
        return Err(cleanup_temp_error(
            LargeFileError::new("save-write-failed", error.message)
                .with_session(&session_id)
                .with_path(target.to_string_lossy()),
            &temp_path,
            error.owned,
        ));
    }
    let output_fingerprint = match FileBaseSnapshot::fingerprint_path(&temp_path, 64 * 1024) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            return Err(cleanup_temp_error(
                snapshot_error(error, &temp_path).with_session(&session_id),
                &temp_path,
                true,
            ))
        }
    };
    let prepared = match prepare_rebase(
        &plan,
        &temp_path,
        &target,
        &session_id,
        &output_fingerprint,
    ) {
        Ok(prepared) => prepared,
        Err(error) => return Err(cleanup_temp_error(error, &temp_path, true)),
    };
    let prepared_target_fingerprint = match fingerprint_if_exists(&target) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            return Err(discard_prepared_and_temp(prepared, &temp_path, error));
        }
    };
    if prepared_target_fingerprint != expected_target_fingerprint {
        return Err(discard_prepared_and_temp(
            prepared,
            &temp_path,
            LargeFileError::new(
                "target-conflict",
                "the Save As target changed while the file was being prepared",
            )
            .with_session(&session_id)
            .with_path(target.to_string_lossy()),
        ));
    }
    let mut guard = match sessions().lock() {
        Ok(guard) => guard,
        Err(_) => return Err(discard_prepared_and_temp(prepared, &temp_path, lock_error())),
    };
    let current = match guard.get_mut(&session_id) {
        Some(current) => current,
        None => {
            let error = session_not_found(&session_id);
            drop(guard);
            return Err(discard_prepared_and_temp(prepared, &temp_path, error));
        }
    };
    if current.persistence_generation != plan.persistence_generation
        || current.revision != plan.revision
        || current.path != plan.path
        || current.disk_fingerprint != plan.disk_fingerprint
    {
        let error = LargeFileError::new(
            "save-plan-stale",
            "the session identity changed while Save As was prepared",
        )
        .with_session(&session_id)
        .with_revision(plan.revision, current.revision)
        .with_path(target.to_string_lossy());
        drop(guard);
        return Err(discard_prepared_and_temp(prepared, &temp_path, error));
    }
    let final_target_fingerprint = match fingerprint_if_exists(&target) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            drop(guard);
            return Err(discard_prepared_and_temp(prepared, &temp_path, error));
        }
    };
    if final_target_fingerprint != expected_target_fingerprint {
        let error = LargeFileError::new(
            "target-conflict",
            "the Save As target changed at the final save boundary",
        )
        .with_session(&session_id)
        .with_path(target.to_string_lossy());
        drop(guard);
        return Err(discard_prepared_and_temp(prepared, &temp_path, error));
    }
    if let Err(error) = replace_or_create_file(&target, &temp_path) {
        let error = LargeFileError::new("save-replace-failed", error)
            .with_session(&session_id)
            .with_path(target.to_string_lossy());
        drop(guard);
        return Err(retain_temp_after_replace_error(prepared, &temp_path, error));
    }
    let old_base = Arc::clone(&current.base);
    let old_base_directory = old_base.snapshot_dir().to_path_buf();
    let PreparedRebase {
        base: new_base,
        view: new_view,
        outline,
    } = prepared;
    current.base = new_base;
    current.view = new_view;
    current.base_fingerprint = output_fingerprint.clone();
    current.outline = outline;
    current.path = target.clone();
    current.size_bytes = output_fingerprint.size_bytes;
    current.disk_fingerprint = output_fingerprint;
    current.saved_revision = plan.revision;
    current.pending_edit_count = 0;
    let mut receipt = save_receipt(&session_id, current, true, coordinate_space);
    drop(guard);
    drop(plan);
    if let Err(warning) = cleanup_base_arc(old_base) {
        receipt.cleanup_warning = Some(warning.clone());
        receipt.recovery_artifact = Some(old_base_directory.to_string_lossy().to_string());
    }
    Ok(receipt)
}

#[tauri::command]
pub fn close_large_file(
    session_id: String,
    expected_revision: u64,
    disposition: LargeCloseDisposition,
) -> Result<LargeCloseReceipt, LargeFileError> {
    let state = {
        let mut guard = sessions().lock().map_err(|_| lock_error())?;
        let current = guard
            .get(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        require_revision(&session_id, expected_revision, current.revision)?;
        if disposition == LargeCloseDisposition::Saved
            && (current.revision != current.saved_revision || current.pending_edit_count != 0)
        {
            return Err(LargeFileError::new(
                "unsaved-changes",
                "close(saved) requires the requested revision to be saved",
            )
            .with_session(&session_id)
            .with_revision(current.saved_revision, current.revision));
        }
        guard
            .remove(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?
    };
    let SessionState { base, view, .. } = state;
    let recovery_artifact = base.snapshot_dir().to_string_lossy().to_string();
    drop(view);
    let (cleanup_completed, cleanup_warning) = match Arc::try_unwrap(base) {
        Ok(base) => match base.cleanup() {
            Ok(()) => (true, None),
            Err(error) => (false, Some(error.to_string())),
        },
        Err(_) => (
            false,
            Some("session snapshot remained referenced after close".to_string()),
        ),
    };
    Ok(LargeCloseReceipt {
        session_id,
        closed: true,
        cleanup_completed,
        recovery_artifact: (!cleanup_completed).then_some(recovery_artifact),
        cleanup_warning,
    })
}

#[cfg(test)]
fn default_large_snapshot_root() -> PathBuf {
    std::env::temp_dir().join("lightmark-large-sessions")
}

fn lock_error() -> LargeFileError {
    LargeFileError::new("session-lock-poisoned", "large-file session lock was poisoned")
}

fn session_not_found(session_id: &str) -> LargeFileError {
    LargeFileError::new("session-not-found", "large-file session was not found")
        .with_session(session_id)
}

fn stale_revision(session_id: &str, expected: u64, actual: u64) -> LargeFileError {
    LargeFileError::new(
        "stale-revision",
        "the large-file view changed since the command was prepared",
    )
    .with_session(session_id)
    .with_revision(expected, actual)
}

fn require_revision(
    session_id: &str,
    expected: u64,
    actual: u64,
) -> Result<(), LargeFileError> {
    if expected == actual {
        Ok(())
    } else {
        Err(stale_revision(session_id, expected, actual))
    }
}

fn require_coordinate_space(space: LargeCoordinateSpace) -> Result<(), LargeFileError> {
    match space {
        LargeCoordinateSpace::Utf16CodeUnits => Ok(()),
    }
}

fn view_error(session_id: &str, error: ViewError) -> LargeFileError {
    match error {
        ViewError::StaleRevision { expected, actual } => {
            stale_revision(session_id, expected, actual)
        }
        ViewError::InvalidUtf16Boundary { .. } => LargeFileError::new(
            "invalid-utf16-boundary",
            error.to_string(),
        )
        .with_session(session_id),
        ViewError::OverlappingEdits => {
            LargeFileError::new("overlapping-edits", error.to_string()).with_session(session_id)
        }
        _ => LargeFileError::new("invalid-edit", error.to_string()).with_session(session_id),
    }
}

fn snapshot_error(error: SnapshotError, path: &Path) -> LargeFileError {
    let message = error.to_string();
    let code = match &error {
        SnapshotError::InvalidUtf8 { .. } => "invalid-utf8",
        SnapshotError::SourceChanged { .. } => "external-conflict",
        SnapshotError::InvalidOwnerId | SnapshotError::InvalidChunkSize => "snapshot-config",
        SnapshotError::InvalidSpan { .. } => "snapshot-span",
        SnapshotError::Cleanup { .. } | SnapshotError::CleanupAfterFailure { .. } => {
            "snapshot-cleanup-failed"
        }
        SnapshotError::Io { .. } => "snapshot-io-failed",
    };
    LargeFileError::new(code, message).with_path(path.to_string_lossy())
}

fn fingerprint_model(fingerprint: &SourceFingerprint) -> LargeFileFingerprint {
    LargeFileFingerprint {
        size_bytes: fingerprint.size_bytes,
        modified_millis: fingerprint.modified.map(system_time_millis),
        sha256: fingerprint.sha256_hex(),
    }
}

fn dirty_state(session: &SessionState, coordinate_space: LargeCoordinateSpace) -> DirtyState {
    DirtyState {
        is_dirty: session.revision != session.saved_revision || session.pending_edit_count != 0,
        pending_edit_count: session.pending_edit_count,
        revision: session.revision,
        saved_revision: session.saved_revision,
        coordinate_space,
    }
}

fn empty_find_result(revision: u64, coordinate_space: LargeCoordinateSpace) -> LargeFindResult {
    LargeFindResult {
        matches: Vec::new(),
        total: 0,
        truncated: false,
        error: String::new(),
        revision,
        coordinate_space,
    }
}

fn save_receipt(
    session_id: &str,
    session: &SessionState,
    saved: bool,
    coordinate_space: LargeCoordinateSpace,
) -> LargeSaveReceipt {
    LargeSaveReceipt {
        session_id: session_id.to_string(),
        requested_revision: session.revision,
        saved_revision: session.saved_revision,
        current_revision: session.revision,
        saved,
        is_dirty: session.revision != session.saved_revision || session.pending_edit_count != 0,
        pending_edit_count: session.pending_edit_count,
        path: path_to_string(session.path.clone()),
        base_fingerprint: fingerprint_model(&session.base_fingerprint),
        disk_fingerprint: fingerprint_model(&session.disk_fingerprint),
        coordinate_space,
        recovery_artifact: None,
        cleanup_warning: None,
    }
}

fn capture_save_plan(
    session_id: &str,
    expected_revision: u64,
) -> Result<SessionState, LargeFileError> {
    let mut guard = sessions().lock().map_err(|_| lock_error())?;
    let session = guard
        .get_mut(session_id)
        .ok_or_else(|| session_not_found(session_id))?;
    require_revision(session_id, expected_revision, session.revision)?;
    session.persistence_generation = session.persistence_generation.saturating_add(1);
    let plan = session.clone();
    drop(guard);
    #[cfg(test)]
    pause_after_save_plan_capture();
    Ok(plan)
}

struct PreparedRebase {
    base: Arc<FileBaseSnapshot>,
    view: SegmentedTextView<FileBaseSnapshot>,
    outline: Vec<LargeOutlineItem>,
}

fn prepare_rebase(
    plan: &SessionState,
    temp_path: &Path,
    logical_source_path: &Path,
    session_id: &str,
    expected_fingerprint: &SourceFingerprint,
) -> Result<PreparedRebase, LargeFileError> {
    let owner_id = format!(
        "{session_id}-rebase-{}-{}",
        plan.revision,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    let base = Arc::new(
        FileBaseSnapshot::create_from_stable_owned_file(
            temp_path,
            logical_source_path,
            &plan.snapshot_root,
            &owner_id,
        )
        .map_err(|error| snapshot_error(error, temp_path))?,
    );
    if base.fingerprint() != expected_fingerprint {
        let error = LargeFileError::new(
            "rebase-fingerprint-mismatch",
            "the prepared snapshot did not match the rendered save bytes",
        )
        .with_session(session_id)
        .with_path(logical_source_path.to_string_lossy());
        let view = SegmentedTextView::new(Arc::clone(&base));
        let prepared = PreparedRebase {
            base,
            view,
            outline: Vec::new(),
        };
        return Err(discard_prepared_error(prepared, error));
    }
    let view = SegmentedTextView::new(Arc::clone(&base)).with_revision(plan.revision);
    let outline = match scan_outline_view(&view, session_id) {
        Ok(outline) => outline,
        Err(error) => {
            let prepared = PreparedRebase {
                base,
                view,
                outline: Vec::new(),
            };
            return Err(discard_prepared_error(prepared, error));
        }
    };
    Ok(PreparedRebase { base, view, outline })
}

fn discard_prepared(prepared: PreparedRebase) -> Result<(), String> {
    let PreparedRebase { base, view, .. } = prepared;
    let directory = base.snapshot_dir().to_path_buf();
    drop(view);
    match Arc::try_unwrap(base) {
        Ok(base) => base.cleanup().map_err(|error| error.to_string()),
        Err(_) => Err(format!(
            "prepared snapshot remains in use; recovery directory was retained at {}",
            directory.display()
        )),
    }
}

fn discard_prepared_error(
    prepared: PreparedRebase,
    mut error: LargeFileError,
) -> LargeFileError {
    let recovery_directory = prepared.base.snapshot_dir().to_path_buf();
    if let Err(warning) = discard_prepared(prepared) {
        error = error
            .with_recovery_artifact(recovery_directory.to_string_lossy())
            .with_cleanup_warning(warning);
    }
    error
}

fn discard_prepared_and_temp(
    prepared: PreparedRebase,
    temp_path: &Path,
    mut error: LargeFileError,
) -> LargeFileError {
    let recovery_directory = prepared.base.snapshot_dir().to_path_buf();
    if let Err(warning) = discard_prepared(prepared) {
        error = error
            .with_recovery_artifact(recovery_directory.to_string_lossy())
            .with_cleanup_warning(warning);
    }
    if let Err(warning) = cleanup_owned_temp(temp_path) {
        error = error
            .with_recovery_artifact(temp_path.to_string_lossy())
            .with_cleanup_warning(warning);
    }
    error
}

fn cleanup_owned_temp(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|error| format!("failed to clean {}: {error}", path.display()))
}

fn cleanup_temp_error(
    mut error: LargeFileError,
    temp_path: &Path,
    owned: bool,
) -> LargeFileError {
    if !owned {
        return error;
    }
    if let Err(warning) = cleanup_owned_temp(temp_path) {
        error = error
            .with_recovery_artifact(temp_path.to_string_lossy())
            .with_cleanup_warning(warning);
    }
    error
}

fn cleanup_base_arc(base: Arc<FileBaseSnapshot>) -> Result<(), String> {
    let directory = base.snapshot_dir().to_path_buf();
    match Arc::try_unwrap(base) {
        Ok(base) => base.cleanup().map_err(|error| error.to_string()),
        Err(_) => Err(format!(
            "previous session base remains referenced at {}",
            directory.display()
        )),
    }
}

fn retain_temp_after_replace_error(
    prepared: PreparedRebase,
    temp_path: &Path,
    mut error: LargeFileError,
) -> LargeFileError {
    let recovery_directory = prepared.base.snapshot_dir().to_path_buf();
    if let Err(warning) = discard_prepared(prepared) {
        error = error
            .with_recovery_artifact(recovery_directory.to_string_lossy())
            .with_cleanup_warning(warning);
    }
    if temp_path.exists() {
        error = error.with_recovery_artifact(temp_path.to_string_lossy());
    }
    error
}

fn view_edit(edit: &TextEdit) -> ViewEdit {
    ViewEdit::new(
        edit.start_line,
        edit.start_column,
        edit.end_line,
        edit.end_column,
        edit.text.clone(),
    )
}

fn unique_large_temp_path(path: &Path, session_id: &str, revision: u64) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("document");
    let safe_session = session_id
        .chars()
        .map(|value| if value.is_ascii_alphanumeric() { value } else { '-' })
        .collect::<String>();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    parent.join(format!(
        ".{name}.lightmark-{safe_session}-{revision}-{stamp}.tmp"
    ))
}

struct TempWriteError {
    message: String,
    owned: bool,
}

fn write_view_temp(
    view: &SegmentedTextView<FileBaseSnapshot>,
    path: &Path,
) -> Result<(), TempWriteError> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| TempWriteError {
            message: format!("failed to create {}: {error}", path.display()),
            owned: false,
        })?;
    let mut writer = BufWriter::new(file);
    view.write_to(&mut writer)
        .map_err(|error| TempWriteError {
            message: format!("failed to stream {}: {error}", path.display()),
            owned: true,
        })?;
    writer
        .flush()
        .map_err(|error| TempWriteError {
            message: format!("failed to flush {}: {error}", path.display()),
            owned: true,
        })
}

fn replace_or_create_file(target: &Path, replacement: &Path) -> Result<(), String> {
    if target.exists() {
        replace_file(target, replacement)
    } else {
        fs::rename(replacement, target).map_err(|error| {
            format!(
                "Failed to move {} to {}: {error}",
                replacement.display(),
                target.display()
            )
        })
    }
}

fn fingerprint_if_exists(
    path: &Path,
) -> Result<Option<LargeFileFingerprint>, LargeFileError> {
    if !path.exists() {
        return Ok(None);
    }
    let fingerprint = FileBaseSnapshot::fingerprint_path(path, 64 * 1024)
        .map_err(|error| snapshot_error(error, path))?;
    Ok(Some(fingerprint_model(&fingerprint)))
}

fn scan_outline_view(
    view: &SegmentedTextView<FileBaseSnapshot>,
    session_id: &str,
) -> Result<Vec<LargeOutlineItem>, LargeFileError> {
    let mut outline = Vec::new();
    for line_index in 0..view.line_count() {
        let line = view
            .read_line_content(line_index)
            .map_err(|error| view_error(session_id, error))?;
        if let Some((level, text)) = parse_heading(&line) {
            outline.push(LargeOutlineItem {
                id: format!("large-heading-{line_index}"),
                text,
                level,
                line: line_index,
            });
        }
    }
    Ok(outline)
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    write_text_file_safely(&path, &content)
}

fn write_text_file_safely(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create folder {}: {err}", parent.display()))?;
    }
    let temp_path = path.with_extension(format!(
        "{}.lightmark-tmp",
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("md")
    ));
    fs::write(&temp_path, content).map_err(|err| {
        format!(
            "Failed to write temporary file {}: {err}",
            temp_path.display()
        )
    })?;
    if path.exists() {
        replace_file(path, &temp_path)
    } else {
        fs::rename(&temp_path, path).map_err(|err| {
            format!(
                "Failed to move {} to {}: {err}",
                temp_path.display(),
                path.display()
            )
        })
    }
}

#[tauri::command]
pub fn save_asset_file(
    markdown_path: String,
    file_name: String,
    bytes: Vec<u8>,
    asset_folder: Option<String>,
) -> Result<String, String> {
    let markdown_path = PathBuf::from(markdown_path);
    let document_dir = markdown_path
        .parent()
        .ok_or_else(|| "当前 Markdown 文件没有可用的父目录。".to_string())?;
    let assets_dir = resolve_asset_folder(document_dir, asset_folder.as_deref())?;
    fs::create_dir_all(&assets_dir)
        .map_err(|err| format!("Failed to create folder {}: {err}", assets_dir.display()))?;

    let safe_name = sanitize_asset_file_name(&file_name);
    let target = unique_asset_path(&assets_dir, &safe_name);
    fs::write(&target, bytes)
        .map_err(|err| format!("Failed to write {}: {err}", target.display()))?;
    target
        .strip_prefix(document_dir)
        .map(|path| path_to_string(path.to_path_buf()))
        .map_err(|err| {
            format!(
                "Failed to build relative path for {}: {err}",
                target.display()
            )
        })
}

#[tauri::command]
pub fn inspect_document_assets(
    markdown_path: String,
    asset_folder: Option<String>,
    sources: Vec<String>,
) -> Result<AssetInspection, String> {
    let markdown_path = PathBuf::from(markdown_path);
    let document_dir = markdown_path
        .parent()
        .ok_or_else(|| "当前 Markdown 文件没有可用的父目录。".to_string())?;
    let assets_dir = resolve_asset_folder(document_dir, asset_folder.as_deref())?;
    let references = sources
        .into_iter()
        .map(|source| {
            let decoded = percent_decode_path(source.split(['?', '#']).next().unwrap_or(""));
            let path = {
                let candidate = PathBuf::from(&decoded);
                if candidate.is_absolute() { candidate } else { document_dir.join(candidate) }
            };
            asset_file_info(source, path)
        })
        .collect::<Vec<_>>();
    let mut folder_files = Vec::new();
    if assets_dir.is_dir() {
        collect_asset_files(&assets_dir, &mut folder_files)?;
    }
    folder_files.sort_by(|left, right| left.path.to_lowercase().cmp(&right.path.to_lowercase()));
    Ok(AssetInspection {
        asset_folder: path_to_string(assets_dir),
        references,
        folder_files,
    })
}

#[tauri::command]
pub fn watch_asset_folder(app: AppHandle, markdown_path: String, asset_folder: Option<String>) -> Result<(), String> {
    let markdown_path = PathBuf::from(markdown_path);
    let document_dir = markdown_path.parent().ok_or_else(|| "当前 Markdown 文件没有可用的父目录。".to_string())?;
    let folder = resolve_asset_folder(document_dir, asset_folder.as_deref())?;
    let watch_target = if folder.is_dir() { folder } else { document_dir.to_path_buf() };
    let app_handle = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return; };
            let paths = event.paths.into_iter().filter(|path| is_asset_file(path)).map(path_to_string).collect::<Vec<_>>();
            if !paths.is_empty() {
                let _ = app_handle.emit(ASSET_WATCH_EVENT, WorkspaceWatchEvent { paths });
            }
        },
        Config::default(),
    ).map_err(|err| format!("Failed to create asset watcher: {err}"))?;
    watcher.watch(&watch_target, RecursiveMode::Recursive)
        .map_err(|err| format!("Failed to watch asset folder {}: {err}", watch_target.display()))?;
    let mut guard = asset_watcher().lock().map_err(|_| "Asset watcher lock was poisoned.".to_string())?;
    *guard = Some(FileWatcherEntry { _watcher: watcher });
    Ok(())
}

#[tauri::command]
pub fn unwatch_asset_folder() -> Result<(), String> {
    let mut guard = asset_watcher().lock().map_err(|_| "Asset watcher lock was poisoned.".to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn image_paths_to_markdown(
    markdown_path: String,
    paths: Vec<String>,
    use_relative_path: Option<bool>,
    ensure_dot_slash: Option<bool>,
    escape_path: Option<bool>,
) -> Result<String, String> {
    let markdown_path = PathBuf::from(markdown_path);
    let document_dir = markdown_path
        .parent()
        .ok_or_else(|| "当前 Markdown 文件没有可用的父目录。".to_string())?;
    let use_relative_path = use_relative_path.unwrap_or(true);
    let ensure_dot_slash = ensure_dot_slash.unwrap_or(false);
    let escape_path = escape_path.unwrap_or(true);

    let snippets = paths
        .into_iter()
        .filter_map(|path| {
            let image_path = PathBuf::from(path);
            if !is_image_file(&image_path) {
                return None;
            }
            let reference = if use_relative_path {
                normalize_relative_reference(
                    &relative_path(document_dir, &image_path),
                    ensure_dot_slash,
                )
            } else {
                path_to_string(image_path.clone())
            };
            let alt = image_path
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("image");
            let source = if escape_path {
                markdown_path_url(&reference)
            } else {
                reference.replace('\\', "/")
            };
            Some(format!("![{}]({})", alt, source))
        })
        .collect::<Vec<_>>();

    if snippets.is_empty() {
        return Err("没有可用的图片文件。".to_string());
    }

    Ok(snippets.join("\n\n"))
}

#[tauri::command]
pub fn asset_path_to_reference(
    markdown_path: String,
    path: String,
    use_relative_path: Option<bool>,
    ensure_dot_slash: Option<bool>,
    escape_path: Option<bool>,
) -> Result<String, String> {
    let markdown_path = PathBuf::from(markdown_path);
    let document_dir = markdown_path.parent().ok_or_else(|| "当前 Markdown 文件没有可用的父目录。".to_string())?;
    let asset_path = PathBuf::from(path);
    let reference = if use_relative_path.unwrap_or(true) {
        normalize_relative_reference(&relative_path(document_dir, &asset_path), ensure_dot_slash.unwrap_or(false))
    } else {
        path_to_string(asset_path)
    };
    Ok(if escape_path.unwrap_or(true) { markdown_path_url(&reference) } else { reference })
}

#[tauri::command]
pub fn list_markdown_files(folder: String) -> Result<Vec<FileNode>, String> {
    let root = PathBuf::from(folder);
    if !root.is_dir() {
        return Err(format!("Folder does not exist: {}", root.display()));
    }
    read_children(&root)
}

#[tauri::command]
pub fn watch_markdown_file(app: AppHandle, path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_file() {
        return Err(format!("File does not exist: {}", path_buf.display()));
    }
    if !is_markdown_file(&path_buf) {
        return Err(format!("Not a Markdown file: {}", path_buf.display()));
    }

    let key = watch_path_key(&path_buf);
    let mut guard = file_watchers()
        .lock()
        .map_err(|_| "File watcher lock was poisoned.".to_string())?;
    if guard.contains_key(&key) {
        return Ok(());
    }

    let event_path = path_to_string(path_buf.clone());
    let app_handle = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<notify::Event>| {
            if event.is_ok() {
                let _ = app_handle.emit(
                    FILE_WATCH_EVENT,
                    FileWatchEvent {
                        path: event_path.clone(),
                    },
                );
            }
        },
        Config::default(),
    )
    .map_err(|err| {
        format!(
            "Failed to create file watcher for {}: {err}",
            path_buf.display()
        )
    })?;
    watcher
        .watch(&path_buf, RecursiveMode::NonRecursive)
        .map_err(|err| format!("Failed to watch {}: {err}", path_buf.display()))?;
    guard.insert(key, FileWatcherEntry { _watcher: watcher });
    Ok(())
}

#[tauri::command]
pub fn unwatch_markdown_file(path: String) -> Result<(), String> {
    let key = watch_path_key(Path::new(&path));
    let mut guard = file_watchers()
        .lock()
        .map_err(|_| "File watcher lock was poisoned.".to_string())?;
    guard.remove(&key);
    Ok(())
}

#[tauri::command]
pub fn unwatch_all_markdown_files() -> Result<(), String> {
    file_watchers()
        .lock()
        .map_err(|_| "File watcher lock was poisoned.".to_string())?
        .clear();
    Ok(())
}

#[tauri::command]
pub fn watch_markdown_workspace(app: AppHandle, path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_dir() {
        return Err(format!("Workspace folder does not exist: {}", path_buf.display()));
    }

    let app_handle = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else {
                return;
            };
            let paths = event
                .paths
                .into_iter()
                .filter(|event_path| is_markdown_file(event_path))
                .map(path_to_string)
                .collect::<Vec<_>>();
            if paths.is_empty() {
                return;
            }
            super::workspace_index::queue_workspace_paths(paths.clone());
            let _ = app_handle.emit(WORKSPACE_WATCH_EVENT, WorkspaceWatchEvent { paths });
        },
        Config::default(),
    )
    .map_err(|err| format!("Failed to create workspace watcher for {}: {err}", path_buf.display()))?;
    watcher
        .watch(&path_buf, RecursiveMode::Recursive)
        .map_err(|err| format!("Failed to watch workspace {}: {err}", path_buf.display()))?;

    let mut guard = workspace_watcher()
        .lock()
        .map_err(|_| "Workspace watcher lock was poisoned.".to_string())?;
    *guard = Some(FileWatcherEntry { _watcher: watcher });
    Ok(())
}

#[tauri::command]
pub fn unwatch_markdown_workspace() -> Result<(), String> {
    let mut guard = workspace_watcher()
        .lock()
        .map_err(|_| "Workspace watcher lock was poisoned.".to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn find_similar_markdown_files(
    original_path: String,
    size: Option<u64>,
    mtime: Option<u64>,
) -> Result<Vec<SimilarFileCandidate>, String> {
    let original = PathBuf::from(original_path);
    let Some(size) = size else {
        return Ok(Vec::new());
    };
    similar_markdown_files(&original, size, mtime)
}

#[tauri::command]
pub fn create_markdown_file(folder: String, name: String) -> Result<String, String> {
    let folder = PathBuf::from(folder);
    if !folder.is_dir() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    let safe_name = if name.trim().is_empty() {
        "Untitled.md".to_string()
    } else if name.ends_with(".md") || name.ends_with(".markdown") {
        name
    } else {
        format!("{name}.md")
    };

    let path = folder.join(safe_name);
    if path.exists() {
        return Err(format!("File already exists: {}", path.display()));
    }
    fs::write(&path, "").map_err(|err| format!("Failed to create {}: {err}", path.display()))?;
    Ok(path_to_string(path))
}

fn sanitize_asset_file_name(file_name: &str) -> String {
    let source = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image.png");
    let mut result = String::new();
    for ch in source.chars() {
        if ch.is_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            result.push(ch);
        } else {
            result.push('-');
        }
    }
    let trimmed = result.trim_matches('-');
    if trimmed.is_empty() {
        "image.png".to_string()
    } else {
        trimmed.to_string()
    }
}

fn unique_asset_path(folder: &Path, file_name: &str) -> PathBuf {
    let path = folder.join(file_name);
    if !path.exists() {
        return path;
    }

    let source = Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    let extension = source.extension().and_then(|value| value.to_str());

    for index in 1.. {
        let candidate_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{stem}-{index}.{ext}"),
            _ => format!("{stem}-{index}"),
        };
        let candidate = folder.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("unbounded asset filename search should always return");
}

fn resolve_asset_folder(document_dir: &Path, value: Option<&str>) -> Result<PathBuf, String> {
    let folder = value.map(str::trim).filter(|value| !value.is_empty()).unwrap_or("assets");
    let relative = Path::new(folder);
    if relative.is_absolute() || relative.components().any(|component| matches!(component, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err("附件目录必须是文档目录内的相对路径，不能包含“..”。".to_string());
    }
    Ok(document_dir.join(relative))
}

fn asset_file_info(source: String, path: PathBuf) -> AssetFileInfo {
    let metadata = fs::metadata(&path).ok();
    AssetFileInfo {
        source,
        name: path.file_name().and_then(|value| value.to_str()).unwrap_or("").to_string(),
        kind: asset_kind(&path).to_string(),
        path: path_to_string(path),
        exists: metadata.as_ref().map(|value| value.is_file()).unwrap_or(false),
        size: metadata.map(|value| value.len()),
    }
}

fn collect_asset_files(folder: &Path, result: &mut Vec<AssetFileInfo>) -> Result<(), String> {
    for entry in fs::read_dir(folder).map_err(|err| format!("Failed to read asset folder {}: {err}", folder.display()))? {
        let entry = entry.map_err(|err| format!("Failed to inspect asset entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_asset_files(&path, result)?;
        } else if is_asset_file(&path) {
            result.push(asset_file_info(String::new(), path));
        }
    }
    Ok(())
}

fn is_asset_file(path: &Path) -> bool {
    matches!(asset_kind(path), "image" | "audio" | "video" | "pdf")
}

fn asset_kind(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif" => "image",
        "mp3" | "wav" | "ogg" | "m4a" | "flac" => "audio",
        "mp4" | "webm" | "mov" | "mkv" => "video",
        "pdf" => "pdf",
        _ => "other",
    }
}

fn percent_decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
                result.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        result.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&result).to_string()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
            )
        })
        .unwrap_or(false)
}

fn relative_path(from_dir: &Path, to_path: &Path) -> String {
    let from_components = from_dir.components().collect::<Vec<_>>();
    let to_components = to_path.components().collect::<Vec<_>>();
    let mut common = 0_usize;
    while common < from_components.len()
        && common < to_components.len()
        && from_components[common] == to_components[common]
    {
        common += 1;
    }

    if common == 0 {
        return path_to_string(to_path.to_path_buf());
    }

    let mut parts = Vec::new();
    for _ in common..from_components.len() {
        parts.push("..".to_string());
    }
    for component in &to_components[common..] {
        parts.push(component.as_os_str().to_string_lossy().to_string());
    }
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

fn normalize_relative_reference(reference: &str, ensure_dot_slash: bool) -> String {
    let normalized = reference.replace('\\', "/");
    if !ensure_dot_slash {
        return normalized;
    }
    if normalized == "."
        || normalized.starts_with("./")
        || normalized.starts_with("../")
        || normalized.starts_with('/')
        || normalized.contains(":/")
    {
        normalized
    } else {
        format!("./{normalized}")
    }
}

fn markdown_path_url(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .map(percent_encode_markdown_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_markdown_segment(segment: &str) -> String {
    let mut encoded = String::new();
    for byte in segment.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~' | ':') {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn read_children(folder: &Path) -> Result<Vec<FileNode>, String> {
    let entries = fs::read_dir(folder)
        .map_err(|err| format!("Failed to read folder {}: {err}", folder.display()))?;

    let mut nodes = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to inspect folder entry: {err}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            let children = read_children(&path)?;
            if !children.is_empty() {
                nodes.push(FileNode {
                    name,
                    path: path_to_string(path),
                    is_dir: true,
                    children,
                });
            }
        } else if is_markdown_file(&path) {
            nodes.push(FileNode {
                name,
                path: path_to_string(path),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }

    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(nodes)
}

fn similar_markdown_files(
    original_path: &Path,
    size: u64,
    mtime: Option<u64>,
) -> Result<Vec<SimilarFileCandidate>, String> {
    let Some(parent) = original_path.parent() else {
        return Ok(Vec::new());
    };
    if !parent.is_dir() {
        return Ok(Vec::new());
    }

    let mut candidates = Vec::new();
    collect_similar_markdown_files(parent, original_path, size, mtime, &mut candidates)?;
    for entry in fs::read_dir(parent)
        .map_err(|err| format!("Failed to read folder {}: {err}", parent.display()))?
    {
        let entry = entry.map_err(|err| format!("Failed to inspect folder entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_similar_markdown_files(&path, original_path, size, mtime, &mut candidates)?;
        }
    }

    candidates.sort_by(|left, right| {
        candidate_time_distance(left.mtime, mtime)
            .cmp(&candidate_time_distance(right.mtime, mtime))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    candidates.truncate(8);
    Ok(candidates)
}

fn watch_path_key(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
        .to_ascii_lowercase()
}

fn collect_similar_markdown_files(
    folder: &Path,
    original_path: &Path,
    size: u64,
    mtime: Option<u64>,
    candidates: &mut Vec<SimilarFileCandidate>,
) -> Result<(), String> {
    for entry in fs::read_dir(folder)
        .map_err(|err| format!("Failed to read folder {}: {err}", folder.display()))?
    {
        let entry = entry.map_err(|err| format!("Failed to inspect folder entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() || !is_markdown_file(&path) || same_path(&path, original_path) {
            continue;
        }
        let metadata = fs::metadata(&path)
            .map_err(|err| format!("Failed to inspect {}: {err}", path.display()))?;
        if metadata.len() != size {
            continue;
        }
        let candidate_mtime = metadata.modified().ok().map(system_time_millis);
        if !mtime_is_close(candidate_mtime, mtime) {
            continue;
        }
        candidates.push(SimilarFileCandidate {
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string(),
            path: path_to_string(path),
            mtime: candidate_mtime,
            size: metadata.len(),
        });
    }
    Ok(())
}

fn mtime_is_close(candidate: Option<u64>, baseline: Option<u64>) -> bool {
    match (candidate, baseline) {
        (Some(left), Some(right)) => left.abs_diff(right) <= 5 * 60 * 1000,
        _ => true,
    }
}

fn candidate_time_distance(candidate: Option<u64>, baseline: Option<u64>) -> u64 {
    match (candidate, baseline) {
        (Some(left), Some(right)) => left.abs_diff(right),
        _ => u64::MAX,
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().replace('\\', "/").to_lowercase()
        == right.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn system_time_millis(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn scan_line_offsets(path: &Path) -> Result<Vec<u64>, String> {
    let file =
        File::open(path).map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut offsets = vec![0_u64];
    let mut position = 0_u64;
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|err| format!("Failed to scan {}: {err}", path.display()))?;
        if read == 0 {
            break;
        }
        position += read as u64;
        offsets.push(position);
    }
    let size = fs::metadata(path)
        .map_err(|err| format!("Failed to inspect {}: {err}", path.display()))?
        .len();
    if offsets.last().copied() == Some(size) {
        offsets.pop();
    }
    Ok(offsets)
}

enum LargeMatcher {
    Literal {
        query: String,
        normalized_query: String,
        case_sensitive: bool,
        whole_word: bool,
    },
    Regex {
        regex: regex::Regex,
        whole_word: bool,
    },
}

impl LargeMatcher {
    fn new(query: &str, options: &LargeFindOptions) -> Result<Self, String> {
        if options.regex {
            let regex = RegexBuilder::new(query)
                .case_insensitive(!options.case_sensitive)
                .build()
                .map_err(|err| err.to_string())?;
            return Ok(Self::Regex {
                regex,
                whole_word: options.whole_word,
            });
        }

        Ok(Self::Literal {
            query: query.to_string(),
            normalized_query: if options.case_sensitive {
                query.to_string()
            } else {
                query.to_lowercase()
            },
            case_sensitive: options.case_sensitive,
            whole_word: options.whole_word,
        })
    }

    fn find_line(&self, line: &str, line_index: usize) -> Vec<LargeFindMatch> {
        match self {
            Self::Literal {
                query,
                normalized_query,
                case_sensitive,
                whole_word,
            } => find_literal_line(
                line,
                line_index,
                query,
                normalized_query,
                *case_sensitive,
                *whole_word,
            ),
            Self::Regex { regex, whole_word } => regex
                .find_iter(line)
                .filter(|item| item.start() < item.end())
                .filter(|item| !*whole_word || is_whole_word_bytes(line, item.start(), item.end()))
                .map(|item| large_find_match(line, line_index, item.start(), item.end()))
                .collect(),
        }
    }

    fn replace_text(&self, value: &str, replacement: &str) -> String {
        match self {
            Self::Regex { regex, .. } => regex.replace(value, replacement).to_string(),
            _ => replacement.to_string(),
        }
    }
}

fn find_literal_line(
    line: &str,
    line_index: usize,
    query: &str,
    normalized_query: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Vec<LargeFindMatch> {
    let source = if case_sensitive {
        line.to_string()
    } else {
        line.to_lowercase()
    };
    let mut matches = Vec::new();
    let mut from = 0_usize;
    while from <= source.len() {
        let Some(relative) = source[from..].find(normalized_query) else {
            break;
        };
        let start = from + relative;
        let end = start + normalized_query.len();
        if !whole_word || is_whole_word_bytes(line, start, end) {
            matches.push(large_find_match(line, line_index, start, end));
        }
        from = end.max(start + query.len().max(1));
    }
    matches
}

fn collect_large_replace_edits_from_view(
    view: &SegmentedTextView<FileBaseSnapshot>,
    matcher: &LargeMatcher,
    replacement: &str,
) -> Result<Vec<TextEdit>, ViewError> {
    let mut edits = Vec::new();
    for line_index in 0..view.line_count() {
        let line = view
            .read_line_content(line_index)
            ?;
        let matches = matcher.find_line(&line, line_index);
        if !matches.is_empty() {
            let next = replace_line_matches(&line, &matches, matcher, replacement);
            edits.push(TextEdit {
                start_line: line_index,
                start_column: 0,
                end_line: line_index,
                end_column: line.encode_utf16().count(),
                text: next,
            });
        }
    }
    Ok(edits)
}

fn replace_line_matches(
    line: &str,
    matches: &[LargeFindMatch],
    matcher: &LargeMatcher,
    replacement: &str,
) -> String {
    let mut next = String::new();
    let mut cursor = 0_usize;
    for item in matches {
        let Some(start_byte) = utf16_column_to_byte(line, item.start_column) else {
            continue;
        };
        let Some(end_byte) = utf16_column_to_byte(line, item.end_column) else {
            continue;
        };
        if start_byte < cursor || end_byte < start_byte {
            continue;
        }
        next.push_str(&line[cursor..start_byte]);
        next.push_str(&matcher.replace_text(&item.text, replacement));
        cursor = end_byte;
    }
    next.push_str(&line[cursor..]);
    next
}

fn large_find_match(line: &str, line_index: usize, start: usize, end: usize) -> LargeFindMatch {
    LargeFindMatch {
        line: line_index,
        start_column: byte_to_utf16_column(line, start),
        end_column: byte_to_utf16_column(line, end),
        text: line[start..end].to_string(),
        preview: line.chars().take(180).collect(),
    }
}

fn byte_to_utf16_column(value: &str, byte_index: usize) -> usize {
    value[..byte_index].encode_utf16().count()
}

fn utf16_column_to_byte(value: &str, column: usize) -> Option<usize> {
    if column == 0 {
        return Some(0);
    }
    let mut units = 0_usize;
    for (byte, character) in value.char_indices() {
        if units == column {
            return Some(byte);
        }
        units = units.saturating_add(character.len_utf16());
        if units > column {
            return None;
        }
        if units == column {
            return Some(byte + character.len_utf8());
        }
    }
    (units == column).then_some(value.len())
}

fn is_whole_word_bytes(value: &str, start: usize, end: usize) -> bool {
    let before = value[..start].chars().next_back();
    let after = value[end..].chars().next();
    !is_word_char(before) && !is_word_char(after)
}

fn is_word_char(value: Option<char>) -> bool {
    value
        .map(|char| char.is_alphanumeric() || char == '_')
        .unwrap_or(false)
}

fn parse_heading(line: &str) -> Option<(u8, String)> {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|char| *char == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = trimmed.get(hashes..)?;
    if !rest.starts_with(' ') {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some((hashes as u8, text))
    }
}

fn new_session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("large-{}-{nanos}", std::process::id())
}

fn replace_file(target: &Path, replacement: &Path) -> Result<(), String> {
    let backup = target.with_extension(format!(
        "{}.lightmark-bak",
        target
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("md")
    ));
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|err| format!("Failed to remove stale backup {}: {err}", backup.display()))?;
    }
    fs::rename(target, &backup)
        .map_err(|err| format!("Failed to create backup {}: {err}", backup.display()))?;
    if let Err(err) = fs::rename(replacement, target) {
        let _ = fs::rename(&backup, target);
        return Err(format!(
            "Failed to replace {} with {}: {err}",
            target.display(),
            replacement.display()
        ));
    }
    fs::remove_file(&backup)
        .map_err(|err| format!("Failed to remove backup {}: {err}", backup.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_file_edits, close_large_file, open_large_file_at_root, percent_decode_path,
        default_large_snapshot_root, read_file_chunk, resolve_asset_folder, save_plan_sync,
        sanitize_asset_file_name, cleanup_temp_error, sessions, write_view_temp,
        FileBaseSnapshot,
        save_large_file, save_large_file_as, similar_markdown_files, watch_path_key,
        write_text_file_safely,
    };
    use super::super::models::{
        LargeCloseDisposition, LargeCoordinateSpace, LargeFileError, TextEdit,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn safe_text_write_replaces_target_and_cleans_temporary_files() {
        let dir = unique_test_dir("safe-text-write");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        fs::write(&path, "original").unwrap();

        write_text_file_safely(&path, "updated").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "updated");
        assert!(!path.with_extension("md.lightmark-tmp").exists());
        assert!(!path.with_extension("md.lightmark-bak").exists());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn similar_markdown_files_finds_same_size_rename_and_ignores_other_files() {
        let dir = unique_test_dir("similar-markdown");
        fs::create_dir_all(&dir).unwrap();
        let original = dir.join("old.md");
        let renamed = dir.join("renamed.md");
        let other_size = dir.join("other.md");
        let non_markdown = dir.join("same.txt");
        fs::write(&renamed, "same content").unwrap();
        fs::write(&other_size, "different").unwrap();
        fs::write(&non_markdown, "same content").unwrap();

        let matches = similar_markdown_files(&original, 12, None).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, renamed.to_string_lossy());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn watch_path_key_deduplicates_case_and_separators() {
        let left = watch_path_key(PathBuf::from(r"C:\Docs\Note.md").as_path());
        let right = watch_path_key(PathBuf::from(r"c:/docs/note.md").as_path());

        assert_eq!(left, right);
    }

    #[test]
    fn asset_folder_stays_inside_document_directory() {
        let root = PathBuf::from(r"C:\Docs");
        assert_eq!(resolve_asset_folder(&root, Some("media/images")).unwrap(), root.join("media/images"));
        assert_eq!(resolve_asset_folder(&root, Some("")).unwrap(), root.join("assets"));
        assert!(resolve_asset_folder(&root, Some("../outside")).is_err());
        assert!(resolve_asset_folder(&root, Some(r"C:\outside")).is_err());
    }

    #[test]
    fn asset_reference_decodes_unicode_and_spaces() {
        assert_eq!(percent_decode_path("assets/%E5%9B%BE%20%E7%89%87.png"), "assets/图 片.png");
    }

    #[test]
    fn asset_file_name_preserves_unicode_letters() {
        assert_eq!(sanitize_asset_file_name("旅行 照片.jpg"), "旅行-照片.jpg");
    }

    #[test]
    fn large_file_edit_boundaries_preserve_pending_chunks_utf16_columns_and_same_line_edits() {
        let dir = unique_test_dir("large-edit-boundaries");
        fs::create_dir_all(&dir).unwrap();
        let mut failures = Vec::new();

        let pending_path = dir.join("pending.md");
        fs::write(&pending_path, "before\nsecond\n").unwrap();
        let pending_session =
            open_large_file_at_root(pending_path.to_string_lossy().into_owned(), default_large_snapshot_root()).unwrap();
        apply_file_edits(
            pending_session.session_id.clone(),
            vec![TextEdit {
                start_line: 0,
                start_column: 0,
                end_line: 0,
                end_column: 6,
                text: "after".to_string(),
            }],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        let pending_chunk = read_file_chunk(
            pending_session.session_id.clone(),
            0,
            2,
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
            .unwrap()
            .text;
        close_large_file(
            pending_session.session_id,
            1,
            LargeCloseDisposition::Discard,
        )
        .unwrap();
        if pending_chunk != "after\nsecond\n" {
            failures.push(format!(
                "pending chunk: expected {:?}, got {:?}",
                "after\nsecond\n", pending_chunk,
            ));
        }

        let emoji_path = dir.join("emoji.md");
        fs::write(&emoji_path, "😀abc\n").unwrap();
        let emoji_session =
            open_large_file_at_root(emoji_path.to_string_lossy().into_owned(), default_large_snapshot_root()).unwrap();
        apply_file_edits(
            emoji_session.session_id.clone(),
            vec![TextEdit {
                start_line: 0,
                start_column: 3,
                end_line: 0,
                end_column: 4,
                text: "X".to_string(),
            }],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        save_large_file(
            emoji_session.session_id.clone(),
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        close_large_file(
            emoji_session.session_id,
            1,
            LargeCloseDisposition::Saved,
        )
        .unwrap();
        let emoji_result = fs::read_to_string(&emoji_path).unwrap();
        if emoji_result != "😀aXc\n" {
            failures.push(format!(
                "emoji edit: expected {:?}, got {:?}",
                "😀aXc\n", emoji_result,
            ));
        }

        let same_line_path = dir.join("same-line.md");
        fs::write(&same_line_path, "abcdef\n").unwrap();
        let same_line_session =
            open_large_file_at_root(same_line_path.to_string_lossy().into_owned(), default_large_snapshot_root()).unwrap();
        apply_file_edits(
            same_line_session.session_id.clone(),
            vec![
                TextEdit {
                    start_line: 0,
                    start_column: 1,
                    end_line: 0,
                    end_column: 2,
                    text: "B".to_string(),
                },
                TextEdit {
                    start_line: 0,
                    start_column: 4,
                    end_line: 0,
                    end_column: 5,
                    text: "E".to_string(),
                },
            ],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        save_large_file(
            same_line_session.session_id.clone(),
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        close_large_file(
            same_line_session.session_id,
            1,
            LargeCloseDisposition::Saved,
        )
        .unwrap();
        let same_line_result = fs::read_to_string(&same_line_path).unwrap();
        if same_line_result != "aBcdEf\n" {
            failures.push(format!(
                "same-line edits: expected {:?}, got {:?}",
                "aBcdEf\n", same_line_result,
            ));
        }

        let insertion_path = dir.join("line-insertion.md");
        fs::write(&insertion_path, "one\ntwo\nthree\n").unwrap();
        let insertion_session =
            open_large_file_at_root(
                insertion_path.to_string_lossy().into_owned(),
                default_large_snapshot_root(),
            )
            .unwrap();
        apply_file_edits(
            insertion_session.session_id.clone(),
            vec![TextEdit {
                start_line: 1,
                start_column: 0,
                end_line: 1,
                end_column: 3,
                text: "inserted-a\ninserted-b".to_string(),
            }],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        // The second edit uses the visible line produced by the first insertion.
        apply_file_edits(
            insertion_session.session_id.clone(),
            vec![TextEdit {
                start_line: 2,
                start_column: 0,
                end_line: 2,
                end_column: 10,
                text: "changed-b".to_string(),
            }],
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        let insertion_chunk = read_file_chunk(
            insertion_session.session_id.clone(),
            0,
            5,
            2,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        if insertion_chunk.text != "one\ninserted-a\nchanged-b\nthree\n"
            || insertion_chunk.total_lines != 4
        {
            failures.push(format!(
                "line insertion projection: expected text {:?} with 4 lines, got {:?} with {} lines",
                "one\ninserted-a\nchanged-b\nthree\n",
                insertion_chunk.text,
                insertion_chunk.total_lines,
            ));
        }
        if let Err(error) = save_large_file(
            insertion_session.session_id.clone(),
            2,
            LargeCoordinateSpace::Utf16CodeUnits,
        ) {
            failures.push(format!("line insertion save failed: {error}"));
        }
        close_large_file(
            insertion_session.session_id,
            2,
            LargeCloseDisposition::Saved,
        )
        .unwrap();
        let insertion_result = fs::read_to_string(&insertion_path).unwrap();
        if insertion_result != "one\ninserted-a\nchanged-b\nthree\n" {
            failures.push(format!(
                "line insertion save: expected {:?}, got {:?}",
                "one\ninserted-a\nchanged-b\nthree\n", insertion_result,
            ));
        }

        let deletion_path = dir.join("line-deletion.md");
        fs::write(&deletion_path, "keep\ndelete-me\nedit-me\n").unwrap();
        let deletion_session = open_large_file_at_root(
            deletion_path.to_string_lossy().into_owned(),
            default_large_snapshot_root(),
        )
        .unwrap();
        apply_file_edits(
            deletion_session.session_id.clone(),
            vec![TextEdit {
                start_line: 1,
                start_column: 0,
                end_line: 2,
                end_column: 0,
                text: String::new(),
            }],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        // After deleting row 1, row 2 becomes visible row 1 and is edited there.
        apply_file_edits(
            deletion_session.session_id.clone(),
            vec![TextEdit {
                start_line: 1,
                start_column: 0,
                end_line: 1,
                end_column: 7,
                text: "edited".to_string(),
            }],
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        let deletion_chunk = read_file_chunk(
            deletion_session.session_id.clone(),
            0,
            4,
            2,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        if deletion_chunk.text != "keep\nedited\n" || deletion_chunk.total_lines != 2 {
            failures.push(format!(
                "line deletion projection: expected text {:?} with 2 lines, got {:?} with {} lines",
                "keep\nedited\n", deletion_chunk.text, deletion_chunk.total_lines,
            ));
        }
        if let Err(error) = save_large_file(
            deletion_session.session_id.clone(),
            2,
            LargeCoordinateSpace::Utf16CodeUnits,
        ) {
            failures.push(format!("line deletion save failed: {error}"));
        }
        close_large_file(
            deletion_session.session_id,
            2,
            LargeCloseDisposition::Saved,
        )
        .unwrap();
        let deletion_result = fs::read_to_string(&deletion_path).unwrap();
        if deletion_result != "keep\nedited\n" {
            failures.push(format!(
                "line deletion save: expected {:?}, got {:?}",
                "keep\nedited\n", deletion_result,
            ));
        }

        fs::remove_dir_all(dir).unwrap();
        assert!(failures.is_empty(), "large-file boundary red cases: {failures:?}");
    }

    #[test]
    fn large_file_save_rebases_private_base_before_the_next_edit() {
        let dir = unique_test_dir("large-save-rebase");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rebase.md");
        let snapshot_root = dir.join("snapshots");
        fs::write(&path, "😀abc\n").unwrap();

        let session = open_large_file_at_root(
            path.to_string_lossy().into_owned(),
            snapshot_root.clone(),
        )
        .unwrap();
        apply_file_edits(
            session.session_id.clone(),
            vec![TextEdit {
                start_line: 0,
                start_column: 3,
                end_line: 0,
                end_column: 4,
                text: "X".to_string(),
            }],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        let first_save = save_large_file(
            session.session_id.clone(),
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        assert_eq!(first_save.saved_revision, 1);
        assert_eq!(first_save.base_fingerprint, first_save.disk_fingerprint);

        // This edit is anchored to the rebased revision. If save had only
        // cleared the old pending list while retaining the old base, the
        // second save would either lose X or apply Y to the wrong bytes.
        apply_file_edits(
            session.session_id.clone(),
            vec![TextEdit {
                start_line: 0,
                start_column: 3,
                end_line: 0,
                end_column: 4,
                text: "Y".to_string(),
            }],
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        let second_save = save_large_file(
            session.session_id.clone(),
            2,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        assert_eq!(second_save.saved_revision, 2);
        assert_eq!(second_save.base_fingerprint, second_save.disk_fingerprint);
        assert_eq!(fs::read_to_string(&path).unwrap(), "😀aYc\n");

        let close = close_large_file(
            session.session_id,
            2,
            LargeCloseDisposition::Saved,
        )
        .unwrap();
        assert!(close.closed);
        assert!(close.cleanup_completed);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_save_plan_is_rejected_after_a_new_edit() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let dir = unique_test_dir("large-save-generation");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("generation.md");
        let snapshot_root = dir.join("snapshots");
        fs::write(&path, "first\nsecond\n").unwrap();
        let session = open_large_file_at_root(
            path.to_string_lossy().into_owned(),
            snapshot_root,
        )
        .unwrap();
        apply_file_edits(
            session.session_id.clone(),
            vec![TextEdit {
                start_line: 0,
                start_column: 0,
                end_line: 0,
                end_column: 5,
                text: "FIRST".to_string(),
            }],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();

        let captured = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        *save_plan_sync().lock().unwrap() = Some((Arc::clone(&captured), Arc::clone(&release)));
        let thread_session_id = session.session_id.clone();
        let saver = thread::spawn(move || {
            save_large_file(
                thread_session_id,
                1,
                LargeCoordinateSpace::Utf16CodeUnits,
            )
        });

        captured.wait();
        // The saver has captured revision 1 and is paused before writing.
        // A new edit advances both the document revision and the persistence
        // generation, so the old save must not publish its temp file.
        apply_file_edits(
            session.session_id.clone(),
            vec![TextEdit {
                start_line: 1,
                start_column: 0,
                end_line: 1,
                end_column: 6,
                text: "SECOND".to_string(),
            }],
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        release.wait();

        let error = saver.join().unwrap().expect_err("stale save must be rejected");
        assert_eq!(error.code, "save-plan-stale");
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\nsecond\n");
        assert!(fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .contains("lightmark-")));

        close_large_file(
            session.session_id,
            2,
            LargeCloseDisposition::Discard,
        )
        .unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn external_conflict_cleans_prepared_temp_and_keeps_pending_view() {
        let dir = unique_test_dir("large-save-conflict");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("conflict.md");
        let snapshot_root = dir.join("snapshots");
        fs::write(&path, "before\n").unwrap();
        let session = open_large_file_at_root(
            path.to_string_lossy().into_owned(),
            snapshot_root,
        )
        .unwrap();
        apply_file_edits(
            session.session_id.clone(),
            vec![TextEdit {
                start_line: 0,
                start_column: 0,
                end_line: 0,
                end_column: 6,
                text: "pending".to_string(),
            }],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();
        fs::write(&path, "external\n").unwrap();

        let error = save_large_file(
            session.session_id.clone(),
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .expect_err("external modification must block save");
        assert_eq!(error.code, "external-conflict");
        assert_eq!(error.recovery_artifact, None);
        assert!(fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .contains("lightmark-")));

        let close = close_large_file(
            session.session_id,
            1,
            LargeCloseDisposition::Discard,
        )
        .unwrap();
        assert!(close.closed);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_as_requires_target_fingerprint_and_rebases_path_identity() {
        let dir = unique_test_dir("large-save-as");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.md");
        let target = dir.join("target.md");
        let snapshot_root = dir.join("snapshots");
        fs::write(&source, "source\n").unwrap();
        fs::write(&target, "target\n").unwrap();
        let target_fingerprint = super::fingerprint_model(
            &FileBaseSnapshot::fingerprint_path(&target, 64 * 1024).unwrap(),
        );
        let session = open_large_file_at_root(
            source.to_string_lossy().into_owned(),
            snapshot_root,
        )
        .unwrap();
        apply_file_edits(
            session.session_id.clone(),
            vec![TextEdit {
                start_line: 0,
                start_column: 0,
                end_line: 0,
                end_column: 6,
                text: "saved-as".to_string(),
            }],
            0,
            LargeCoordinateSpace::Utf16CodeUnits,
        )
        .unwrap();

        let unauthorized = save_large_file_as(
            session.session_id.clone(),
            target.to_string_lossy().into_owned(),
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
            None,
        )
        .expect_err("existing target without a captured fingerprint must be rejected");
        assert_eq!(unauthorized.code, "target-conflict");

        let receipt = save_large_file_as(
            session.session_id.clone(),
            target.to_string_lossy().into_owned(),
            1,
            LargeCoordinateSpace::Utf16CodeUnits,
            Some(target_fingerprint),
        )
        .unwrap();
        assert_eq!(receipt.path, target.to_string_lossy());
        assert_eq!(fs::read_to_string(&target).unwrap(), "saved-as\n");
        let close = close_large_file(
            session.session_id,
            1,
            LargeCloseDisposition::Saved,
        )
        .unwrap();
        assert!(close.closed);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preexisting_save_temp_collision_is_never_deleted_by_cleanup() {
        let dir = unique_test_dir("large-save-temp-collision");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("source.md");
        let snapshot_root = dir.join("snapshots");
        let sentinel = dir.join(".existing-lightmark-temp");
        fs::write(&path, "source\n").unwrap();
        fs::write(&sentinel, "keep me\n").unwrap();
        let session = open_large_file_at_root(
            path.to_string_lossy().into_owned(),
            snapshot_root,
        )
        .unwrap();
        let view = sessions()
            .lock()
            .unwrap()
            .get(&session.session_id)
            .unwrap()
            .view
            .clone();
        let write_error = write_view_temp(&view, &sentinel).expect_err("sentinel must block create_new");
        assert!(!write_error.owned);
        let cleanup_error = cleanup_temp_error(
            LargeFileError::new("save-write-failed", write_error.message),
            &sentinel,
            write_error.owned,
        );
        assert_eq!(cleanup_error.recovery_artifact, None);
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "keep me\n");
        drop(view);
        close_large_file(
            session.session_id,
            0,
            LargeCloseDisposition::Discard,
        )
        .unwrap();
        fs::remove_file(&sentinel).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("lightmark-{name}-{millis}"))
    }
}
