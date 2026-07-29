use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::models::AppConfig;

const HEADLESS_ARG: &str = "--lightmark-headless-request";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessExportRequest {
    pub mode: String,
    pub input_path: String,
    pub output_path: Option<String>,
    pub target: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
    pub theme: Option<String>,
    pub math_numbering: Option<String>,
    pub config_path: Option<String>,
    pub response_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessExportPayload {
    pub request: HeadlessExportRequest,
    pub markdown: String,
    pub config: AppConfig,
}

#[tauri::command]
pub fn get_headless_export_request(app: AppHandle) -> Result<Option<HeadlessExportPayload>, String> {
    let Some(path) = request_file_from_args() else {
        return Ok(None);
    };
    let request = read_request(&path)?;
    trace_request(&request, "frontend requested payload");
    let markdown = fs::read_to_string(&request.input_path)
        .map_err(|error| format!("无法读取 Markdown {}：{error}", request.input_path))?;
    let config = read_config(&app, request.config_path.as_deref())?;
    Ok(Some(HeadlessExportPayload { request, markdown, config }))
}

#[tauri::command]
pub fn trace_headless_frontend(stage: String) {
    trace_headless(&format!("frontend: {stage}"));
}

#[tauri::command]
pub fn complete_headless_export(app: AppHandle, response: Value) -> Result<(), String> {
    let path = request_file_from_args().ok_or_else(|| "当前不是 CLI 导出进程。".to_string())?;
    let request = read_request(&path)?;
    trace_request(&request, "frontend completed request");
    let response_path = PathBuf::from(&request.response_path);
    if let Some(parent) = response_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 CLI 响应目录 {}：{error}", parent.display()))?;
    }
    fs::write(
        &response_path,
        serde_json::to_vec_pretty(&response).map_err(|error| format!("无法序列化 CLI 响应：{error}"))?,
    )
    .map_err(|error| format!("无法写入 CLI 响应 {}：{error}", response_path.display()))?;
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        app.exit(0);
    });
    Ok(())
}

fn trace_headless(message: &str) {
    let Some(path) = request_file_from_args() else {
        return;
    };
    if let Ok(request) = read_request(&path) {
        trace_request(&request, message);
    }
}

fn trace_request(request: &HeadlessExportRequest, message: &str) {
    let path = PathBuf::from(format!("{}.stage.log", request.response_path));
    let previous = fs::read_to_string(&path).unwrap_or_default();
    let _ = fs::write(path, format!("{previous}{message}\n"));
}

fn request_file_from_args() -> Option<PathBuf> {
    let mut args = env::args_os();
    while let Some(arg) = args.next() {
        if arg == HEADLESS_ARG {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn read_request(path: &Path) -> Result<HeadlessExportRequest, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("无法读取 CLI 请求 {}：{error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("无法解析 CLI 请求 {}：{error}", path.display()))
}

fn read_config(app: &AppHandle, custom_path: Option<&str>) -> Result<AppConfig, String> {
    let path = if let Some(path) = custom_path.map(str::trim).filter(|value| !value.is_empty()) {
        PathBuf::from(path)
    } else {
        app.path()
            .app_config_dir()
            .map_err(|error| format!("无法定位应用配置目录：{error}"))?
            .join("config.json")
    };
    if !path.is_file() {
        return Ok(AppConfig::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取配置 {}：{error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("无法解析配置 {}：{error}", path.display()))
}
