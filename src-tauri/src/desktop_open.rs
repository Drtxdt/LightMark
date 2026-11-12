use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct Inbox(Mutex<Vec<String>>);

fn markdown(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("md") || s.eq_ignore_ascii_case("markdown"))
}

pub fn receive(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let incoming: Vec<_> = paths
        .into_iter()
        .filter(|p| p.is_absolute() && markdown(p))
        .filter_map(|p| p.into_os_string().into_string().ok())
        .collect();
    if incoming.is_empty() {
        return;
    }
    app.state::<Inbox>().0.lock().unwrap().extend(incoming);
    let _ = app.emit("desktop-open-ready", ());
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn take_desktop_documents(inbox: tauri::State<'_, Inbox>) -> Vec<String> {
    std::mem::take(&mut *inbox.0.lock().unwrap())
}

#[cfg(any(windows, test))]
pub fn documents(args: impl IntoIterator<Item = String>, cwd: &std::path::Path) -> Vec<PathBuf> {
    let mut args = args.into_iter();
    let mut literal = false;
    let mut result = Vec::new();
    while let Some(arg) = args.next() {
        if !literal {
            if arg == "--" {
                literal = true;
                continue;
            }
            if arg == "--profile" {
                args.next();
                continue;
            }
            if arg == "--lightmark-headless-request"
                || arg.starts_with("--lightmark-headless-request=")
            {
                return Vec::new();
            }
            if arg.starts_with('-') {
                continue;
            }
        }
        let path = cwd.join(arg);
        if markdown(&path) {
            result.push(path);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_documents_preserve_paths_and_skip_profile_and_export_arguments() {
        let cwd = std::env::current_dir().unwrap();
        let parse = |args: &[&str]| documents(args.iter().map(|s| s.to_string()), &cwd);
        assert_eq!(
            parse(&[
                "--profile",
                "skip.md",
                "甲 稿.md",
                "b.MARKDOWN",
                "image.png",
                "--",
                "-note.md"
            ]),
            ["甲 稿.md", "b.MARKDOWN", "-note.md"].map(|p| cwd.join(p))
        );
        assert!(parse(&["a.md", "--lightmark-headless-request", "request.md"]).is_empty());
    }
}
