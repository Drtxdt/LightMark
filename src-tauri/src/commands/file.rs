use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use regex::RegexBuilder;
use rfd::FileDialog;
use tauri::{AppHandle, Emitter};

use super::models::{
    DirtyState, FileChunk, FileInfo, FileNode, FileWatchEvent, LargeFileSession, LargeFindMatch,
    LargeFindOptions, LargeFindResult, LargeOutlineItem, SimilarFileCandidate, TextEdit,
};

const LARGE_FILE_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;
const FILE_WATCH_EVENT: &str = "lightmark-file-watch-event";

#[derive(Debug, Clone)]
struct SessionState {
    path: PathBuf,
    size_bytes: u64,
    line_offsets: Vec<u64>,
    edits: Vec<TextEdit>,
    outline: Vec<LargeOutlineItem>,
}

static LARGE_SESSIONS: OnceLock<Mutex<HashMap<String, SessionState>>> = OnceLock::new();
static FILE_WATCHERS: OnceLock<Mutex<HashMap<String, FileWatcherEntry>>> = OnceLock::new();

struct FileWatcherEntry {
    _watcher: RecommendedWatcher,
}

fn sessions() -> &'static Mutex<HashMap<String, SessionState>> {
    LARGE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_watchers() -> &'static Mutex<HashMap<String, FileWatcherEntry>> {
    FILE_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
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
pub fn open_large_file(path: String) -> Result<LargeFileSession, String> {
    let path_buf = PathBuf::from(&path);
    let metadata = fs::metadata(&path_buf)
        .map_err(|err| format!("Failed to inspect {}: {err}", path_buf.display()))?;
    let line_offsets = scan_line_offsets(&path_buf)?;
    let outline = scan_outline(&path_buf)?;
    let session_id = new_session_id();
    let session = SessionState {
        path: path_buf,
        size_bytes: metadata.len(),
        line_offsets,
        edits: Vec::new(),
        outline,
    };
    let total_lines = session.line_offsets.len();
    let outline = session.outline.clone();
    sessions()
        .lock()
        .map_err(|_| "Large file session lock was poisoned.".to_string())?
        .insert(session_id.clone(), session);

    Ok(LargeFileSession {
        session_id,
        path,
        size_bytes: metadata.len(),
        total_lines,
        outline,
    })
}

#[tauri::command]
pub fn read_file_chunk(
    session_id: String,
    start_line: usize,
    line_count: usize,
) -> Result<FileChunk, String> {
    let session = sessions()
        .lock()
        .map_err(|_| "Large file session lock was poisoned.".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Large file session was not found.".to_string())?;

    let total_lines = session.line_offsets.len();
    let start = start_line.min(total_lines);
    let end = start.saturating_add(line_count).min(total_lines);
    let mut file = File::open(&session.path)
        .map_err(|err| format!("Failed to read {}: {err}", session.path.display()))?;
    let mut text = String::new();

    if start < end {
        let start_offset = session.line_offsets[start];
        let end_offset = if end < total_lines {
            session.line_offsets[end]
        } else {
            session.size_bytes
        };
        let byte_count = end_offset.saturating_sub(start_offset) as usize;
        let mut buffer = vec![0_u8; byte_count];
        file.seek(SeekFrom::Start(start_offset))
            .map_err(|err| format!("Failed to seek {}: {err}", session.path.display()))?;
        file.read_exact(&mut buffer)
            .map_err(|err| format!("Failed to read {}: {err}", session.path.display()))?;
        text = String::from_utf8_lossy(&buffer).to_string();
    }

    Ok(FileChunk {
        session_id,
        start_line: start,
        end_line: end,
        total_lines,
        text,
    })
}

#[tauri::command]
pub fn apply_file_edits(session_id: String, edits: Vec<TextEdit>) -> Result<DirtyState, String> {
    let mut guard = sessions()
        .lock()
        .map_err(|_| "Large file session lock was poisoned.".to_string())?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| "Large file session was not found.".to_string())?;
    for edit in edits {
        session
            .edits
            .retain(|existing| !edits_overlap(existing, &edit));
        session.edits.push(edit);
    }
    session
        .edits
        .sort_by_key(|edit| (edit.start_line, edit.start_column));
    Ok(DirtyState {
        is_dirty: !session.edits.is_empty(),
        pending_edit_count: session.edits.len(),
    })
}

