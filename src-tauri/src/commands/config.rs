use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use super::models::AppConfig;

const CONFIG_FILE: &str = "config.json";

#[tauri::command]
pub fn read_app_config(app: AppHandle) -> Result<AppConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read config {}: {err}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|err| format!("Failed to parse config {}: {err}", path.display()))
}

#[tauri::command]
pub fn write_app_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create config folder {}: {err}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(&config)
        .map_err(|err| format!("Failed to serialize config: {err}"))?;
    fs::write(&path, content)
        .map_err(|err| format!("Failed to write config {}: {err}", path.display()))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|err| format!("Failed to locate app config folder: {err}"))
}
