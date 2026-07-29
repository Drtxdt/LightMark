use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rfd::FileDialog;
use regex::Regex;
use serde::{Deserialize, Serialize};
use image::{GenericImage, GenericImageView, RgbaImage};

use super::models::ExportSettings;

#[tauri::command]
pub fn read_export_resource(path: String) -> Result<Vec<u8>, String> {
    let normalized = path.strip_prefix(r"\\?\").unwrap_or(&path).replace('/', "\\");
    let source = PathBuf::from(normalized);
    if !source.is_file() {
        return Err(format!("导出资源不存在：{}", source.display()));
    }
    fs::read(&source).map_err(|err| format!("无法读取导出资源 {}：{err}", source.display()))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub target: String,
    pub current_path: String,
    pub title: String,
    pub markdown: String,
    pub html: Option<String>,
    pub plain_html: Option<String>,
    #[serde(default)]
    pub pandoc_markdown: Option<String>,
    #[serde(default)]
    pub pandoc_latex_header: Option<String>,
    #[serde(default)]
    pub raster_width: Option<u32>,
    #[serde(default)]
    pub raster_height: Option<u32>,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
    pub settings: ExportSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub format: String,
    pub used_pandoc_path: Option<String>,
    pub command: Option<String>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PandocStatus {
    pub available: bool,
    pub path: String,
    pub version: String,
    pub source: String,
}

const PANDOC_TIMEOUT: Duration = Duration::from_secs(120);

#[tauri::command]
pub async fn export_document(request: ExportRequest) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_document_blocking(request))
        .await
        .map_err(|err| format!("导出任务异常：{err}"))?
}

fn export_document_blocking(request: ExportRequest) -> Result<ExportResult, String> {
    match request.target.as_str() {
        "html" => export_text(
            &request.current_path,
            &request.target,
            "html",
            request.html.unwrap_or_default(),
            &request.settings,
            request.output_path.as_deref(),
            request.overwrite,
        ),
        "htmlPlain" => export_text(
            &request.current_path,
            &request.target,
            "html",
            request.plain_html.or(request.html).unwrap_or_default(),
            &request.settings,
            request.output_path.as_deref(),
            request.overwrite,
        ),
        "pdf" => export_html_pdf(request),
        "png" => export_html_png(request),
        _ => export_with_pandoc(request),
    }
}

