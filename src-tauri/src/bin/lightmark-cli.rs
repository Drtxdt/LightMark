use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Parser)]
#[command(name = "lightmark-cli", version, about = "LightMark Markdown 命令行工具")]
struct Cli {
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Subcommand)]
enum CliCommand {
    /// 导出一个 Markdown 文件
    Export(ExportArgs),
    /// 检查数学公式与目标格式的导出兼容性
    Check(CheckArgs),
    /// 列出可用导出格式
    Formats {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args)]
struct ExportArgs {
    input: PathBuf,
    #[arg(long, short = 'f', value_name = "FORMAT")]
    format: String,
    #[arg(long, short = 'o')]
    output: Option<PathBuf>,
    #[arg(long)]
    force: bool,
    #[arg(long, value_enum)]
    theme: Option<CliTheme>,
    #[arg(long, value_enum)]
    math_numbering: Option<CliMathNumbering>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct CheckArgs {
    input: PathBuf,
    #[arg(long, short = 'f', value_name = "FORMAT")]
    format: Option<String>,
    #[arg(long, value_enum)]
    math_numbering: Option<CliMathNumbering>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Copy, ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
enum CliTheme {
    Light,
    Dark,
}

#[derive(Clone, Copy, ValueEnum, Serialize)]
enum CliMathNumbering {
    #[value(name = "none")]
    #[serde(rename = "none")]
    None,
    #[value(name = "ams-block")]
    #[serde(rename = "ams-block")]
    AmsBlock,
    #[value(name = "all-display")]
    #[serde(rename = "all-display")]
    AllDisplay,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct FormatSpec {
    name: &'static str,
    target: &'static str,
    extension: &'static str,
    requires_pandoc: bool,
    support: &'static str,
}

const FORMATS: &[FormatSpec] = &[
    format("pdf", "pdf", "pdf", false, "full"),
    format("html", "html", "html", false, "full"),
    format("html-plain", "htmlPlain", "html", false, "full"),
    format("png", "png", "png", false, "full"),
    format("pdf-pandoc", "pdfPandoc", "pdf", true, "dependency"),
    format("docx", "docx", "docx", true, "degraded"),
    format("odt", "odt", "odt", true, "degraded"),
    format("rtf", "rtf", "rtf", true, "degraded"),
    format("epub", "epub", "epub", true, "degraded"),
    format("latex", "latex", "tex", true, "dependency"),
    format("mediawiki", "mediawiki", "wiki", true, "degraded"),
    format("rst", "rst", "rst", true, "degraded"),
    format("textile", "textile", "textile", true, "degraded"),
    format("opml", "opml", "opml", true, "degraded"),
    format("revealjs", "revealjs", "html", true, "degraded"),
    format("markdown-spec", "markdownSpec", "md", true, "degraded"),
    format("custom-pandoc", "customPandoc", "html", true, "degraded"),
];

const fn format(
    name: &'static str,
    target: &'static str,
    extension: &'static str,
    requires_pandoc: bool,
    support: &'static str,
) -> FormatSpec {
    FormatSpec { name, target, extension, requires_pandoc, support }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessRequest {
    mode: &'static str,
    input_path: String,
    output_path: Option<String>,
    target: Option<String>,
    overwrite: bool,
    theme: Option<CliTheme>,
    math_numbering: Option<CliMathNumbering>,
    config_path: Option<String>,
    response_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessResponse {
    ok: bool,
    code: i32,
    message: String,
    output_path: Option<String>,
    #[serde(flatten)]
    rest: serde_json::Map<String, Value>,
}

fn main() -> ExitCode {
    let result = match Cli::parse().command {
        CliCommand::Formats { json } => print_formats(json),
        CliCommand::Export(args) => run_export(args),
        CliCommand::Check(args) => run_check(args),
    };
    ExitCode::from(result.clamp(0, 255) as u8)
}

fn print_formats(as_json: bool) -> i32 {
    if as_json {
        println!("{}", serde_json::to_string_pretty(FORMATS).unwrap_or_else(|_| "[]".to_string()));
    } else {
        println!("{:<18} {:<8} {}", "格式", "扩展名", "数学兼容性");
        for spec in FORMATS {
            println!("{:<18} .{:<7} {}", spec.name, spec.extension, spec.support);
        }
    }
    0
}

fn run_export(args: ExportArgs) -> i32 {
    let Some(spec) = find_format(&args.format) else {
        eprintln!("不支持的导出格式：{}。运行 lightmark-cli formats 查看可用格式。", args.format);
        return 2;
    };
    let input = match validate_input(&args.input) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    let output = match resolve_output(&input, args.output.as_deref(), spec.extension, args.force) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    let config = match validate_optional_file(args.config.as_deref(), "配置文件") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    run_headless(
        HeadlessRequest {
            mode: "export",
            input_path: path_string(&input),
            output_path: Some(path_string(&output)),
            target: Some(spec.target.to_string()),
            overwrite: args.force,
            theme: args.theme,
            math_numbering: args.math_numbering,
            config_path: config.as_ref().map(|path| path_string(path)),
            response_path: String::new(),
        },
        args.json,
    )
}

fn run_check(args: CheckArgs) -> i32 {
    let input = match validate_input(&args.input) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    let target = match args.format {
        Some(value) => match find_format(&value) {
            Some(spec) => Some(spec.target.to_string()),
            None => {
                eprintln!("不支持的导出格式：{value}。");
                return 2;
            }
        },
        None => None,
    };
    let config = match validate_optional_file(args.config.as_deref(), "配置文件") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    run_headless(
        HeadlessRequest {
            mode: "check",
            input_path: path_string(&input),
            output_path: None,
            target,
            overwrite: false,
            theme: None,
            math_numbering: args.math_numbering,
            config_path: config.as_ref().map(|path| path_string(path)),
            response_path: String::new(),
        },
        args.json,
    )
}

fn run_headless(mut request: HeadlessRequest, as_json: bool) -> i32 {
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
    );
    let temp = env::temp_dir();
    let request_path = temp.join(format!("lightmark-cli-request-{nonce}.json"));
    let response_path = temp.join(format!("lightmark-cli-response-{nonce}.json"));
    let stage_path = PathBuf::from(format!("{}.stage.log", response_path.display()));
    request.response_path = path_string(&response_path);
    if let Err(error) = fs::write(
        &request_path,
        serde_json::to_vec_pretty(&request).unwrap_or_default(),
    ) {
        eprintln!("无法创建 CLI 请求：{error}");
        return 5;
    }

    let app = match locate_desktop_binary() {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_file(&request_path);
            eprintln!("{error}");
            return 4;
        }
    };
    let mut child = match Command::new(&app)
        .arg("--lightmark-headless-request")
        .arg(&request_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(&request_path);
            eprintln!("无法启动隐藏的 LightMark 渲染进程 {}：{error}", app.display());
            return 4;
        }
    };

    let deadline = Instant::now() + Duration::from_secs(180);
    let mut reported_stages = 0usize;
    loop {
        if !as_json {
            if let Ok(stages) = fs::read_to_string(&stage_path) {
                let lines = stages.lines().collect::<Vec<_>>();
                for line in lines.iter().skip(reported_stages) {
                    eprintln!("[LightMark] {line}");
                }
                reported_stages = lines.len();
            }
        }
        if response_path.is_file() {
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) if !response_path.is_file() => {
                let _ = fs::remove_file(&request_path);
                let _ = fs::remove_file(&stage_path);
                eprintln!("LightMark 渲染进程提前退出：{status}");
                return 5;
            }
            Ok(_) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = fs::remove_file(&request_path);
                let _ = fs::remove_file(&stage_path);
                eprintln!("无法等待 LightMark 渲染进程：{error}");
                return 5;
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&request_path);
            let _ = fs::remove_file(&response_path);
            let _ = fs::remove_file(&stage_path);
            eprintln!("LightMark 导出超过 180 秒，已终止。");
            return 5;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.wait();
    let response_bytes = fs::read(&response_path);
    let _ = fs::remove_file(&request_path);
    let _ = fs::remove_file(&response_path);
    let _ = fs::remove_file(&stage_path);
    let response: HeadlessResponse = match response_bytes
        .map_err(|error| error.to_string())
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
    {
        Ok(response) => response,
        Err(error) => {
            eprintln!("无法读取 LightMark CLI 响应：{error}");
            return 5;
        }
    };

    if as_json {
        let mut value = response.rest;
        value.insert("ok".to_string(), json!(response.ok));
        value.insert("code".to_string(), json!(response.code));
        value.insert("message".to_string(), json!(response.message));
        value.insert("outputPath".to_string(), json!(response.output_path));
        println!("{}", serde_json::to_string_pretty(&Value::Object(value)).unwrap_or_default());
    } else if response.ok {
        println!("{}", response.output_path.as_deref().unwrap_or(&response.message));
    } else {
        eprintln!("{}", response.message);
    }
    response.code
}

fn validate_input(path: &Path) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path)
        .map_err(|error| format!("无法读取输入文件 {}：{error}", path.display()))?;
    if !path.is_file() {
        return Err(format!("输入路径不是文件：{}", path.display()));
    }
    Ok(path)
}