#[tauri::command]
pub fn search_large_file(
    session_id: String,
    query: String,
    options: LargeFindOptions,
    start_line: Option<usize>,
    limit: Option<usize>,
) -> Result<LargeFindResult, String> {
    if query.is_empty() {
        return Ok(LargeFindResult {
            matches: Vec::new(),
            total: 0,
            truncated: false,
            error: String::new(),
        });
    }

    let session = sessions()
        .lock()
        .map_err(|_| "Large file session lock was poisoned.".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Large file session was not found.".to_string())?;

    let matcher = LargeMatcher::new(&query, &options);
    if let Err(error) = matcher {
        return Ok(LargeFindResult {
            matches: Vec::new(),
            total: 0,
            truncated: false,
            error,
        });
    }
    let matcher = matcher?;
    let limit = limit.unwrap_or(2000).max(1);
    let start_line = start_line.unwrap_or(0);
    let file = File::open(&session.path)
        .map_err(|err| format!("Failed to read {}: {err}", session.path.display()))?;
    let reader = BufReader::new(file);
    let mut matches = Vec::new();
    let mut total = 0_usize;

    for (line_index, line) in reader.lines().enumerate() {
        let line =
            line.map_err(|err| format!("Failed to scan {}: {err}", session.path.display()))?;
        if line_index < start_line {
            continue;
        }
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
    })
}