fn export_html_png(request: ExportRequest) -> Result<ExportResult, String> {
    const TILE_HEIGHT: u32 = 16_000;
    const MAX_PIXELS: u64 = 100_000_000;
    let html = request
        .html
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "PNG 导出缺少 HTML 内容。".to_string())?;
    let Some(browser) = resolve_pdf_browser() else {
        return Err("未找到 Microsoft Edge、Chrome 或 Chromium，无法生成 PNG 长图。".to_string());
    };
    let width = request.raster_width.unwrap_or(900).clamp(320, 4096);
    let height = request.raster_height.unwrap_or(1).max(1);
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "PNG 尺寸超出支持范围。".to_string())?;
    if pixels > MAX_PIXELS {
        return Err(format!("PNG 长图共 {pixels} 像素，超过一亿像素安全上限。请缩短文档或改用 PDF。"));
    }
    let target_path = resolve_export_path(&request, "png")?;
    let profile_path = make_temp_dir("lightmark-edge-profile")?;
    let current_folder = PathBuf::from(&request.current_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let mut temp_paths: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<String, String> {
        let mut canvas = RgbaImage::new(width, height);
        let mut offset = 0_u32;
        let mut commands = Vec::new();
        while offset < height {
            let tile_height = TILE_HEIGHT.min(height - offset);
            // Headless `--screenshot` does not reliably wait for a scripted
            // scroll position. Shift the laid-out body instead so every tile
            // receives a deterministic slice of the same rendered document.
            let tile_html = html.replace(
                "</head>",
                &format!(
                    "<style>body{{position:relative!important;top:-{offset}px!important}}</style></head>"
                ),
            );
            let html_path = write_temp_html(&tile_html)?;
            let screenshot_path = make_temp_file_path("lightmark-export-tile", "png")?;
            temp_paths.push(html_path.clone());
            temp_paths.push(screenshot_path.clone());
            let args = vec![
                "--headless=new".to_string(),
                "--disable-gpu".to_string(),
                "--disable-extensions".to_string(),
                "--hide-scrollbars".to_string(),
                "--allow-file-access-from-files".to_string(),
                "--force-device-scale-factor=1".to_string(),
                "--run-all-compositor-stages-before-draw".to_string(),
                "--virtual-time-budget=3000".to_string(),
                format!("--user-data-dir={}", profile_path.to_string_lossy()),
                format!("--window-size={width},{tile_height}"),
                format!("--screenshot={}", screenshot_path.to_string_lossy()),
                path_to_file_url(&html_path),
            ];
            let command = format!("{} {}", browser.display(), args.join(" "));
            let output = run_process_with_timeout(&browser, &args, &current_folder, PANDOC_TIMEOUT)
                .map_err(|err| format!("无法完成 PNG 导出。\n命令：{command}\n{err}"))?;
            if !output.status.success() || !screenshot_path.is_file() {
                return Err(format!(
                    "PNG 分片渲染失败。\n命令：{command}\n{}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            let tile = image::open(&screenshot_path)
                .map_err(|err| format!("无法读取 PNG 分片 {}：{err}", screenshot_path.display()))?
                .to_rgba8();
            let copy_width = width.min(tile.width());
            let copy_height = tile_height.min(tile.height());
            canvas
                .copy_from(&tile.view(0, 0, copy_width, copy_height).to_image(), 0, offset)
                .map_err(|err| format!("无法合并 PNG 分片：{err}"))?;
            commands.push(command);
            offset += tile_height;
        }
        canvas
            .save_with_format(&target_path, image::ImageFormat::Png)
            .map_err(|err| format!("无法写入 PNG 文件 {}：{err}", target_path.display()))?;
        Ok(commands.join("\n"))
    })();
    for path in temp_paths {
        let _ = fs::remove_file(path);
    }
    let _ = fs::remove_dir_all(&profile_path);
    let command = result?;
    Ok(ExportResult {
        path: target_path.to_string_lossy().to_string(),
        format: request.target,
        used_pandoc_path: None,
        command: Some(command),
        stdout: None,
        stderr: None,
    })
}

#[tauri::command]
pub async fn save_export_bytes(
    current_path: String,
    target: String,
    extension: String,
    bytes: Vec<u8>,
    settings: ExportSettings,
) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || save_export_bytes_blocking(current_path, target, extension, bytes, settings))
        .await
        .map_err(|err| format!("导出任务异常：{err}"))?
}

fn save_export_bytes_blocking(
    current_path: String,
    target: String,
    extension: String,
    bytes: Vec<u8>,
    settings: ExportSettings,
) -> Result<ExportResult, String> {
    let Some(path) = choose_export_path(&current_path, &target, &extension, &settings) else {
        return Err("Export cancelled".to_string());
    };
    fs::write(&path, bytes).map_err(|err| format!("Failed to export {}: {err}", path.display()))?;
    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        format: target,
        used_pandoc_path: None,
        command: None,
        stdout: None,
        stderr: None,
    })
}

#[tauri::command]
pub fn detect_pandoc(settings: ExportSettings) -> PandocStatus {
    match resolve_pandoc(&settings) {
        Some((path, source)) => {
            let version = pandoc_version(&path).unwrap_or_else(|| "unknown".to_string());
            PandocStatus {
                available: true,
                path: path.to_string_lossy().to_string(),
                version,
                source,
            }
        }
        None => PandocStatus {
            available: false,
            path: String::new(),
            version: String::new(),
            source: "missing".to_string(),
        },
    }
}

fn export_text(
    current_path: &str,
    target: &str,
    extension: &str,
    content: String,
    settings: &ExportSettings,
    output_path: Option<&str>,
    overwrite: bool,
) -> Result<ExportResult, String> {
    let path = resolve_export_path_parts(
        current_path,
        target,
        extension,
        settings,
        output_path,
        overwrite,
    )?;
    fs::write(&path, content).map_err(|err| format!("Failed to export {}: {err}", path.display()))?;
    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        format: target.to_string(),
        used_pandoc_path: None,
        command: None,
        stdout: None,
        stderr: None,
    })
}

