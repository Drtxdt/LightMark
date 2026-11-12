use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(test)]
use std::cell::RefCell;

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(test)]
use regex::RegexBuilder;
use rfd::FileDialog;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use super::models::{
    AssetFileInfo, AssetInspection, DirtyState, FileChunk, FileInfo, FileNode, FileWatchEvent,
    LargeCloseDisposition, LargeCloseReceipt, LargeCoordinateSpace, LargeFileError,
    LargeFileFingerprint, LargeFileSession,
    LargeOutlineItem, LargeSaveReceipt, SimilarFileCandidate, TextEdit, TextFileSnapshot,
    TextFileWriteReceipt, WorkspaceWatchEvent,
};
#[cfg(test)]
use super::models::{LargeFindMatch, LargeFindOptions, LargeFindResult};
use super::large_file_base::{FileBaseSnapshot, SnapshotError, SourceFingerprint};
use super::large_text_view::{ViewEdit, ViewError};
use super::persistent_text::SegmentedTextView;
use super::file_replace_transaction::{
    normalize_target_for_transaction, DiskWriteStatus, FileReplaceTransaction,
    TransactionError, TransactionOutcome, TransactionReceipt,
};

const LARGE_FILE_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;
const FILE_WATCH_EVENT: &str = "lightmark-file-watch-event";
const WORKSPACE_WATCH_EVENT: &str = "lightmark-workspace-watch-event";
const ASSET_WATCH_EVENT: &str = "lightmark-asset-watch-event";

#[derive(Clone)]
struct SessionState {
    path: PathBuf,
    origin_path: PathBuf,
    snapshot_root: PathBuf,
    base: Arc<FileBaseSnapshot>,
    view: SegmentedTextView<FileBaseSnapshot>,
    size_bytes: u64,
    outline: Arc<Vec<LargeOutlineItem>>,
    revision: u64,
    saved_revision: u64,
    pending_edit_count: usize,
    base_fingerprint: SourceFingerprint,
    origin_fingerprint: SourceFingerprint,
    disk_fingerprint: SourceFingerprint,
    persistence_generation: u64,
    operation_receipts: Arc<HashMap<String, ([u8;32], super::models::LargeOperationReceipt)>>,
    completed_job_receipts: Arc<HashMap<String, (u64, super::models::LargeOperationReceipt)>>,
}

static LARGE_SESSIONS: OnceLock<Mutex<HashMap<String, SessionState>>> = OnceLock::new();
static FILE_WATCHERS: OnceLock<Mutex<HashMap<String, FileWatcherEntry>>> = OnceLock::new();
static WORKSPACE_WATCHER: OnceLock<Mutex<Option<FileWatcherEntry>>> = OnceLock::new();
static ASSET_WATCHER: OnceLock<Mutex<Option<FileWatcherEntry>>> = OnceLock::new();

#[cfg(test)]
static SAVE_PLAN_SYNC: OnceLock<Mutex<Option<(String, Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>> =
    OnceLock::new();

#[cfg(test)]
static SAVE_PLAN_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static TEXT_WRITE_TRANSACTION_HOOK: RefCell<
        Option<Box<dyn FnOnce(FileReplaceTransaction) -> FileReplaceTransaction>>,
    > = RefCell::new(None);
}

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
fn save_plan_sync() -> &'static Mutex<Option<(String, Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>> {
    SAVE_PLAN_SYNC.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
fn save_plan_test_lock() -> &'static Mutex<()> {
    SAVE_PLAN_TEST_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
fn pause_after_save_plan_capture(session_id: &str) {
    let hook = save_plan_sync().lock().ok().and_then(|mut value| {
        if value.as_ref().is_some_and(|(owner, _, _)| owner == session_id) { value.take() } else { None }
    });
    if let Some((_, captured, release)) = hook {
        captured.wait();
        release.wait();
    }
}

#[cfg(test)]
pub(crate) fn set_text_write_transaction_hook(
    hook: impl FnOnce(FileReplaceTransaction) -> FileReplaceTransaction + 'static,
) {
    TEXT_WRITE_TRANSACTION_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(hook));
    });
}

#[cfg(test)]
fn take_text_write_transaction_hook(
) -> Option<Box<dyn FnOnce(FileReplaceTransaction) -> FileReplaceTransaction>> {
    TEXT_WRITE_TRANSACTION_HOOK.with(|slot| slot.borrow_mut().take())
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
pub fn open_asset_file_dialog(markdown_path: Option<String>) -> Result<Option<String>, String> {
    let selected = FileDialog::new()
        .add_filter("附件", &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "mp3", "wav", "ogg", "m4a", "flac", "mp4", "webm", "mov", "mkv", "pdf"])
        .pick_file();
    if let (Some(doc), Some(file)) = (markdown_path.as_deref(), selected.as_deref()) {
        super::export_images::export_images().allow_file(Path::new(doc), file)?;
    }
    Ok(selected.map(path_to_string))
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
    read_text_file_snapshot_at(Path::new(&path))
        .map(|snapshot| snapshot.content)
        .map_err(|error| error.to_string())
}

/// Read the text and its content fingerprint from one opened file handle.
/// The returned pair is therefore the authorization snapshot for a normal
/// save; callers do not have to hash a second, potentially different file.
#[tauri::command]
pub fn read_text_file_snapshot(path: String) -> Result<TextFileSnapshot, LargeFileError> {
    let document = Path::new(&path);
    let snapshot = read_text_file_snapshot_at(document)?;
    // A file disappearing immediately after the read need not invalidate the
    // bytes already received. Its images will require a successful reopen.
    let _ = super::export_images::export_images().opened(document);
    Ok(snapshot)
}

#[tauri::command(async)]
pub fn get_file_info(path: String) -> Result<FileInfo, String> {
    let path_buf = PathBuf::from(&path);
    let metadata = fs::metadata(&path_buf)
        .map_err(|err| format!("Failed to inspect {}: {err}", path_buf.display()))?;
    let file = File::open(&path_buf).map_err(|err| format!("Failed to read {}: {err}", path_buf.display()))?;
    let line_count = count_logical_lines(file).map_err(|err| format!("Failed to scan {}: {err}", path_buf.display()))?;
    Ok(FileInfo {
        path: path.clone(),
        size_bytes: metadata.len(),
        line_count,
        is_large: metadata.len() >= LARGE_FILE_THRESHOLD_BYTES,
        encoding: "utf-8".to_string(),
    })
}

#[tauri::command(async)]
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

pub(crate) fn open_large_file_at_root(
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
        origin_path: path_buf.clone(),
        snapshot_root,
        base,
        view,
        size_bytes,
        outline: Arc::new(outline.clone()),
        revision: 0,
        saved_revision: 0,
        pending_edit_count: 0,
        base_fingerprint: base_fingerprint.clone(),
        origin_fingerprint: base_fingerprint.clone(),
        disk_fingerprint: base_fingerprint.clone(),
        persistence_generation: 0,
        operation_receipts: Arc::new(HashMap::new()),
        completed_job_receipts: Arc::new(HashMap::new()),
    };
    sessions()
        .lock()
        .map_err(|_| lock_error())?
        .insert(session_id.clone(), session);

    Ok(LargeFileSession {
        session_id,
        path: path.clone(),
        size_bytes,
        total_lines,
        outline,
        revision: 0,
        saved_revision: 0,
        pending_edit_count: 0,
        base_fingerprint: fingerprint_model(&base_fingerprint),
        disk_fingerprint: Some(fingerprint_model(&base_fingerprint)),
        coordinate_space: LargeCoordinateSpace::Utf16CodeUnits,
        target_path: Some(path),
        origin_path: None,
        recovery_draft_id: None,
    })
}

/// A stable, owned view copy used by the large-draft command layer.  Cloning
/// this value keeps the private base alive while the view is streamed, even if
/// the UI closes the original session during that stream.
pub(crate) struct LargeDraftCaptureSource {
    pub(crate) session_id: String,
    pub(crate) revision: u64,
    pub(crate) persistence_generation: u64,
    pub(crate) target_path: PathBuf,
    pub(crate) origin_path: PathBuf,
    pub(crate) origin_fingerprint: SourceFingerprint,
    pub(crate) base_fingerprint: SourceFingerprint,
    pub(crate) view: SegmentedTextView<FileBaseSnapshot>,
}

pub(crate) fn clone_large_session_for_draft(
    session_id: &str,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<LargeDraftCaptureSource, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let guard = sessions().lock().map_err(|_| lock_error())?;
    let session = guard
        .get(session_id)
        .ok_or_else(|| session_not_found(session_id))?;
    require_revision(session_id, expected_revision, session.revision)?;
    Ok(LargeDraftCaptureSource {
        session_id: session_id.to_string(),
        revision: session.revision,
        persistence_generation: session.persistence_generation,
        target_path: session.path.clone(),
        origin_path: session.origin_path.clone(),
        origin_fingerprint: session.origin_fingerprint.clone(),
        base_fingerprint: session.base_fingerprint.clone(),
        view: session.view.clone(),
    })
}

