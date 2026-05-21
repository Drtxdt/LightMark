use std::fs;
use std::path::{Path, PathBuf};

use rfd::FileDialog;

use super::models::FileNode;

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