fn export_html_pdf(request: ExportRequest) -> Result<ExportResult, String> {
    let html = request
        .html
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "PDF 导出缺少 HTML 内容。".to_string())?;
    let Some(browser) = resolve_pdf_browser() else {
        return Err("未找到 Microsoft Edge、Chrome 或 Chromium，无法生成所见即所得 PDF。可以改用 PDF (Pandoc/LaTeX) 导出。".to_string());
    };
    let target_path = resolve_export_path(&request, "pdf")?;
    let temp_path = write_temp_html(html)?;
    let temp_pdf_path = make_temp_file_path("lightmark-export", "pdf")?;
    let profile_path = make_temp_dir("lightmark-edge-profile")?;
    let current_folder = PathBuf::from(&request.current_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let args = vec![
        "--headless=new".to_string(),
        "--disable-gpu".to_string(),
        "--disable-extensions".to_string(),
        "--no-pdf-header-footer".to_string(),
        "--run-all-compositor-stages-before-draw".to_string(),
        "--virtual-time-budget=3000".to_string(),
        format!("--user-data-dir={}", profile_path.to_string_lossy()),
        format!("--print-to-pdf={}", temp_pdf_path.to_string_lossy()),
        path_to_file_url(&temp_path),
    ];
    let command = format!("{} {}", browser.display(), args.join(" "));
    let output = run_process_with_timeout(&browser, &args, &current_folder, PANDOC_TIMEOUT)
        .map_err(|err| format!("无法完成 PDF 导出。\n命令：{command}\n{err}"))?;
    let _ = fs::remove_file(&temp_path);
    let _ = fs::remove_dir_all(&profile_path);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !temp_pdf_path.is_file() {
        return Err(format!("PDF 导出失败。\n命令：{command}\n{stderr}"));
    }
    fs::copy(&temp_pdf_path, &target_path)
        .map_err(|err| format!("无法写入 PDF 文件 {}：{err}", target_path.display()))?;
    let _ = fs::remove_file(&temp_pdf_path);
    Ok(ExportResult {
        path: target_path.to_string_lossy().to_string(),
        format: request.target,
        used_pandoc_path: None,
        command: Some(command),
        stdout: Some(stdout),
        stderr: Some(stderr),
    })
}

fn export_with_pandoc(request: ExportRequest) -> Result<ExportResult, String> {
    let Some((pandoc, _source)) = resolve_pandoc(&request.settings) else {
        return Err("未找到 Pandoc。请确认内置 Pandoc 已随应用打包，或在设置中配置 Pandoc 路径。".to_string());
    };
    let spec = pandoc_spec(&request)?;
    let target_path = resolve_export_path(&request, &spec.extension)?;
    let current_folder = PathBuf::from(&request.current_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let pandoc_source = request
        .pandoc_markdown
        .as_deref()
        .unwrap_or(&request.markdown);
    let markdown = prepare_markdown_for_pandoc(pandoc_source, &request.target);
    let (markdown, svg_temp_dir) =
        prepare_local_svg_images_for_pandoc(&markdown, &request.target, &current_folder)?;
    let temp_path = write_temp_markdown(&markdown)?;

    let mut args = vec![
        temp_path.to_string_lossy().to_string(),
        "--from".to_string(),
        "gfm+yaml_metadata_block+footnotes+task_lists+tex_math_dollars+raw_html".to_string(),
        "--resource-path".to_string(),
        current_folder.to_string_lossy().to_string(),
        "--metadata".to_string(),
        format!("title={}", request.title),
        "--standalone".to_string(),
        "-o".to_string(),
        target_path.to_string_lossy().to_string(),
    ];
    if let Some(format) = spec.to_format {
        args.push("--to".to_string());
        args.push(format);
    }
    args.extend(spec.extra_args);
    let latex_header_path = if matches!(request.target.as_str(), "pdfPandoc" | "latex") {
        request
            .pandoc_latex_header
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(write_temp_latex_header)
            .transpose()?
    } else {
        None
    };
    if let Some(path) = &latex_header_path {
        args.push("--include-in-header".to_string());
        args.push(path.to_string_lossy().to_string());
    }

    let command = format!("{} {}", pandoc.display(), args.join(" "));
    let output = run_process_with_timeout(&pandoc, &args, &current_folder, PANDOC_TIMEOUT)
        .map_err(|err| format!("无法完成 Pandoc 导出。\n命令：{command}\n{err}"));
    let _ = fs::remove_file(&temp_path);
    if let Some(path) = &latex_header_path {
        let _ = fs::remove_file(path);
    }
    if let Some(path) = &svg_temp_dir {
        let _ = fs::remove_dir_all(path);
    }
    let output = output?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        if stderr.contains("mhchem.sty") && stderr.contains("not found") {
            return Err(format!(
                "Pandoc PDF 导出缺少 LaTeX mhchem 宏包。请安装 mhchem，或改用 LightMark 原生 PDF 导出。\n命令：{command}\n{stderr}"
            ));
        }
        return Err(format!("Pandoc 导出失败。\n命令：{command}\n{stderr}"));
    }
    Ok(ExportResult {
        path: target_path.to_string_lossy().to_string(),
        format: request.target,
        used_pandoc_path: Some(pandoc.to_string_lossy().to_string()),
        command: Some(command),
        stdout: Some(stdout),
        stderr: Some(stderr),
    })
}