pub(crate) fn verify_large_session_for_draft(
    source: &LargeDraftCaptureSource,
) -> Result<(), LargeFileError> {
    let guard = sessions().lock().map_err(|_| lock_error())?;
    let current = guard
        .get(&source.session_id)
        .ok_or_else(|| {
            LargeFileError::new(
                "draft-capture-stale",
                "the large-file session closed while its draft snapshot was being captured",
            )
            .with_session(&source.session_id)
        })?;
    if current.revision != source.revision
        || current.persistence_generation != source.persistence_generation
        || current.path != source.target_path
        || current.base_fingerprint != source.base_fingerprint
    {
        return Err(LargeFileError::new(
            "draft-capture-stale",
            "the large-file session changed while its draft snapshot was being captured",
        )
        .with_session(&source.session_id)
        .with_revision(source.revision, current.revision));
    }
    Ok(())
}

pub(crate) fn register_recovered_large_session(
    base: Arc<FileBaseSnapshot>,
    view: SegmentedTextView<FileBaseSnapshot>,
    outline: Vec<LargeOutlineItem>,
    origin_path: PathBuf,
    origin_fingerprint: SourceFingerprint,
    snapshot_root: PathBuf,
    recovery_draft_id: String,
) -> Result<LargeFileSession, LargeFileError> {
    let session_id = new_session_id();
    let base_fingerprint = base.fingerprint().clone();
    let size_bytes = base.size_bytes();
    let total_lines = view.line_count();
    let session = SessionState {
        path: PathBuf::new(),
        origin_path: origin_path.clone(),
        snapshot_root,
        base: Arc::clone(&base),
        view,
        size_bytes,
        outline: Arc::new(outline.clone()),
        revision: 0,
        saved_revision: 0,
        pending_edit_count: 0,
        base_fingerprint: base_fingerprint.clone(),
        origin_fingerprint: origin_fingerprint.clone(),
        disk_fingerprint: base_fingerprint.clone(),
        persistence_generation: 0,
        operation_receipts: Arc::new(HashMap::new()),
        completed_job_receipts: Arc::new(HashMap::new()),
    };
    sessions()
        .lock()
        .map_err(|_| lock_error())?
        .insert(session_id.clone(), session);

    Ok(LargeFileSession {
        session_id,
        path: String::new(),
        size_bytes,
        total_lines,
        outline,
        revision: 0,
        saved_revision: 0,
        pending_edit_count: 0,
        base_fingerprint: fingerprint_model(&base_fingerprint),
        disk_fingerprint: None,
        coordinate_space: LargeCoordinateSpace::Utf16CodeUnits,
        target_path: None,
        origin_path: Some(origin_path.to_string_lossy().into_owned()),
        recovery_draft_id: Some(recovery_draft_id),
    })
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn read_file_range(
    session_id: String, expected_revision: u64, coordinate_space: LargeCoordinateSpace,
    start_line: usize, start_column: usize, end_line: Option<usize>, end_column: Option<usize>, max_bytes: Option<usize>,
) -> Result<super::models::FileRange, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let session = sessions().lock().map_err(|_|lock_error())?.get(&session_id).cloned().ok_or_else(||session_not_found(&session_id))?;
    require_revision(&session_id,expected_revision,session.revision)?;
    // Window backtracking may land between the two UTF-16 units of one scalar.
    // Only a read start rounds down; edit/export coordinates remain exact.
    let start_byte=match session.view.position_byte(start_line,start_column){
        Err(ViewError::InvalidUtf16Boundary{..}) if start_column>0 => session.view.position_byte(start_line,start_column-1),
        other=>other,
    }.map_err(|e|view_error(&session_id,e))?;
    let(start_line,start_column)=session.view.byte_position(start_byte).map_err(|e|view_error(&session_id,e))?;
    let end=match(end_line,end_column){(Some(l),Some(c))=>Some((l,c)),(None,None)=>None,_=>return Err(LargeFileError::new("invalid-range","both end line and column are required").with_session(&session_id))};
    let(text,(end_line,end_column),truncated)=session.view.read_range(start_line,start_column,end,max_bytes.unwrap_or(256*1024).max(4)).map_err(|e|view_error(&session_id,e))?;
    Ok(super::models::FileRange{session_id,revision:session.revision,coordinate_space,start_line,start_column,end_line,end_column,total_lines:session.view.line_count(),text,truncated,context_prefix:None,context_reliable:None})
}

#[tauri::command(async)]
pub fn read_large_preview_range(
    session_id: String, expected_revision: u64, coordinate_space: LargeCoordinateSpace,
    start_line: usize, start_column: usize, end_line: Option<usize>, end_column: Option<usize>, max_bytes: Option<usize>,
) -> Result<super::models::FileRange, LargeFileError> {
    let mut range=read_file_range(session_id.clone(),expected_revision,coordinate_space,start_line,start_column,end_line,end_column,max_bytes)?;
    let source=capture_large_job(&session_id,expected_revision,false)?;
    let context=super::large_preview::context(&source.view,range.start_line,range.start_column).map_err(|e|view_error(&session_id,e))?;
    range.context_prefix=Some(context.prefix);range.context_reliable=Some(context.reliable);Ok(range)
}

#[tauri::command(async)]
pub fn resolve_large_position(session_id:String, expected_revision:u64, coordinate_space:LargeCoordinateSpace, line:usize, column:usize, mode:String)->Result<super::models::LargeResolvedPosition,LargeFileError>{
    require_coordinate_space(coordinate_space)?;
    let direction=match mode.as_str(){"previous"=>-1,"next"=>1,"clamp"=>0,_=>return Err(LargeFileError::new("invalid-navigation-mode","mode must be previous, next or clamp").with_session(&session_id))};
    let session=sessions().lock().map_err(|_|lock_error())?.get(&session_id).cloned().ok_or_else(||session_not_found(&session_id))?;
    require_revision(&session_id,expected_revision,session.revision)?;
    let(line,column)=session.view.resolve_position(line,column,direction).map_err(|error|view_error(&session_id,error))?;
    Ok(super::models::LargeResolvedPosition{session_id,revision:session.revision,coordinate_space,line,column})
}

fn require_editable(session_id:&str,session:&SessionState)->Result<(),LargeFileError>{
    if session.base.size_bytes()>500*1024*1024{return Err(LargeFileError::new("large-file-read-only","files larger than 500MiB open read-only").with_session(session_id));}Ok(())
}

#[tauri::command(async)]
pub fn apply_file_operation(
    session_id:String, expected_revision:u64, coordinate_space:LargeCoordinateSpace, operation_id:String, edits:Vec<TextEdit>,
)->Result<super::models::LargeOperationReceipt,LargeFileError>{
    require_coordinate_space(coordinate_space)?;
    if operation_id.is_empty()||operation_id.len()>128{return Err(LargeFileError::new("invalid-operation-id","operation id must contain 1–128 bytes").with_session(&session_id))}
    let payload=serde_json::to_string(&(expected_revision,&edits)).map_err(|e|LargeFileError::new("invalid-operation",e.to_string()))?;
    let payload:[u8;32]=Sha256::digest(payload.as_bytes()).into();
    let mut guard=sessions().lock().map_err(|_|lock_error())?;let session=guard.get_mut(&session_id).ok_or_else(||session_not_found(&session_id))?;
    if let Some((original,receipt))=session.operation_receipts.get(&operation_id){if original==&payload{return Ok(receipt.clone())}return Err(LargeFileError::new("operation-id-conflict","operation id was already committed with different input").with_session(&session_id));}
    require_editable(&session_id,session)?;require_revision(&session_id,expected_revision,session.revision)?;
    let view_edits=edits.iter().map(view_edit).collect::<Vec<_>>();
    session.revision=session.view.apply_batch(expected_revision,&view_edits).map_err(|e|view_error(&session_id,e))?;
    session.pending_edit_count=session.pending_edit_count.saturating_add(edits.len());
    let receipt=super::models::LargeOperationReceipt{session_id:session_id.clone(),operation_id:operation_id.clone(),state:dirty_state(session,coordinate_space),total_lines:session.view.line_count()};
    Arc::make_mut(&mut session.operation_receipts).insert(operation_id,(payload,receipt.clone()));Ok(receipt)
}

#[tauri::command(async)]
pub fn move_large_history(
    session_id:String,expected_revision:u64,coordinate_space:LargeCoordinateSpace,direction:String,operation_id:String,
)->Result<super::models::LargeOperationReceipt,LargeFileError>{
    require_coordinate_space(coordinate_space)?;
    if direction!="undo"&&direction!="redo"{return Err(LargeFileError::new("invalid-history-direction","direction must be undo or redo").with_session(&session_id))}
    if operation_id.is_empty()||operation_id.len()>128{return Err(LargeFileError::new("invalid-operation-id","operation id must contain 1–128 bytes").with_session(&session_id))}
    let payload:[u8;32]=Sha256::digest(format!("history:{expected_revision}:{direction}").as_bytes()).into();let mut guard=sessions().lock().map_err(|_|lock_error())?;
    let session=guard.get_mut(&session_id).ok_or_else(||session_not_found(&session_id))?;
    if let Some((original,receipt))=session.operation_receipts.get(&operation_id){if original==&payload{return Ok(receipt.clone())}return Err(LargeFileError::new("operation-id-conflict","operation id was already used for different input").with_session(&session_id));}
    require_editable(&session_id,session)?;require_revision(&session_id,expected_revision,session.revision)?;
    let previous=session.revision;session.revision=session.view.move_history(expected_revision,direction=="undo").map_err(|e|view_error(&session_id,e))?;
    if session.revision!=previous{session.pending_edit_count=session.pending_edit_count.saturating_add(1)}
    let receipt=super::models::LargeOperationReceipt{session_id:session_id.clone(),operation_id:operation_id.clone(),state:dirty_state(session,coordinate_space),total_lines:session.view.line_count()};Arc::make_mut(&mut session.operation_receipts).insert(operation_id,(payload,receipt.clone()));Ok(receipt)
}

