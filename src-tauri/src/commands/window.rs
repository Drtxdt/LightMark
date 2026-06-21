use tauri::{Theme, Window};

const APP_NAME: &str = "LightMark";

#[tauri::command]
pub fn sync_window_chrome(window: Window, file_name: String, theme: String) -> Result<(), String> {
    let title = format_window_title(&file_name);
    window.set_title(&title).map_err(|error| error.to_string())?;

    let tauri_theme = if theme == "dark" {
        Theme::Dark
    } else {
        Theme::Light
    };
    window
        .set_theme(Some(tauri_theme))
        .map_err(|error| error.to_string())?;

    apply_titlebar_colors(&window, tauri_theme);
    Ok(())
}

pub(crate) fn format_window_title(file_name: &str) -> String {
    let trimmed = file_name.trim();
    if trimmed.is_empty() || trimmed == "未命名" {
        APP_NAME.to_string()
    } else {
        format!("{trimmed} - {APP_NAME}")
    }
}

pub(crate) fn colorref(red: u8, green: u8, blue: u8) -> u32 {
    u32::from(red) | (u32::from(green) << 8) | (u32::from(blue) << 16)
}

#[cfg(windows)]
fn apply_titlebar_colors(window: &Window, theme: Theme) {
    use std::{ffi::c_void, mem::size_of};
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let (caption, text, border) = match theme {
        Theme::Dark => (
            colorref(0x12, 0x12, 0x10),
            colorref(0xe8, 0xe5, 0xdf),
            colorref(0x24, 0x22, 0x1f),
        ),
        Theme::Light => (
            colorref(0xf5, 0xf3, 0xee),
            colorref(0x28, 0x25, 0x20),
            colorref(0xe6, 0xe1, 0xd8),
        ),
        _ => (
            colorref(0xf5, 0xf3, 0xee),
            colorref(0x28, 0x25, 0x20),
            colorref(0xe6, 0xe1, 0xd8),
        ),
    };

    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            &caption as *const _ as *const c_void,
            size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR,
            &text as *const _ as *const c_void,
            size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &border as *const _ as *const c_void,
            size_of::<u32>() as u32,
        );
    }
}

#[cfg(not(windows))]
fn apply_titlebar_colors(_window: &Window, _theme: Theme) {}

#[cfg(test)]
mod tests {
    use super::{colorref, format_window_title};

    #[test]
    fn formats_filename_window_title() {
        assert_eq!(format_window_title("demo.md"), "demo.md - LightMark");
        assert_eq!(format_window_title(""), "LightMark");
        assert_eq!(format_window_title("   "), "LightMark");
        assert_eq!(format_window_title("未命名"), "LightMark");
    }

    #[test]
    fn encodes_windows_colorref_as_bgr_order() {
        assert_eq!(colorref(0xf5, 0xf3, 0xee), 0x00eef3f5);
        assert_eq!(colorref(0x12, 0x12, 0x10), 0x00101212);
    }
}
