use std::fs;
use std::path::PathBuf;

use rfd::FileDialog;

#[tauri::command]
pub fn export_html(path: String, html: String) -> Result<String, String> {
    let initial_name = PathBuf::from(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .map(|name| format!("{name}.html"))
        .unwrap_or_else(|| "LightMark.html".to_string());

    let Some(target) = FileDialog::new()
        .add_filter("HTML", &["html"])
        .set_file_name(&initial_name)
        .save_file()
    else {
        return Err("Export cancelled".to_string());
    };

    fs::write(&target, html)
        .map_err(|err| format!("Failed to export {}: {err}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}