#[tauri::command(async)]
pub fn export_large_range(
    session_id:String,expected_revision:u64,coordinate_space:LargeCoordinateSpace,start_line:usize,start_column:usize,end_line:usize,end_column:usize,path:String,
)->Result<super::models::LargeRangeExportReceipt,LargeFileError>{
    require_coordinate_space(coordinate_space)?;
    let session=sessions().lock().map_err(|_|lock_error())?.get(&session_id).cloned().ok_or_else(||session_not_found(&session_id))?;require_revision(&session_id,expected_revision,session.revision)?;
    let from=session.view.position_byte(start_line,start_column).map_err(|e|view_error(&session_id,e))?;let to=session.view.position_byte(end_line,end_column).map_err(|e|view_error(&session_id,e))?;
    if from>to{return Err(LargeFileError::new("invalid-range","selection ends before its start").with_session(&session_id))}
    let mut output=OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e|LargeFileError::new("range-export-failed",e.to_string()).with_session(&session_id).with_path(&path))?;
    session.view.write_range(from,to,&mut output).map_err(|e|view_error(&session_id,e))?;output.sync_all().map_err(|e|LargeFileError::new("range-export-failed",e.to_string()).with_session(&session_id))?;
    Ok(super::models::LargeRangeExportReceipt{session_id,revision:session.revision,path,byte_length:to-from})
}

#[tauri::command(async)]
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
    require_editable(&session_id,session)?;
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

#[cfg(test)]
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

#[cfg(test)]
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
    require_editable(&session_id,session)?;
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
            end_line: item.end_line.unwrap_or(item.line),
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

#[tauri::command(async)]
pub fn save_large_file(
    session_id: String,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<LargeSaveReceipt, LargeFileError> {
    require_coordinate_space(coordinate_space)?;
    let plan = capture_save_plan(&session_id, expected_revision)?;
    if plan.path.as_os_str().is_empty() {
        return Err(LargeFileError::new(
            "save-as-required",
            "the recovered large-file session has no writable target; use Save As",
        )
        .with_session(&session_id));
    }
    if plan.revision == plan.saved_revision && plan.pending_edit_count == 0 {
        return Ok(save_receipt(&session_id, &plan, false, coordinate_space));
    }

    let (target, target_parent) = normalize_target_for_transaction(&plan.path)
        .map_err(|error| transaction_error(error, &session_id, &plan.path))?;
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

    let transaction = match FileReplaceTransaction::prepare(
        &target,
        Some(plan.disk_fingerprint.clone()),
        &temp_path,
        transaction_index_root(&target_parent),
    ) {
        Ok(transaction) => transaction,
        Err(error) => {
            let error = transaction_error(error, &session_id, &target);
            return Err(cleanup_temp_error(error, &temp_path, true));
        }
    };
    let mut guard = match sessions().lock() {
        Ok(guard) => guard,
        Err(_) => {
            let artifact = transaction.transaction_dir().to_path_buf();
            drop(transaction);
            let error = LargeFileError::new(
                "session-lock-poisoned",
                "large-file transaction was prepared but the session lock was poisoned",
            )
            .with_session(&session_id)
            .with_path(target.to_string_lossy())
            .with_transaction_evidence(
                TransactionOutcome::NotCommitted.as_str(),
                DiskWriteStatus::No.as_str(),
                None,
                Some(fingerprint_model(&output_fingerprint)),
            )
            .with_recovery_artifact(artifact.to_string_lossy());
            return Err(discard_prepared_with_error(prepared, error));
        }
    };
    let current = match guard.get_mut(&session_id) {
        Some(current) => current,
        None => {
            let artifact = transaction.transaction_dir().to_path_buf();
            drop(transaction);
            let error = LargeFileError::new(
                "session-not-found",
                "large-file transaction was prepared after the session was closed",
            )
            .with_session(&session_id)
            .with_path(target.to_string_lossy())
            .with_transaction_evidence(
                TransactionOutcome::NotCommitted.as_str(),
                DiskWriteStatus::No.as_str(),
                None,
                Some(fingerprint_model(&output_fingerprint)),
            )
            .with_recovery_artifact(artifact.to_string_lossy());
            drop(guard);
            return Err(discard_prepared_with_error(prepared, error));
        }
    };
    if current.persistence_generation != plan.persistence_generation
        || current.revision != plan.revision
        || current.path != plan.path
        || current.disk_fingerprint != plan.disk_fingerprint
    {
        let artifact = transaction.transaction_dir().to_path_buf();
        drop(transaction);
        let error = LargeFileError::new(
            "save-plan-stale",
            "the large-file session changed after preparation",
        )
        .with_session(&session_id)
        .with_path(target.to_string_lossy())
        .with_transaction_evidence(
            TransactionOutcome::NotCommitted.as_str(),
            DiskWriteStatus::No.as_str(),
            None,
            Some(fingerprint_model(&output_fingerprint)),
        )
        .with_recovery_artifact(artifact.to_string_lossy())
        .with_revision(plan.revision, current.revision);
        drop(guard);
        return Err(discard_prepared_with_error(prepared, error));
    }
    // Hold the session reservation through the native replacement and the
    // model publication. Edits, close, and a second save cannot cross this
    // final-check/commit boundary.
    let transaction_receipt = transaction.commit();
    if transaction_receipt.outcome != TransactionOutcome::Committed {
        let error = transaction_error_receipt(
            &transaction_receipt,
            transaction_failure_code(&transaction_receipt, "external-conflict"),
            "large-file transaction did not commit",
            &session_id,
            &target,
        );
        drop(guard);
        return Err(discard_prepared_with_error(prepared, error));
    }
    // Keep the immutable edit base and persistent history roots alive across
    // save. The prepared copy validates transaction bytes; it is not an edit.
    let outline = prepared.outline.clone();
    current.base_fingerprint = output_fingerprint.clone();
    current.origin_fingerprint = output_fingerprint.clone();
    current.outline = Arc::new(outline);
    current.size_bytes = output_fingerprint.size_bytes;
    current.disk_fingerprint = output_fingerprint;
    current.saved_revision = plan.revision;
    current.pending_edit_count = 0;
    let mut receipt = save_receipt(&session_id, current, true, coordinate_space);
    apply_transaction_receipt(&mut receipt, &transaction_receipt);
    drop(guard);
    drop(plan);
    let prepared_directory = prepared.base.snapshot_dir().to_string_lossy().to_string();
    if let Err(warning) = discard_prepared(prepared) {
        receipt.cleanup_warning = Some(merge_warnings(receipt.cleanup_warning.take(), warning));
        receipt.recovery_artifact = Some(prepared_directory);
    }
    Ok(receipt)
}

#[tauri::command(async)]
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
    let (normalized_target, target_parent) = normalize_target_for_transaction(&target)
        .map_err(|error| transaction_error(error, &session_id, &target))?;
    let expected_source = expected_target_fingerprint
        .as_ref()
        .map(source_fingerprint_from_model)
        .transpose()
        .map_err(|message| {
            LargeFileError::new("target-fingerprint-invalid", message)
                .with_session(&session_id)
                .with_path(target.to_string_lossy())
        })?;
    let captured_target = fingerprint_if_exists(&normalized_target)?;
    if !fingerprints_match(captured_target.as_ref(), expected_target_fingerprint.as_ref()) {
        return Err(target_conflict_error(
            &session_id,
            &target,
            captured_target,
            None,
        ));
    }
    let temp_path = unique_large_temp_path(&normalized_target, &session_id, plan.revision);
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
        &normalized_target,
        &session_id,
        &output_fingerprint,
    ) {
        Ok(prepared) => prepared,
        Err(error) => return Err(cleanup_temp_error(error, &temp_path, true)),
    };

    let transaction = match FileReplaceTransaction::prepare(
        &normalized_target,
        expected_source,
        &temp_path,
        transaction_index_root(&target_parent),
    ) {
        Ok(transaction) => transaction,
        Err(error) => {
            let error = transaction_error(error, &session_id, &target);
            return Err(cleanup_temp_error(error, &temp_path, true));
        }
    };
    let mut guard = match sessions().lock() {
        Ok(guard) => guard,
        Err(_) => {
            let artifact = transaction.transaction_dir().to_path_buf();
            drop(transaction);
            let error = LargeFileError::new(
                "session-lock-poisoned",
                "Save As transaction was prepared but the session lock was poisoned",
            )
            .with_session(&session_id)
            .with_path(target.to_string_lossy())
            .with_transaction_evidence(
                TransactionOutcome::NotCommitted.as_str(),
                DiskWriteStatus::No.as_str(),
                None,
                Some(fingerprint_model(&output_fingerprint)),
            )
            .with_recovery_artifact(artifact.to_string_lossy());
            return Err(discard_prepared_with_error(prepared, error));
        }
    };
    let current = match guard.get_mut(&session_id) {
        Some(current) => current,
        None => {
            let artifact = transaction.transaction_dir().to_path_buf();
            drop(transaction);
            let error = LargeFileError::new(
                "session-not-found",
                "Save As transaction was prepared after the session was closed",
            )
            .with_session(&session_id)
            .with_path(target.to_string_lossy())
            .with_transaction_evidence(
                TransactionOutcome::NotCommitted.as_str(),
                DiskWriteStatus::No.as_str(),
                None,
                Some(fingerprint_model(&output_fingerprint)),
            )
            .with_recovery_artifact(artifact.to_string_lossy());
            drop(guard);
            return Err(discard_prepared_with_error(prepared, error));
        }
    };
    if current.persistence_generation != plan.persistence_generation
        || current.revision != plan.revision
        || current.path != plan.path
        || current.disk_fingerprint != plan.disk_fingerprint
    {
        let artifact = transaction.transaction_dir().to_path_buf();
        drop(transaction);
        let error = LargeFileError::new(
            "save-plan-stale",
            "the session changed after Save As preparation",
        )
        .with_session(&session_id)
        .with_path(target.to_string_lossy())
        .with_transaction_evidence(
            TransactionOutcome::NotCommitted.as_str(),
            DiskWriteStatus::No.as_str(),
            None,
            Some(fingerprint_model(&output_fingerprint)),
        )
        .with_recovery_artifact(artifact.to_string_lossy())
        .with_revision(plan.revision, current.revision);
        drop(guard);
        return Err(discard_prepared_with_error(prepared, error));
    }
    // Keep the reservation until the OS operation and the in-memory publish
    // have both completed. A concurrent edit/close/save therefore cannot
    // invalidate this prepared revision after the final check.
    let transaction_receipt = transaction.commit();
    if transaction_receipt.outcome != TransactionOutcome::Committed {
        let error = transaction_error_receipt(
            &transaction_receipt,
            transaction_failure_code(&transaction_receipt, "target-conflict"),
            "Save As transaction did not commit",
            &session_id,
            &target,
        );
        drop(guard);
        return Err(discard_prepared_with_error(prepared, error));
    }
    // Keep the immutable edit base and persistent history roots alive across
    // save. The prepared copy validates transaction bytes; it is not an edit.
    let outline = prepared.outline.clone();
    current.base_fingerprint = output_fingerprint.clone();
    current.outline = Arc::new(outline);
    current.path = target.clone();
    current.origin_path = target.clone();
    current.size_bytes = output_fingerprint.size_bytes;
    current.origin_fingerprint = output_fingerprint.clone();
    current.disk_fingerprint = output_fingerprint;
    current.saved_revision = plan.revision;
    current.pending_edit_count = 0;
    let mut receipt = save_receipt(&session_id, current, true, coordinate_space);
    apply_transaction_receipt(&mut receipt, &transaction_receipt);
    drop(guard);
    drop(plan);
    let prepared_directory = prepared.base.snapshot_dir().to_string_lossy().to_string();
    if let Err(warning) = discard_prepared(prepared) {
        receipt.cleanup_warning = Some(merge_warnings(receipt.cleanup_warning.take(), warning));
        receipt.recovery_artifact = Some(prepared_directory);
    }
    Ok(receipt)
}