struct PandocSpec {
    extension: String,
    to_format: Option<String>,
    extra_args: Vec<String>,
}

fn pandoc_spec(request: &ExportRequest) -> Result<PandocSpec, String> {
    let settings = &request.settings;
    let mut extra_args = Vec::new();
    let (extension, to_format) = match request.target.as_str() {
        "pdfPandoc" => {
            let engine = if settings.pdf_engine.trim().is_empty() {
                "xelatex"
            } else {
                settings.pdf_engine.trim()
            };
            extra_args.push("--pdf-engine".to_string());
            extra_args.push(engine.to_string());
            if engine == "xelatex" || engine == "lualatex" {
                extra_args.push("-V".to_string());
                extra_args.push("CJKmainfont=Microsoft YaHei".to_string());
                extra_args.push("-V".to_string());
                extra_args.push("mainfont=Microsoft YaHei".to_string());
                extra_args.push("-V".to_string());
                extra_args.push("monofont=Consolas".to_string());
            }
            if !settings.pdf_paper_size.trim().is_empty() {
                extra_args.push("-V".to_string());
                extra_args.push(format!("papersize={}", settings.pdf_paper_size.trim()));
            }
            if !settings.pdf_margin.trim().is_empty() {
                extra_args.push("-V".to_string());
                extra_args.push(format!("margin={}", settings.pdf_margin.trim()));
            }
            ("pdf".to_string(), None)
        }
        "docx" => {
            if !settings.docx_reference_doc.trim().is_empty() {
                extra_args.push("--reference-doc".to_string());
                extra_args.push(settings.docx_reference_doc.trim().to_string());
            }
            ("docx".to_string(), Some("docx".to_string()))
        }
        "odt" => ("odt".to_string(), Some("odt".to_string())),
        "rtf" => ("rtf".to_string(), Some("rtf".to_string())),
        "epub" => {
            if !settings.epub_cover_image.trim().is_empty() {
                extra_args.push("--epub-cover-image".to_string());
                extra_args.push(settings.epub_cover_image.trim().to_string());
            }
            if !settings.epub_css.trim().is_empty() {
                extra_args.push("--css".to_string());
                extra_args.push(settings.epub_css.trim().to_string());
            }
            ("epub".to_string(), Some("epub3".to_string()))
        }
        "latex" => ("tex".to_string(), Some("latex".to_string())),
        "mediawiki" => ("wiki".to_string(), Some("mediawiki".to_string())),
        "rst" => ("rst".to_string(), Some("rst".to_string())),
        "textile" => ("textile".to_string(), Some("textile".to_string())),
        "opml" => ("opml".to_string(), Some("opml".to_string())),
        "revealjs" => {
            extra_args.push("-t".to_string());
            extra_args.push("revealjs".to_string());
            ("html".to_string(), None)
        }
        "markdownSpec" => ("md".to_string(), Some("markdown".to_string())),
        "customPandoc" => {
            let extension = normalize_extension(&settings.custom_pandoc_extension, "html");
            let to_format = if settings.custom_pandoc_format.trim().is_empty() {
                None
            } else {
                Some(settings.custom_pandoc_format.trim().to_string())
            };
            extra_args.extend(split_args(&settings.custom_pandoc_args)?);
            (extension, to_format)
        }
        _ => return Err(format!("不支持的导出格式：{}", request.target)),
    };
    Ok(PandocSpec {
        extension,
        to_format,
        extra_args,
    })
}

