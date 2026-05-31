use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rfd::FileDialog;

use super::models::{
    DirtyState, FileChunk, FileInfo, FileNode, LargeFileSession, LargeOutlineItem, TextEdit,
};

const LARGE_FILE_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone)]
struct SessionState {
    path: PathBuf,
    size_bytes: u64,
    line_offsets: Vec<u64>,
    edits: Vec<TextEdit>,
    outline: Vec<LargeOutlineItem>,
}

static LARGE_SESSIONS: OnceLock<Mutex<HashMap<String, SessionState>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, SessionState>> {
    LARGE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
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
        session.edits.retain(|existing| !edits_overlap(existing, &edit));
        session.edits.push(edit);
    }
    session.edits.sort_by_key(|edit| (edit.start_line, edit.start_column));
    Ok(DirtyState {
        is_dirty: !session.edits.is_empty(),
        pending_edit_count: session.edits.len(),
    })
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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create folder {}: {err}", parent.display()))?;
    }
    fs::write(&path, content).map_err(|err| format!("Failed to write {}: {err}", path.display()))
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

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn scan_line_offsets(path: &Path) -> Result<Vec<u64>, String> {
    let file = File::open(path).map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
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

fn scan_outline(path: &Path) -> Result<Vec<LargeOutlineItem>, String> {
    let file = File::open(path).map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
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