#[tauri::command(async)]
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
        if disposition == LargeCloseDisposition::Saved && current.path.as_os_str().is_empty() {
            return Err(LargeFileError::new(
                "save-as-required",
                "close(saved) requires a writable target; use Save As for the recovered session",
            )
            .with_session(&session_id)
            .with_revision(current.saved_revision, current.revision));
        }
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
        SnapshotError::Cancelled => "snapshot-cancelled",
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

pub(crate) fn transaction_index_root(target_parent: &Path) -> PathBuf {
    // The index is private to this target directory.  The transaction helper
    // validates and derives every artifact from this root; a manifest never
    // grants permission to act on an arbitrary path.
    target_parent.join(".lightmark-recovery-index")
}

fn transaction_error(
    error: TransactionError,
    session_id: &str,
    path: &Path,
) -> LargeFileError {
    let mut mapped = LargeFileError::new(error.code, error.message)
        .with_session(session_id)
        .with_path(path.to_string_lossy())
        .with_transaction_evidence(
            "not-committed",
            DiskWriteStatus::No.as_str(),
            None,
            None,
        );
    if let Some(artifact) = error.recovery_artifact {
        mapped = mapped.with_recovery_artifact(artifact.to_string_lossy());
    }
    if let Some(warning) = error.cleanup_warning {
        mapped = mapped.with_cleanup_warning(warning);
    }
    mapped
}

fn transaction_error_receipt(
    receipt: &TransactionReceipt,
    code: &str,
    message: &str,
    session_id: &str,
    path: &Path,
) -> LargeFileError {
    let detail = if receipt.message.is_empty() {
        message.to_string()
    } else {
        format!("{message}: {}", receipt.message)
    };
    let mut mapped = LargeFileError::new(code, detail)
        .with_session(session_id)
        .with_path(path.to_string_lossy())
        .with_transaction_evidence(
            receipt.outcome.as_str(),
            receipt.disk_written.as_str(),
            receipt.target_fingerprint.as_ref().map(fingerprint_model),
            receipt.output_fingerprint.as_ref().map(fingerprint_model),
        );
    if let Some(artifact) = &receipt.recovery_artifact {
        mapped = mapped.with_recovery_artifact(artifact.to_string_lossy());
    }
    if let Some(warning) = &receipt.cleanup_warning {
        mapped = mapped.with_cleanup_warning(warning.clone());
    }
    mapped
}

fn transaction_failure_code<'a>(receipt: &TransactionReceipt, conflict_code: &'a str) -> &'a str {
    match receipt.outcome {
        TransactionOutcome::Conflict => conflict_code,
        TransactionOutcome::NotCommitted => "save-not-committed",
        TransactionOutcome::Ambiguous => "save-ambiguous",
        TransactionOutcome::Committed => "save-transaction-failed",
    }
}

fn apply_transaction_receipt(
    receipt: &mut LargeSaveReceipt,
    transaction: &TransactionReceipt,
) {
    receipt.outcome = transaction.outcome.as_str().to_string();
    receipt.disk_written = transaction.disk_written.as_str().to_string();
    receipt.target_fingerprint = transaction
        .target_fingerprint
        .as_ref()
        .map(fingerprint_model);
    receipt.output_fingerprint = transaction
        .output_fingerprint
        .as_ref()
        .map(fingerprint_model);
    receipt.recovery_artifact = transaction
        .recovery_artifact
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    receipt.cleanup_warning = transaction.cleanup_warning.clone();
}

fn merge_warnings(previous: Option<String>, next: String) -> String {
    match previous {
        Some(previous) => format!("{previous}; {next}"),
        None => next,
    }
}

fn target_conflict_error(
    session_id: &str,
    path: &Path,
    target_fingerprint: Option<LargeFileFingerprint>,
    output_fingerprint: Option<LargeFileFingerprint>,
) -> LargeFileError {
    LargeFileError::new(
        "target-conflict",
        "the target changed or was not authorized at the save boundary",
    )
    .with_session(session_id)
    .with_path(path.to_string_lossy())
    .with_transaction_evidence(
        TransactionOutcome::Conflict.as_str(),
        DiskWriteStatus::No.as_str(),
        target_fingerprint,
        output_fingerprint,
    )
}

fn fingerprints_match(
    actual: Option<&LargeFileFingerprint>,
    expected: Option<&LargeFileFingerprint>,
) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(actual), Some(expected)) => {
            actual.size_bytes == expected.size_bytes
                && actual.sha256.eq_ignore_ascii_case(&expected.sha256)
        }
        _ => false,
    }
}

fn source_fingerprint_from_model(
    fingerprint: &LargeFileFingerprint,
) -> Result<SourceFingerprint, String> {
    if fingerprint.sha256.len() != 64 || !fingerprint.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("sha256 must contain exactly 64 hexadecimal characters".to_string());
    }
    let mut sha256 = [0_u8; 32];
    for (index, pair) in fingerprint.sha256.as_bytes().chunks_exact(2).enumerate() {
        sha256[index] = (hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]);
    }
    let modified = fingerprint
        .modified_millis
        .map(|value| {
            UNIX_EPOCH
                .checked_add(Duration::from_millis(value))
                .ok_or_else(|| "modifiedMillis is not representable as SystemTime".to_string())
        })
        .transpose()?;
    Ok(SourceFingerprint {
        size_bytes: fingerprint.size_bytes,
        modified,
        sha256,
    })
}