fn choose_export_path(
    current_path: &str,
    target: &str,
    extension: &str,
    settings: &ExportSettings,
) -> Option<PathBuf> {
    let stem = PathBuf::from(current_path)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("LightMark")
        .to_string();
    let extension = normalize_extension(extension, "html");
    let file_name = format!("{stem}.{extension}");
    let mut dialog = FileDialog::new()
        .add_filter(export_filter_name(target), &[extension.as_str()])
        .set_file_name(&file_name);

    if settings.default_folder == "sameFolder" {
        if let Some(parent) = PathBuf::from(current_path).parent() {
            dialog = dialog.set_directory(parent);
        }
    } else if settings.default_folder == "custom" && !settings.custom_folder.trim().is_empty() {
        dialog = dialog.set_directory(settings.custom_folder.trim());
    }

    dialog.save_file()
}

fn resolve_export_path(request: &ExportRequest, extension: &str) -> Result<PathBuf, String> {
    resolve_export_path_parts(
        &request.current_path,
        &request.target,
        extension,
        &request.settings,
        request.output_path.as_deref(),
        request.overwrite,
    )
}

fn resolve_export_path_parts(
    current_path: &str,
    target: &str,
    extension: &str,
    settings: &ExportSettings,
    output_path: Option<&str>,
    overwrite: bool,
) -> Result<PathBuf, String> {
    let Some(explicit) = output_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return choose_export_path(current_path, target, extension, settings)
            .ok_or_else(|| "Export cancelled".to_string());
    };
    let path = PathBuf::from(explicit);
    if path.is_dir() {
        return Err(format!("导出路径指向目录：{}", path.display()));
    }
    if path.exists() && !overwrite {
        return Err(format!("导出文件已存在；使用 --force 才能覆盖：{}", path.display()));
    }
    let parent = path.parent().filter(|value| !value.as_os_str().is_empty());
    if let Some(parent) = parent {
        if !parent.is_dir() {
            return Err(format!("导出目录不存在：{}", parent.display()));
        }
    }
    Ok(path)
}

fn export_filter_name(target: &str) -> &'static str {
    match target {
        "pdf" | "pdfPandoc" => "PDF",
        "docx" => "Word",
        "odt" => "OpenOffice",
        "rtf" => "RTF",
        "epub" => "EPUB",
        "png" => "PNG",
        "html" | "htmlPlain" | "revealjs" => "HTML",
        "latex" => "LaTeX",
        "opml" => "OPML",
        "rst" => "reStructuredText",
        "textile" => "Textile",
        "mediawiki" => "MediaWiki",
        _ => "Export",
    }
}

fn resolve_pandoc(settings: &ExportSettings) -> Option<(PathBuf, String)> {
    let custom = settings.pandoc_path.trim();
    if !custom.is_empty() {
        let path = PathBuf::from(custom);
        if is_file(&path) {
            return Some((path, "custom".to_string()));
        }
    }

    if settings.prefer_bundled_pandoc {
        for path in bundled_pandoc_candidates() {
            if is_file(&path) {
                return Some((path, "bundled".to_string()));
            }
        }
    }

    find_on_path("pandoc").map(|path| (path, "path".to_string()))
}

fn resolve_pdf_browser() -> Option<PathBuf> {
    for path in pdf_browser_candidates() {
        if is_file(&path) {
            return Some(path);
        }
    }
    find_on_path("msedge")
        .or_else(|| find_on_path("chrome"))
        .or_else(|| find_on_path("chromium"))
        .or_else(|| find_on_path("microsoft-edge"))
        .or_else(|| find_on_path("google-chrome"))
        .or_else(|| find_on_path("chromium-browser"))
}