fn validate_optional_file(path: Option<&Path>, label: &str) -> Result<Option<PathBuf>, String> {
    path.map(|value| {
        let canonical = fs::canonicalize(value)
            .map_err(|error| format!("无法读取{label} {}：{error}", value.display()))?;
        if !canonical.is_file() {
            return Err(format!("{label}不是文件：{}", canonical.display()));
        }
        Ok(canonical)
    }).transpose()
}

fn resolve_output(input: &Path, output: Option<&Path>, extension: &str, force: bool) -> Result<PathBuf, String> {
    let path = output
        .map(Path::to_path_buf)
        .unwrap_or_else(|| input.with_extension(extension));
    let path = if path.is_absolute() {
        path
    } else {
        env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(path)
    };
    if path == input {
        return Err("导出路径不能覆盖源 Markdown 文件。".to_string());
    }
    if path.exists() && !force {
        return Err(format!("导出文件已存在；使用 --force 才能覆盖：{}", path.display()));
    }
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            return Err(format!("导出目录不存在：{}", parent.display()));
        }
    }
    Ok(path)
}

fn find_format(name: &str) -> Option<&'static FormatSpec> {
    FORMATS.iter().find(|format| format.name.eq_ignore_ascii_case(name.trim()))
}

fn locate_desktop_binary() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("LIGHTMARK_APP_BINARY") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
    }
    let current = env::current_exe().map_err(|error| format!("无法定位 CLI 程序：{error}"))?;
    let parent = current.parent().unwrap_or_else(|| Path::new("."));
    let candidates = if cfg!(windows) {
        vec![parent.join("lightmark.exe"), parent.join("LightMark.exe")]
    } else {
        vec![parent.join("lightmark"), parent.join("LightMark")]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file() && path != &current)
        .ok_or_else(|| "未找到同目录 LightMark 桌面程序；可用 LIGHTMARK_APP_BINARY 指定路径。".to_string())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}