#[tauri::command]
pub fn replace_large_file_matches(
    session_id: String,
    query: String,
    replacement: String,
    options: LargeFindOptions,
    current_match: Option<LargeFindMatch>,
) -> Result<DirtyState, String> {
    if query.is_empty() {
        return Ok(DirtyState {
            is_dirty: false,
            pending_edit_count: sessions()
                .lock()
                .map_err(|_| "Large file session lock was poisoned.".to_string())?
                .get(&session_id)
                .map(|session| session.edits.len())
                .unwrap_or(0),
        });
    }

    let session = sessions()
        .lock()
        .map_err(|_| "Large file session lock was poisoned.".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Large file session was not found.".to_string())?;

    let matcher = LargeMatcher::new(&query, &options)?;
    let edits = if let Some(item) = current_match {
        vec![TextEdit {
            start_line: item.line,
            start_column: item.start_column,
            end_line: item.line,
            end_column: item.end_column,
            text: matcher.replace_text(&item.text, &replacement),
        }]
    } else {
        collect_large_replace_edits(&session.path, &matcher, &replacement)?
    };

    apply_file_edits(session_id, edits)
}

#[tauri::command]
pub fn save_large_file(session_id: String) -> Result<DirtyState, String> {
    let session = sessions()
        .lock()
        .map_err(|_| "Large file session lock was poisoned.".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Large file session was not found.".to_string())?;

    if session.edits.is_empty() {
        return Ok(DirtyState {
            is_dirty: false,
            pending_edit_count: 0,
        });
    }

    let temp_path = session.path.with_extension(format!(
        "{}.lightmark-tmp",
        session
            .path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("md")
    ));
    let input = File::open(&session.path)
        .map_err(|err| format!("Failed to read {}: {err}", session.path.display()))?;
    let output = File::create(&temp_path)
        .map_err(|err| format!("Failed to create {}: {err}", temp_path.display()))?;
    let mut writer = BufWriter::new(output);
    let mut reader = BufReader::new(input);
    let mut line = String::new();
    let mut line_index = 0_usize;
    let mut edit_index = 0_usize;

    while reader
        .read_line(&mut line)
        .map_err(|err| format!("Failed to read {}: {err}", session.path.display()))?
        > 0
    {
        if edit_index >= session.edits.len() || line_index < session.edits[edit_index].start_line {
            writer
                .write_all(line.as_bytes())
                .map_err(|err| format!("Failed to write {}: {err}", temp_path.display()))?;
            line.clear();
            line_index += 1;
            continue;
        }

        let edit = &session.edits[edit_index];
        if line_index == edit.start_line {
            let mut affected = vec![line.clone()];
            while line_index + affected.len() <= edit.end_line {
                let mut next = String::new();
                if reader
                    .read_line(&mut next)
                    .map_err(|err| format!("Failed to read {}: {err}", session.path.display()))?
                    == 0
                {
                    break;
                }
                affected.push(next);
            }
            let replacement = apply_edit_to_lines(&affected, edit);
            writer
                .write_all(replacement.as_bytes())
                .map_err(|err| format!("Failed to write {}: {err}", temp_path.display()))?;
            line_index += affected.len();
            edit_index += 1;
            line.clear();
            continue;
        }

        line.clear();
        line_index += 1;
    }

    writer
        .flush()
        .map_err(|err| format!("Failed to flush {}: {err}", temp_path.display()))?;
    replace_file(&session.path, &temp_path)?;

    let line_offsets = scan_line_offsets(&session.path)?;
    let outline = scan_outline(&session.path)?;
    let mut guard = sessions()
        .lock()
        .map_err(|_| "Large file session lock was poisoned.".to_string())?;
    if let Some(current) = guard.get_mut(&session_id) {
        current.size_bytes = fs::metadata(&current.path)
            .map_err(|err| format!("Failed to inspect {}: {err}", current.path.display()))?
            .len();
        current.line_offsets = line_offsets;
        current.outline = outline;
        current.edits.clear();
    }

    Ok(DirtyState {
        is_dirty: false,
        pending_edit_count: 0,
    })
}

#[tauri::command]
pub fn close_large_file(session_id: String) -> Result<(), String> {
    sessions()
        .lock()
        .map_err(|_| "Large file session lock was poisoned.".to_string())?
        .remove(&session_id);
    Ok(())
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
) -> Result<String, String> {
    let markdown_path = PathBuf::from(markdown_path);
    let document_dir = markdown_path
        .parent()
        .ok_or_else(|| "当前 Markdown 文件没有可用的父目录。".to_string())?;
    let assets_dir = document_dir.join("assets");
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
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
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

fn collect_large_replace_edits(
    path: &Path,
    matcher: &LargeMatcher,
    replacement: &str,
) -> Result<Vec<TextEdit>, String> {
    let file =
        File::open(path).map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let reader = BufReader::new(file);
    let mut edits = Vec::new();

    for (line_index, line) in reader.lines().enumerate() {
        let line = line.map_err(|err| format!("Failed to scan {}: {err}", path.display()))?;
        let matches = matcher.find_line(&line, line_index);
        if !matches.is_empty() {
            let next = replace_line_matches(&line, &matches, matcher, replacement);
            edits.push(TextEdit {
                start_line: line_index,
                start_column: 0,
                end_line: line_index,
                end_column: line.chars().count(),
                text: next,
            });
        }
    }

    edits.sort_by_key(|edit| (edit.start_line, edit.start_column));
    Ok(edits)
}

fn replace_line_matches(
    line: &str,
    matches: &[LargeFindMatch],
    matcher: &LargeMatcher,
    replacement: &str,
) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut next = String::new();
    let mut cursor = 0_usize;
    for item in matches {
        next.extend(chars[cursor..item.start_column].iter());
        next.push_str(&matcher.replace_text(&item.text, replacement));
        cursor = item.end_column;
    }
    next.extend(chars[cursor..].iter());
    next
}

fn large_find_match(line: &str, line_index: usize, start: usize, end: usize) -> LargeFindMatch {
    LargeFindMatch {
        line: line_index,
        start_column: byte_to_char_column(line, start),
        end_column: byte_to_char_column(line, end),
        text: line[start..end].to_string(),
        preview: line.chars().take(180).collect(),
    }
}

fn byte_to_char_column(value: &str, byte_index: usize) -> usize {
    value[..byte_index].chars().count()
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

fn scan_outline(path: &Path) -> Result<Vec<LargeOutlineItem>, String> {
    let file =
        File::open(path).map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let reader = BufReader::new(file);
    let mut outline = Vec::new();
    for (line_index, line) in reader.lines().enumerate() {
        let line = line.map_err(|err| format!("Failed to scan {}: {err}", path.display()))?;
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

fn apply_edit_to_lines(lines: &[String], edit: &TextEdit) -> String {
    let first = lines.first().map(String::as_str).unwrap_or("");
    let last = lines.last().map(String::as_str).unwrap_or("");
    let prefix = take_chars(first, edit.start_column);
    let suffix = skip_chars(last, edit.end_column);
    format!("{prefix}{}{suffix}", edit.text)
}

fn take_chars(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}

fn skip_chars(value: &str, count: usize) -> String {
    value.chars().skip(count).collect()
}

fn new_session_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("large-{millis}")
}

fn edits_overlap(a: &TextEdit, b: &TextEdit) -> bool {
    a.start_line <= b.end_line && b.start_line <= a.end_line
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
    use super::{similar_markdown_files, watch_path_key, write_text_file_safely};
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

    fn unique_test_dir(name: &str) -> PathBuf {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("lightmark-{name}-{millis}"))
    }
}