fn pdf_browser_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(windows) {
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(program_files_x86).join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            let base = PathBuf::from(program_files);
            candidates.push(base.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
            candidates.push(base.join("Google").join("Chrome").join("Application").join("chrome.exe"));
        }
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local_app_data).join("Google").join("Chrome").join("Application").join("chrome.exe"));
        }
    }
    candidates
}

fn bundled_pandoc_candidates() -> Vec<PathBuf> {
    let exe_name = if cfg!(windows) { "pandoc.exe" } else { "pandoc" };
    let mut candidates = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(exe_name));
            candidates.push(parent.join("bin").join(exe_name));
            candidates.push(parent.join("resources").join(exe_name));
            candidates.push(parent.join("resources").join("bin").join(exe_name));
        }
    }
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("bin").join(exe_name));
        candidates.push(cwd.join("bin").join(exe_name));
    }
    candidates
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        format!("{program}.exe")
    } else {
        program.to_string()
    };
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|path| path.join(&executable))
            .find(|path| is_file(path))
    })
}

fn pandoc_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(|line| line.trim().to_string())
}

fn run_process_with_timeout(
    program: &Path,
    args: &[String],
    current_folder: &Path,
    timeout: Duration,
) -> Result<Output, String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(current_folder)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("无法启动进程：{err}"))?;
    let started = SystemTime::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                return child
                    .wait_with_output()
                    .map_err(|err| format!("无法读取 Pandoc 输出：{err}"));
            }
            Ok(None) => {
                if started.elapsed().unwrap_or_default() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("Pandoc 超过 {} 秒未完成，已终止。", timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(err) => {
                let _ = child.kill();
                return Err(format!("无法等待 Pandoc 结束：{err}"));
            }
        }
    }
}

fn prepare_markdown_for_pandoc(markdown: &str, target: &str) -> String {
    if target != "pdfPandoc" || !markdown.contains("$$") {
        return markdown.to_string();
    }

    let mut output = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find("$$") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find("$$") else {
            output.push_str(&rest[start..]);
            return output;
        };
        let math = &after_start[..end];
        output.push_str("$$");
        if contains_cjk(math) {
            output.push_str(&wrap_cjk_math_text(math));
        } else {
            output.push_str(math);
        }
        output.push_str("$$");
        rest = &after_start[end + 2..];
    }
    output.push_str(rest);
    output
}