fn hex_nibble(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        b'A'..=b'F' => value - b'A' + 10,
        _ => 0,
    }
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
        is_dirty: session.path.as_os_str().is_empty()
            || session.revision != session.saved_revision
            || session.pending_edit_count != 0,
        pending_edit_count: session.pending_edit_count,
        revision: session.revision,
        saved_revision: session.saved_revision,
        coordinate_space,
    }
}

#[cfg(test)]
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
        is_dirty: session.path.as_os_str().is_empty()
            || session.revision != session.saved_revision
            || session.pending_edit_count != 0,
        pending_edit_count: session.pending_edit_count,
        path: path_to_string(session.path.clone()),
        base_fingerprint: fingerprint_model(&session.base_fingerprint),
        disk_fingerprint: fingerprint_model(&session.disk_fingerprint),
        coordinate_space,
        outcome: TransactionOutcome::Committed.as_str().to_string(),
        disk_written: DiskWriteStatus::Yes.as_str().to_string(),
        target_fingerprint: Some(fingerprint_model(&session.disk_fingerprint)),
        output_fingerprint: Some(fingerprint_model(&session.base_fingerprint)),
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
    pause_after_save_plan_capture(session_id);
    Ok(plan)
}

pub(crate) struct LargeJobSource {
    pub(crate) view: SegmentedTextView<FileBaseSnapshot>,
    pub(crate) snapshot_root: PathBuf,
    pub(crate) path: PathBuf,
}
pub(crate) fn capture_large_job(session_id:&str,revision:u64,editing:bool)->Result<LargeJobSource,LargeFileError>{
    let guard=sessions().lock().map_err(|_|lock_error())?;let session=guard.get(session_id).ok_or_else(||session_not_found(session_id))?;
    require_revision(session_id,revision,session.revision)?;if editing{require_editable(session_id,session)?;}
    Ok(LargeJobSource{view:session.view.clone(),snapshot_root:session.snapshot_root.clone(),path:session.path.clone()})
}
pub(crate) fn large_job_dirty_state(session_id:&str,revision:u64)->Result<DirtyState,LargeFileError>{
    let guard=sessions().lock().map_err(|_|lock_error())?;let session=guard.get(session_id).ok_or_else(||session_not_found(session_id))?;require_revision(session_id,revision,session.revision)?;Ok(dirty_state(session,LargeCoordinateSpace::Utf16CodeUnits))
}
pub(crate) fn completed_large_job_receipt(session_id:&str,job_id:&str,revision:u64)->Result<super::models::LargeOperationReceipt,LargeFileError>{
    let guard=sessions().lock().map_err(|_|lock_error())?;
    let session=guard.get(session_id).ok_or_else(||session_not_found(session_id))?;
    let(expected,receipt)=session.completed_job_receipts.get(job_id).ok_or_else(||LargeFileError::new("large-job-not-found","job not found").with_session(session_id))?;
    if *expected!=revision{return Err(LargeFileError::new("large-job-identity-mismatch","job revision does not match request").with_session(session_id));}
    Ok(receipt.clone())
}
pub(crate) fn retain_noop_large_job_receipt(session_id:&str,job_id:&str,revision:u64)->Result<super::models::LargeOperationReceipt,LargeFileError>{
    let mut guard=sessions().lock().map_err(|_|lock_error())?;
    let session=guard.get_mut(session_id).ok_or_else(||session_not_found(session_id))?;require_revision(session_id,revision,session.revision)?;
    let receipt=super::models::LargeOperationReceipt{session_id:session_id.into(),operation_id:job_id.into(),state:dirty_state(session,LargeCoordinateSpace::Utf16CodeUnits),total_lines:session.view.line_count()};
    Arc::make_mut(&mut session.completed_job_receipts).insert(job_id.into(),(revision,receipt.clone()));Ok(receipt)
}
pub(crate) fn commit_large_job(session_id:&str,revision:u64,operation_id:&str,snapshot:FileBaseSnapshot)->Result<super::models::LargeOperationReceipt,LargeFileError>{
    let mut guard=sessions().lock().map_err(|_|lock_error())?;
    let validation=guard.get(session_id).ok_or_else(||session_not_found(session_id)).and_then(|session|{require_revision(session_id,revision,session.revision)?;require_editable(session_id,session)});
    if let Err(error)=validation{let _=snapshot.cleanup();return Err(error)}
    let session=guard.get_mut(session_id).unwrap();
    session.revision=session.view.replace_with_snapshot(revision,snapshot).map_err(|e|view_error(session_id,e))?;
    session.pending_edit_count=session.pending_edit_count.saturating_add(1);
    let receipt=super::models::LargeOperationReceipt{session_id:session_id.into(),operation_id:operation_id.into(),state:dirty_state(session,LargeCoordinateSpace::Utf16CodeUnits),total_lines:session.view.line_count()};
    Arc::make_mut(&mut session.completed_job_receipts).insert(operation_id.into(),(revision,receipt.clone()));Ok(receipt)
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

fn discard_prepared_with_error(
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

pub(crate) fn fingerprint_if_exists(
    path: &Path,
) -> Result<Option<LargeFileFingerprint>, LargeFileError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(LargeFileError::new(
                "fingerprint-failed",
                format!("failed to inspect {}: {error}", path.display()),
            )
            .with_path(path.to_string_lossy()))
        }
    };
    reject_reparse_metadata(path, &metadata).map_err(|error| {
        LargeFileError::new("fingerprint-unsafe-path", error).with_path(path.to_string_lossy())
    })?;
    if !metadata.is_file() {
        return Err(LargeFileError::new(
            "fingerprint-invalid-path",
            format!("path is not a regular file: {}", path.display()),
        )
        .with_path(path.to_string_lossy()));
    }
    let fingerprint = FileBaseSnapshot::fingerprint_path(path, 64 * 1024)
        .map_err(|error| snapshot_error(error, path))?;
    Ok(Some(fingerprint_model(&fingerprint)))
}

fn reject_reparse_metadata(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.file_type().is_symlink() {
        return Err(format!("reparse/symlink path is not allowed: {}", path.display()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("reparse path is not allowed: {}", path.display()));
        }
    }
    Ok(())
}

fn read_text_file_snapshot_at(path: &Path) -> Result<TextFileSnapshot, LargeFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        LargeFileError::new(
            "read-failed",
            format!("failed to inspect {}: {error}", path.display()),
        )
        .with_path(path.to_string_lossy())
    })?;
    reject_reparse_metadata(path, &metadata).map_err(|error| {
        LargeFileError::new("read-unsafe-path", error).with_path(path.to_string_lossy())
    })?;
    if !metadata.is_file() {
        return Err(LargeFileError::new(
            "read-invalid-path",
            format!("path is not a regular file: {}", path.display()),
        )
        .with_path(path.to_string_lossy()));
    }

    let mut file = File::open(path).map_err(|error| {
        LargeFileError::new(
            "read-failed",
            format!("failed to open {}: {error}", path.display()),
        )
        .with_path(path.to_string_lossy())
    })?;
    let mut bytes = Vec::with_capacity(metadata.len().min(usize::MAX as u64) as usize);
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            LargeFileError::new(
                "read-failed",
                format!("failed to read {}: {error}", path.display()),
            )
            .with_path(path.to_string_lossy())
        })?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes.extend_from_slice(&buffer[..read]);
    }
    let after = file.metadata().map_err(|error| {
        LargeFileError::new(
            "read-failed",
            format!("failed to inspect opened {}: {error}", path.display()),
        )
        .with_path(path.to_string_lossy())
    })?;
    if after.len() != bytes.len() as u64
        || after.len() != metadata.len()
        || after.modified().ok() != metadata.modified().ok()
    {
        return Err(LargeFileError::new(
            "external-conflict",
            format!("{} changed while it was being read", path.display()),
        )
        .with_path(path.to_string_lossy()));
    }
    let content = String::from_utf8(bytes).map_err(|error| {
        LargeFileError::new(
            "invalid-utf8",
            format!("{} contains invalid UTF-8 at byte {}", path.display(), error.utf8_error().valid_up_to()),
        )
        .with_path(path.to_string_lossy())
    })?;
    Ok(TextFileSnapshot {
        content,
        fingerprint: fingerprint_model(&SourceFingerprint {
            size_bytes: after.len(),
            modified: after.modified().ok(),
            sha256: hash.finalize().into(),
        }),
    })
}

pub(crate) fn scan_outline_view(
    view: &SegmentedTextView<FileBaseSnapshot>,
    session_id: &str,
) -> Result<Vec<LargeOutlineItem>, LargeFileError> {
    let mut outline = Vec::new();
    view.visit_line_prefixes(4096, |line_index,line| {
        if outline.len() >= 100_000 { return; }
        if let Some((level,text))=parse_heading(line) {
            outline.push(LargeOutlineItem{id:format!("large-heading-{line_index}"),text,level,line:line_index});
        }
    }).map_err(|error| view_error(session_id,error))?;
    Ok(outline)
}