fn prepare_local_svg_images_for_pandoc(
    markdown: &str,
    target: &str,
    current_folder: &Path,
) -> Result<(String, Option<PathBuf>), String> {
    // Pandoc delegates SVG conversion for LaTeX/PDF to rsvg-convert, which is
    // not normally present on Windows. Rasterize only this writer path; DOCX,
    // EPUB and HTML writers retain native SVG support.
    if target != "pdfPandoc" || !markdown.to_ascii_lowercase().contains(".svg") {
        return Ok((markdown.to_string(), None));
    }
    let image_pattern = Regex::new(r#"!\[([^\]]*)\]\((<[^>]+>|[^\s\)]+)([^\)]*)\)"#)
        .map_err(|err| format!("无法初始化 SVG 图片解析器：{err}"))?;
    let mut output = String::with_capacity(markdown.len());
    let mut last = 0;
    let mut temp_dir: Option<PathBuf> = None;
    let mut converted = 0_usize;

    for captures in image_pattern.captures_iter(markdown) {
        let full = captures.get(0).expect("full markdown image capture");
        let destination = captures.get(2).map(|value| value.as_str()).unwrap_or("");
        let clean_destination = destination.trim_matches(|ch| ch == '<' || ch == '>');
        if !clean_destination.to_ascii_lowercase().ends_with(".svg")
            || clean_destination.contains("://")
            || clean_destination.starts_with("data:")
        {
            continue;
        }
        let decoded = percent_decode_path(clean_destination)?;
        let source = {
            let path = PathBuf::from(decoded.replace('/', std::path::MAIN_SEPARATOR_STR));
            if path.is_absolute() { path } else { current_folder.join(path) }
        };
        if !source.is_file() {
            return Err(format!("Pandoc PDF 导出找不到本地 SVG：{}", source.display()));
        }
        let directory = match &temp_dir {
            Some(path) => path.clone(),
            None => {
                let path = make_temp_dir("lightmark-pandoc-svg")?;
                temp_dir = Some(path.clone());
                path
            }
        };
        let raster_path = directory.join(format!("image-{converted}.png"));
        if let Err(error) = rasterize_svg_to_png(&source, &raster_path) {
            if let Some(path) = &temp_dir {
                let _ = fs::remove_dir_all(path);
            }
            return Err(error);
        }
        output.push_str(&markdown[last..full.start()]);
        output.push_str("![");
        output.push_str(captures.get(1).map(|value| value.as_str()).unwrap_or(""));
        output.push_str("](");
        output.push('<');
        output.push_str(&raster_path.to_string_lossy().replace('\\', "/"));
        output.push('>');
        output.push_str(captures.get(3).map(|value| value.as_str()).unwrap_or(""));
        output.push(')');
        last = full.end();
        converted += 1;
    }
    if converted == 0 {
        return Ok((markdown.to_string(), None));
    }
    output.push_str(&markdown[last..]);
    Ok((output, temp_dir))
}

fn rasterize_svg_to_png(source: &Path, target: &Path) -> Result<(), String> {
    let data = fs::read(source)
        .map_err(|err| format!("无法读取本地 SVG {}：{err}", source.display()))?;
    let mut options = resvg::usvg::Options::default();
    options.fontdb_mut().load_system_fonts();
    let tree = resvg::usvg::Tree::from_data(&data, &options)
        .map_err(|err| format!("无法解析本地 SVG {}：{err}", source.display()))?;
    let intrinsic = tree.size();
    let longest = intrinsic.width().max(intrinsic.height()).max(1.0);
    let scale = (1600.0 / longest).clamp(1.0, 4.0);
    let width = (intrinsic.width() * scale).ceil().clamp(1.0, 4096.0) as u32;
    let height = (intrinsic.height() * scale).ceil().clamp(1.0, 4096.0) as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| format!("本地 SVG 尺寸超出支持范围：{}", source.display()))?;
    let transform = resvg::tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    pixmap
        .save_png(target)
        .map_err(|err| format!("无法生成 SVG 替代图片 {}：{err}", target.display()))
}

fn percent_decode_path(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(format!("SVG 路径包含无效 URL 编码：{value}"));
            }
            let high = decode_hex(bytes[index + 1]);
            let low = decode_hex(bytes[index + 2]);
            let (Some(high), Some(low)) = (high, low) else {
                return Err(format!("SVG 路径包含无效 URL 编码：{value}"));
            };
            output.push(high * 16 + low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| format!("SVG 路径不是有效 UTF-8：{value}"))
}

fn decode_hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn wrap_cjk_math_text(math: &str) -> String {
    let mut output = String::with_capacity(math.len() + 16);
    let mut chars = math.chars().peekable();
    while let Some(ch) = chars.next() {
        if is_cjk(ch) {
            output.push_str("\\text{");
            output.push(ch);
            while let Some(next) = chars.peek().copied() {
                if is_cjk(next) {
                    output.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            output.push('}');
        } else {
            output.push(ch);
        }
    }
    output
}

fn contains_cjk(value: &str) -> bool {
    value.chars().any(is_cjk)
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF)
}

fn write_temp_markdown(markdown: &str) -> Result<PathBuf, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("系统时间异常：{err}"))?
        .as_millis();
    let path = env::temp_dir().join(format!("lightmark-export-{millis}.md"));
    fs::write(&path, markdown).map_err(|err| format!("无法写入临时导出文件：{err}"))?;
    Ok(path)
}

fn write_temp_latex_header(header: &str) -> Result<PathBuf, String> {
    let path = make_temp_file_path("lightmark-math-header", "tex")?;
    fs::write(&path, header).map_err(|err| format!("无法写入临时 LaTeX header：{err}"))?;
    Ok(path)
}

fn write_temp_html(html: &str) -> Result<PathBuf, String> {
    let path = make_temp_file_path("lightmark-export", "html")?;
    fs::write(&path, html).map_err(|err| format!("无法写入临时导出文件：{err}"))?;
    Ok(path)
}

fn make_temp_file_path(prefix: &str, extension: &str) -> Result<PathBuf, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("系统时间异常：{err}"))?
        .as_millis();
    Ok(env::temp_dir().join(format!("{prefix}-{millis}.{extension}")))
}

fn make_temp_dir(prefix: &str) -> Result<PathBuf, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("系统时间异常：{err}"))?
        .as_millis();
    let path = env::temp_dir().join(format!("{prefix}-{millis}"));
    fs::create_dir_all(&path).map_err(|err| format!("无法创建临时目录：{err}"))?;
    Ok(path)
}

fn path_to_file_url(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let mut parts = normalized.split('/').map(percent_encode_file_url_part).collect::<Vec<_>>();
    if let Some(first) = parts.first_mut() {
        if first.ends_with("%3A") && first.len() == 4 {
            *first = first.replace("%3A", ":");
        }
    }
    format!("file:///{}", parts.join("/").trim_start_matches('/'))
}

fn percent_encode_file_url_part(part: &str) -> String {
    part.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect::<String>()
}

fn normalize_extension(value: &str, fallback: &str) -> String {
    let trimmed = value.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn split_args(value: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                args.push(current.clone());
                current.clear();
            }
            continue;
        }
        current.push(ch);
    }
    if quote.is_some() {
        return Err("Custom Pandoc 参数存在未闭合引号。".to_string());
    }
    if !current.is_empty() {
        args.push(current);
    }
    Ok(args)
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_cjk_text_in_pdf_math_blocks() {
        let markdown = "before\n$$总位数=行数\\times每行总位数$$\nafter";
        let prepared = prepare_markdown_for_pandoc(markdown, "pdfPandoc");

        assert!(prepared.contains("$$\\text{总位数}=\\text{行数}\\times\\text{每行总位数}$$"));
    }

    #[test]
    fn leaves_non_pdf_markdown_unchanged() {
        let markdown = "$$总位数=行数\\times每行总位数$$";

        assert_eq!(prepare_markdown_for_pandoc(markdown, "docx"), markdown);
    }

    #[test]
    fn builds_windows_file_url() {
        let url = path_to_file_url(Path::new("E:\\my docs\\导出.html"));

        assert_eq!(url, "file:///E:/my%20docs/%E5%AF%BC%E5%87%BA.html");
    }

    #[test]
    fn decodes_percent_encoded_svg_paths() {
        assert_eq!(
            percent_decode_path("assets/%E5%9B%BE%20%E7%89%87.svg").unwrap(),
            "assets/图 片.svg"
        );
    }

    #[test]
    fn leaves_remote_svg_images_for_pandoc() {
        let markdown = "![remote](https://example.com/image.svg)";
        let (prepared, temp) =
            prepare_local_svg_images_for_pandoc(markdown, "pdfPandoc", Path::new(".")).unwrap();
        assert_eq!(prepared, markdown);
        assert!(temp.is_none());
    }

    #[test]
    fn writes_and_cleans_math_latex_header() {
        let header = "\\usepackage[version=4]{mhchem}\n";
        let path = write_temp_latex_header(header).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), header);
        fs::remove_file(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn rasterizes_local_svg_images_for_pandoc_pdf() {
        let fixture = make_temp_dir("lightmark-svg-test").unwrap();
        let source = fixture.join("图 片.svg");
        fs::write(
            &source,
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20"><rect width="32" height="20" fill="#c88936"/></svg>"##,
        )
        .unwrap();
        let markdown = "![测试](<图%20片.svg> \"标题\")";
        let (prepared, generated) =
            prepare_local_svg_images_for_pandoc(markdown, "pdfPandoc", &fixture).unwrap();
        let generated = generated.expect("generated SVG raster directory");

        assert!(prepared.contains("image-0.png"));
        assert!(prepared.contains("\"标题\""));
        assert!(generated.join("image-0.png").is_file());
        let _ = fs::remove_dir_all(fixture);
        let _ = fs::remove_dir_all(generated);
    }
}