#[tauri::command]
pub fn write_text_file(
    path: String,
    content: String,
    expected_target_fingerprint: Option<LargeFileFingerprint>,
) -> Result<TextFileWriteReceipt, LargeFileError> {
    let path = PathBuf::from(path);
    let receipt = write_text_file_at_root(
        &path,
        &content,
        expected_target_fingerprint,
        transaction_index_root(path.parent().unwrap_or_else(|| Path::new("."))),
    )?;
    let _ = super::export_images::export_images().opened(&path);
    Ok(receipt)
}

pub(crate) fn write_text_file_at_root(
    path: &Path,
    content: &str,
    expected_target_fingerprint: Option<LargeFileFingerprint>,
    index_root: PathBuf,
) -> Result<TextFileWriteReceipt, LargeFileError> {
    let (target, _target_parent) = normalize_target_for_transaction(path)
        .map_err(|error| transaction_error(error, "text-write", path))?;
    let captured_target = fingerprint_if_exists(&target)?;
    if captured_target.is_some() && expected_target_fingerprint.is_none() {
        return Err(target_conflict_error(
            "text-write",
            path,
            captured_target,
            None,
        ));
    }
    let expected_source = expected_target_fingerprint
        .as_ref()
        .map(source_fingerprint_from_model)
        .transpose()
        .map_err(|message| {
            LargeFileError::new("target-fingerprint-invalid", message)
                .with_path(path.to_string_lossy())
        })?;
    if !fingerprints_match(captured_target.as_ref(), expected_target_fingerprint.as_ref()) {
        return Err(target_conflict_error(
            "text-write",
            path,
            captured_target,
            None,
        ));
    }

    let temp_path = unique_text_temp_path(&target);
    write_text_temp(&temp_path, content).map_err(|error| {
        cleanup_temp_error(
            LargeFileError::new("save-write-failed", error.message).with_path(path.to_string_lossy()),
            &temp_path,
            error.owned,
        )
    })?;
    let transaction = match FileReplaceTransaction::prepare(
        &target,
        expected_source,
        &temp_path,
        index_root,
    ) {
        Ok(transaction) => transaction,
        Err(error) => {
            let error = transaction_error(error, "text-write", path);
            return Err(cleanup_temp_error(error, &temp_path, true));
        }
    };
    #[cfg(test)]
    let transaction = match take_text_write_transaction_hook() {
        Some(hook) => hook(transaction),
        None => transaction,
    };
    let receipt = transaction.commit();
    if receipt.outcome != TransactionOutcome::Committed {
        return Err(transaction_error_receipt(
            &receipt,
            transaction_failure_code(&receipt, "external-conflict"),
            "text-file transaction did not commit",
            "text-write",
            path,
        ));
    }
    Ok(text_write_receipt(path, &receipt))
}

fn text_write_receipt(path: &Path, transaction: &TransactionReceipt) -> TextFileWriteReceipt {
    TextFileWriteReceipt {
        path: path.to_string_lossy().into_owned(),
        outcome: transaction.outcome.as_str().to_string(),
        disk_written: transaction.disk_written.as_str().to_string(),
        target_fingerprint: transaction
            .target_fingerprint
            .as_ref()
            .map(fingerprint_model),
        output_fingerprint: transaction
            .output_fingerprint
            .as_ref()
            .map(fingerprint_model),
        recovery_artifact: transaction
            .recovery_artifact
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        cleanup_warning: transaction.cleanup_warning.clone(),
    }
}

fn unique_text_temp_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("document");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    parent.join(format!(".{name}.lightmark-text-{}-{stamp}.tmp", std::process::id()))
}

fn write_text_temp(path: &Path, content: &str) -> Result<(), TempWriteError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| TempWriteError {
            message: format!("failed to create {}: {error}", path.display()),
            owned: false,
        })?;
    file.write_all(content.as_bytes()).map_err(|error| TempWriteError {
        message: format!("failed to write {}: {error}", path.display()),
        owned: true,
    })?;
    file.flush().map_err(|error| TempWriteError {
        message: format!("failed to flush {}: {error}", path.display()),
        owned: true,
    })?;
    file.sync_all().map_err(|error| TempWriteError {
        message: format!("failed to sync {}: {error}", path.display()),
        owned: true,
    })
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
    let target = create_new_document_file(&assets_dir, &safe_name, &bytes, true)?;
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
pub fn watch_markdown_workspace(app: AppHandle, path: String, epoch: u64) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_dir() {
        return Err(format!("Workspace folder does not exist: {}", path_buf.display()));
    }

    let watcher_root = path.clone();
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
            super::workspace_index::queue_workspace_paths(&watcher_root, paths.clone());
            let _ = app_handle.emit(WORKSPACE_WATCH_EVENT, serde_json::json!({ "root": watcher_root, "epoch": epoch, "paths": paths }));
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

#[tauri::command(async)]
pub fn read_relocated_markdown_fingerprint(
    path: String,
    expected_sha256: Option<String>,
) -> Result<LargeFileFingerprint, String> {
    let document = PathBuf::from(&path);
    if !is_markdown_file(&document) {
        return Err("请选择 Markdown 笔记。".into());
    }
    let fingerprint = super::large_draft::get_large_file_fingerprint(path)
        .map_err(|error| error.to_string())?
        .ok_or("候选笔记已不存在。")?;
    if expected_sha256.is_some_and(|expected| expected != fingerprint.sha256) {
        return Err("候选文件与上次读取的原稿内容不同。请单独打开候选文件核对，当前标签仍保留。".into());
    }
    super::export_images::export_images().opened(&document)?;
    Ok(fingerprint)
}

#[tauri::command]
pub fn create_markdown_file(folder: String, name: String, rename_on_conflict: Option<bool>) -> Result<String, String> {
    let folder = PathBuf::from(folder);
    if !folder.is_dir() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    if name.contains(['/', '\\', ':']) || matches!(name.as_str(), "." | "..") {
        return Err("新笔记的名称不能包含目录或盘符。".to_string());
    }
    let safe_name = if name.trim().is_empty() {
        "Untitled.md".to_string()
    } else if is_markdown_file(Path::new(&name)) {
        name
    } else {
        format!("{name}.md")
    };

    create_new_document_file(&folder, &safe_name, &[], rename_on_conflict.unwrap_or(false))
        .map(path_to_string)
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

fn create_new_document_file(folder: &Path, file_name: &str, bytes: &[u8], rename_on_conflict: bool) -> Result<PathBuf, String> {
    // Keep partial writes out of the published file and workspace watchers.
    // The final operation both claims the name and makes complete bytes visible.
    let mut builder = tempfile::Builder::new();
    builder.prefix(".lightmark-new-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut temp = builder.tempfile_in(folder)
        .map_err(|err| format!("无法在 {} 中创建文件：{err}", folder.display()))?;
    temp.write_all(bytes).and_then(|()| temp.as_file().sync_all())
        .map_err(|err| format!("无法写入 {file_name}：{err}"))?;
    let mut staged = temp.into_temp_path();
    let source = Path::new(file_name);
    let stem = source.file_stem().and_then(|value| value.to_str()).unwrap_or(file_name);
    let extension = source.extension().and_then(|value| value.to_str());
    for index in 0..=u32::MAX {
        let candidate = match (index, extension) {
            (0, _) => folder.join(file_name),
            (_, Some(ext)) if !ext.is_empty() => folder.join(format!("{stem}-{index}.{ext}")),
            _ => folder.join(format!("{stem}-{index}")),
        };
        match staged.persist_noclobber(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(failure) if failure.error.kind() == io::ErrorKind::AlreadyExists => {
                if !rename_on_conflict {
                    return Err(format!("文件已存在：{}", candidate.display()));
                }
                staged = failure.path;
            }
            Err(failure) => return Err(format!("无法创建 {}：{}", candidate.display(), failure.error)),
        }
    }
    Err(format!("无法为 {file_name} 分配空闲名称。"))
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

fn count_logical_lines(mut reader: impl Read) -> io::Result<usize> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut breaks = 0_usize;
    let mut previous_cr = false;
    let mut ends_break = false;
    let mut has_bytes = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 { break; }
        has_bytes = true;
        let bytes = &buffer[..read];
        for at in memchr::memchr2_iter(b'\r', b'\n', bytes) {
            if bytes[at] != b'\n' || !(at == 0 && previous_cr || at > 0 && bytes[at - 1] == b'\r') {
                breaks += 1;
            }
        }
        previous_cr = bytes.last() == Some(&b'\r');
        ends_break = bytes.last().is_some_and(|byte| *byte == b'\r' || *byte == b'\n');
    }
    Ok(breaks + usize::from(!has_bytes || !ends_break))
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
fn large_find_match(line: &str, line_index: usize, start: usize, end: usize) -> LargeFindMatch {
    LargeFindMatch {
        end_line: None,
        line: line_index,
        start_column: byte_to_utf16_column(line, start),
        end_column: byte_to_utf16_column(line, end),
        text: line[start..end].to_string(),
        preview: line.chars().take(180).collect(),
    }
}

#[cfg(test)]
fn byte_to_utf16_column(value: &str, byte_index: usize) -> usize {
    value[..byte_index].encode_utf16().count()
}

#[cfg(test)]
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

#[cfg(test)]
fn is_whole_word_bytes(value: &str, start: usize, end: usize) -> bool {
    let before = value[..start].chars().next_back();
    let after = value[end..].chars().next();
    !is_word_char(before) && !is_word_char(after)
}

#[cfg(test)]
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

#[cfg(test)]
mod tests {
    use super::{
        apply_file_edits, close_large_file, open_large_file_at_root, percent_decode_path,
        default_large_snapshot_root, read_file_chunk, resolve_asset_folder, save_plan_sync,
        save_plan_test_lock,
        sanitize_asset_file_name, cleanup_temp_error, sessions, write_view_temp,
        read_relocated_markdown_fingerprint, read_text_file_snapshot_at, transaction_index_root, write_text_file_at_root,
        FileBaseSnapshot,
        save_large_file, save_large_file_as, similar_markdown_files, watch_path_key,
    };
    use super::super::models::{
        LargeCloseDisposition, LargeCoordinateSpace, LargeFileError, TextEdit,
    };
    use std::fs;
    use std::path::PathBuf;
    use sha2::Digest;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn file_info_line_count_is_bounded_and_handles_mixed_endings() {
        struct TinyReads<'a>(&'a [u8]);
        impl std::io::Read for TinyReads<'_> {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let count = self.0.len().min(1).min(output.len());
                output[..count].copy_from_slice(&self.0[..count]);
                self.0 = &self.0[count..];
                Ok(count)
            }
        }
        for (source, expected) in [("", 1), ("a", 1), ("a\n", 1), ("\n\n", 2), ("a\r\nb\rc\nd", 4), ("😀\r\n中文\r", 2)] {
            assert_eq!(super::count_logical_lines(TinyReads(source.as_bytes())).unwrap(), expected, "{source:?}");
        }
        struct ManyShortLines { remaining: usize, max_read: usize }
        impl std::io::Read for ManyShortLines {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                self.max_read = self.max_read.max(output.len());
                let count = output.len().min(self.remaining);
                for (index, byte) in output[..count].iter_mut().enumerate() { *byte = if index % 2 == 0 { b'x' } else { b'\n' }; }
                self.remaining -= count;
                Ok(count)
            }
        }
        let mut input = ManyShortLines { remaining: 50 * 1024 * 1024, max_read: 0 };
        assert_eq!(super::count_logical_lines(&mut input).unwrap(), 25 * 1024 * 1024);
        assert_eq!(input.max_read, 64 * 1024, "file inspection must never request one buffer per complete line");
    }
    #[test]
    fn eof_range_returns_canonical_position_for_repeated_appends() {
        let root=unique_test_dir("eof-canonical-range");fs::create_dir_all(&root).unwrap();
        let path=root.join("source.md");fs::write(&path,"last😀").unwrap();
        let opened=open_large_file_at_root(path.to_string_lossy().into_owned(),root.join("snapshots")).unwrap();
        let id=opened.session_id;let space=LargeCoordinateSpace::Utf16CodeUnits;
        let range=super::read_file_range(id.clone(),0,space,opened.total_lines,0,None,None,Some(128)).unwrap();
        assert_eq!((range.start_line,range.start_column,range.end_line,range.end_column),(0,6,0,6));
        assert_eq!(range.text,"");
        let preview=super::read_large_preview_range(id.clone(),0,space,opened.total_lines,0,None,None,Some(128)).unwrap();
        assert_eq!((preview.start_line,preview.start_column),(0,6));
        assert_eq!(preview.context_reliable,Some(false),"canonical mid-line EOF must not claim whole-line preview context");
        let position=super::resolve_large_position(id.clone(),0,space,0,5,"clamp".into()).unwrap();
        assert_eq!((position.session_id.as_str(),position.revision,position.line,position.column),(id.as_str(),0,0,4));
        let next=super::resolve_large_position(id.clone(),0,space,0,4,"next".into()).unwrap();
        assert_eq!((next.line,next.column),(0,6));
        assert!(super::resolve_large_position(id.clone(),99,space,0,4,"next".into()).is_err());
        assert!(super::resolve_large_position(id.clone(),0,space,0,4,"unknown".into()).is_err());
        let rounded=super::read_file_range(id.clone(),0,space,0,5,None,None,Some(128)).unwrap();
        assert_eq!((rounded.start_line,rounded.start_column),(0,4));assert_eq!(rounded.text,"😀");
        assert!(super::read_file_range(id.clone(),0,space,0,999,None,None,Some(128)).is_err());
        assert!(super::apply_file_operation(id.clone(),0,space,"invalid-surrogate".into(),vec![TextEdit{start_line:0,start_column:5,end_line:0,end_column:5,text:"X".into()}]).is_err());
        for revision in 0..2 {
            let col=6+revision as usize;
            super::apply_file_operation(id.clone(),revision,space,format!("append-{revision}"),vec![TextEdit{start_line:0,start_column:col,end_line:0,end_column:col,text:"X".into()}]).unwrap();
        }
        assert_eq!(super::read_file_range(id.clone(),2,space,0,0,None,None,Some(128)).unwrap().text,"last😀XX");
        close_large_file(id,2,LargeCloseDisposition::Discard).unwrap();fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn range_operations_retry_history_save_and_export_keep_one_document() {
        use super::{read_file_range, apply_file_operation, move_large_history, export_large_range};
        let root=unique_test_dir("range-operation-history");fs::create_dir_all(&root).unwrap();
        let path=root.join("source.md");fs::write(&path,"😀abc\r\nsecond\n").unwrap();
        let opened=open_large_file_at_root(path.to_string_lossy().into_owned(),root.join("snapshots")).unwrap();
        let id=opened.session_id.clone();let space=LargeCoordinateSpace::Utf16CodeUnits;
        let edits=vec![TextEdit{start_line:0,start_column:3,end_line:0,end_column:4,text:"X".into()}];
        let first=apply_file_operation(id.clone(),0,space,"one".into(),edits.clone()).unwrap();assert_eq!(first.state.revision,1);
        let retry=apply_file_operation(id.clone(),0,space,"one".into(),edits.clone()).unwrap();assert_eq!(retry.state.revision,1);
        let mut changed=edits;changed[0].text="Y".into();assert!(apply_file_operation(id.clone(),0,space,"one".into(),changed).is_err());
        save_large_file(id.clone(),1,space).unwrap();assert_eq!(fs::read_to_string(&path).unwrap(),"😀aXc\r\nsecond\n");
        let undo=move_large_history(id.clone(),1,space,"undo".into(),"undo-one".into()).unwrap();assert_eq!(undo.state.revision,2);
        let restored=read_file_range(id.clone(),2,space,0,0,Some(2),Some(0),Some(32)).unwrap();assert_eq!(restored.text,"😀abc\r\nsecond\n");assert!(!restored.truncated);
        assert!(read_file_range(id.clone(),1,space,0,0,None,None,None).is_err());
        let undo_retry=move_large_history(id.clone(),1,space,"undo".into(),"undo-one".into()).unwrap();assert_eq!(undo_retry.state.revision,2);
        let redo=move_large_history(id.clone(),2,space,"redo".into(),"redo-one".into()).unwrap();assert_eq!(redo.state.revision,3);
        let exported=root.join("selection.md");let receipt=export_large_range(id.clone(),3,space,0,2,1,3,exported.to_string_lossy().into_owned()).unwrap();
        assert_eq!(fs::read_to_string(&exported).unwrap(),"aXc\r\nsec");assert_eq!(receipt.byte_length,8);
        assert_eq!(read_file_range(id.clone(),3,space,0,0,None,None,None).unwrap().text,"😀aXc\r\nsecond\n");
        save_large_file(id.clone(),3,space).unwrap();assert_eq!(fs::read_to_string(&path).unwrap(),"😀aXc\r\nsecond\n");
        assert!(close_large_file(id,3,LargeCloseDisposition::Saved).unwrap().cleanup_completed);fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn redo_survives_save_after_undo_of_two_acknowledged_inputs(){
        let root=unique_test_dir("redo-save-undo");fs::create_dir_all(&root).unwrap();let path=root.join("source.md");fs::write(&path,"base\n").unwrap();let opened=open_large_file_at_root(path.to_string_lossy().into_owned(),root.join("snapshots")).unwrap();let id=opened.session_id;let space=LargeCoordinateSpace::Utf16CodeUnits;
        for (revision,text) in [(0,"marker1 "),(1,"marker2 ")]{super::apply_file_operation(id.clone(),revision,space,format!("input-{revision}"),vec![TextEdit{start_line:0,start_column:0,end_line:0,end_column:0,text:text.into()}]).unwrap();}
        save_large_file(id.clone(),2,space).unwrap();super::move_large_history(id.clone(),2,space,"undo".into(),"undo".into()).unwrap();save_large_file(id.clone(),3,space).unwrap();assert_eq!(fs::read_to_string(&path).unwrap(),"marker1 base\n");
        super::move_large_history(id.clone(),3,space,"redo".into(),"redo".into()).unwrap();assert_eq!(super::read_file_range(id.clone(),4,space,0,0,None,None,None).unwrap().text,"marker2 marker1 base\n");save_large_file(id.clone(),4,space).unwrap();assert_eq!(fs::read_to_string(&path).unwrap(),"marker2 marker1 base\n");close_large_file(id,4,LargeCloseDisposition::Saved).unwrap();fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn two_notes_save_and_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let left = root.join("左栏");
        let right = root.join("右栏");
        fs::create_dir(&left).unwrap();
        fs::create_dir(&right).unwrap();
        let old = "\u{feff}![封面](cover.svg)\r\n";
        let a = left.join("笔记.md");
        let b = right.join("笔记.md");
        fs::write(&a, old).unwrap();
        fs::write(&b, old).unwrap();
        fs::write(left.join("cover.svg"), "<svg width='13'/>").unwrap();
        fs::write(right.join("cover.svg"), "<svg width='29'/>").unwrap();
        let copy = right.join("副本.md");
        for (target, addition, existing) in [(&a, "", true), (&a, "左", true), (&copy, "右", false)] {
            let expected = existing.then(|| read_text_file_snapshot_at(target).unwrap().fingerprint);
            let receipt = write_text_file_at_root(target, &format!("{old}{addition}"), expected, transaction_index_root(&root)).unwrap();
            assert_eq!((receipt.outcome.as_str(), receipt.disk_written.as_str()), ("committed", "yes"));
        }
        for (note, addition, width) in [(&a, "左", 13), (&copy, "右", 29), (&b, "", 29)] {
            assert_eq!(read_text_file_snapshot_at(note).unwrap().content, format!("{old}{addition}"));
            assert_eq!(fs::read_to_string(note.with_file_name("cover.svg")).unwrap(), format!("<svg width='{width}'/>"));
        }
        assert!(write_text_file_at_root(&b, "collision", None, transaction_index_root(&root)).is_err());
        assert_eq!(fs::read(&b).unwrap(), old.as_bytes());
    }

    #[test]
    fn safe_text_write_replaces_target_and_cleans_temporary_files() {
        let dir = unique_test_dir("safe-text-write");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        fs::write(&path, "original").unwrap();

        let expected = super::fingerprint_model(
            &FileBaseSnapshot::fingerprint_path(&path, 64 * 1024).unwrap(),
        );
        let receipt = write_text_file_at_root(
            &path,
            "updated",
            Some(expected),
            transaction_index_root(&dir),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "updated");
        assert_eq!(receipt.outcome, "committed");
        assert_eq!(receipt.disk_written, "yes");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn text_snapshot_returns_content_and_hash_from_one_read() {
        let dir = unique_test_dir("text-snapshot");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        let bytes = b"\xEF\xBB\xBFemoji \xF0\x9F\x98\x80\r\n";
        fs::write(&path, bytes).unwrap();

        let snapshot = read_text_file_snapshot_at(&path).unwrap();
        assert_eq!(snapshot.content.as_bytes(), bytes);
        assert_eq!(snapshot.fingerprint.size_bytes, bytes.len() as u64);
        assert_eq!(
            snapshot.fingerprint.sha256,
            format!("{:x}", sha2::Sha256::digest(bytes))
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn relocation_checks_content_before_binding_a_same_size_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("moved.md");
        fs::write(&path, "first note").unwrap();
        let candidate = path.to_string_lossy().into_owned();
        let original = read_relocated_markdown_fingerprint(candidate.clone(), None).unwrap();
        fs::write(&path, "other note").unwrap();
        assert!(read_relocated_markdown_fingerprint(candidate.clone(), Some(original.sha256.clone())).is_err());
        fs::write(&path, "first note").unwrap();
        assert!(read_relocated_markdown_fingerprint(candidate, Some(original.sha256)).is_ok());
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

    fn race_creations<T: Send>(work: impl Fn(u8) -> T + Sync) -> Vec<T> {
        const WRITERS: u8 = 12;
        let barrier = std::sync::Barrier::new(usize::from(WRITERS));
        std::thread::scope(|scope| {
            let barrier = &barrier;
            let work = &work;
            let handles: Vec<_> = (0..WRITERS)
                .map(|number| scope.spawn(move || {
                    barrier.wait();
                    work(number)
                }))
                .collect();
            handles.into_iter().map(|handle| handle.join().unwrap()).collect()
        })
    }

    #[test]
    fn concurrent_pastes_keep_every_payload_and_existing_attachment() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("文章.md");
        let assets = dir.path().join("assets");
        fs::write(&doc, "original").unwrap();
        fs::create_dir(&assets).unwrap();
        fs::write(assets.join("照片.png"), b"old attachment").unwrap();
        let outputs = race_creations(|number| {
            let bytes = vec![number; 8192];
            let reference = super::save_asset_file(
                doc.to_string_lossy().into_owned(), "照片.png".into(), bytes.clone(), None,
            ).unwrap();
            (dir.path().join(reference), bytes)
        });
        let names: std::collections::HashSet<_> = outputs.iter().map(|(path, _)| path).collect();
        assert_eq!(names.len(), outputs.len(), "two pastes returned the same file");
        for (path, bytes) in &outputs { assert_eq!(fs::read(path).unwrap(), *bytes); }
        assert_eq!(fs::read(assets.join("照片.png")).unwrap(), b"old attachment");
        assert_eq!(fs::read_dir(assets).unwrap().count(), outputs.len() + 1);
        assert_eq!(fs::read(doc).unwrap(), b"original");
    }

    #[test]
    fn concurrent_explicit_note_creation_has_exactly_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let results = race_creations(|_| super::create_markdown_file(root.clone(), "同名".into(), None));
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        let note = dir.path().join("同名.md");
        fs::write(&note, "keep these bytes").unwrap();
        assert!(super::create_markdown_file(root, "同名.md".into(), None).is_err());
        assert_eq!(fs::read(note).unwrap(), b"keep these bytes");
    }

    #[test]
    fn concurrent_automatic_note_names_keep_all_new_notes_and_existing_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("未命名.MD"), b"original").unwrap();
        let paths = race_creations(|_| {
            super::create_markdown_file(root.clone(), "未命名.MD".into(), Some(true)).unwrap()
        });
        let names: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(names.len(), paths.len());
        for name in paths { assert_eq!(fs::read(name).unwrap(), b""); }
        assert_eq!(fs::read(dir.path().join("未命名.MD")).unwrap(), b"original");
        assert!(dir.path().join("未命名-1.MD").is_file());
        assert!(super::create_markdown_file(root, "nested/page".into(), None).is_err());
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
        assert_eq!(first_save.disk_fingerprint, super::fingerprint_model(
            &super::FileBaseSnapshot::fingerprint_path(&path, 64 * 1024).unwrap()
        ), "large save disk baseline must describe the actual installed target, including mtime");

        // The edit remains anchored to the published revision after save.
        // The persistent tree retains X and the immutable original base.
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
        assert_eq!(second_save.disk_fingerprint, super::fingerprint_model(
            &super::FileBaseSnapshot::fingerprint_path(&path, 64 * 1024).unwrap()
        ), "second large save must preserve the actual installed mtime baseline");
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

        let _save_plan_test_guard = save_plan_test_lock().lock().unwrap();
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
        *save_plan_sync().lock().unwrap() = Some((session.session_id.clone(), Arc::clone(&captured), Arc::clone(&release)));
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
        assert_eq!(error.outcome.as_deref(), Some("not-committed"));
        assert_eq!(error.disk_written.as_deref(), Some("no"));
        assert!(error.recovery_artifact.is_some());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\nsecond\n");

        close_large_file(
            session.session_id,
            2,
            LargeCloseDisposition::Discard,
        )
        .unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn close_after_save_prepare_does_not_allow_a_late_disk_commit() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let _save_plan_test_guard = save_plan_test_lock().lock().unwrap();
        let dir = unique_test_dir("large-save-close-race");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("close-race.md");
        fs::write(&path, "before\n").unwrap();
        let session = open_large_file_at_root(
            path.to_string_lossy().into_owned(),
            dir.join("snapshots"),
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

        let captured = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        *save_plan_sync().lock().unwrap() = Some((session.session_id.clone(), Arc::clone(&captured), Arc::clone(&release)));
        let saver_session_id = session.session_id.clone();
        let saver = thread::spawn(move || {
            save_large_file(
                saver_session_id,
                1,
                LargeCoordinateSpace::Utf16CodeUnits,
            )
        });

        captured.wait();
        let close = close_large_file(
            session.session_id,
            1,
            LargeCloseDisposition::Discard,
        )
        .unwrap();
        assert!(close.closed);
        release.wait();

        let error = saver
            .join()
            .unwrap()
            .expect_err("a save whose session closed during preparation must not commit");
        assert_eq!(error.code, "session-not-found");
        assert_eq!(error.outcome.as_deref(), Some("not-committed"));
        assert_eq!(error.disk_written.as_deref(), Some("no"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "before\n");

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
        assert_eq!(error.outcome.as_deref(), Some("conflict"));
        assert_eq!(error.disk_written.as_deref(), Some("no"));
        assert!(error.recovery_artifact.is_some());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external\n");

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
