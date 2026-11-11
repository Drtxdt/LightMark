use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use image::ImageFormat;
use same_file::Handle;
use serde::Serialize;

#[derive(Clone, Default)]
struct ImageLocations {
    folders: HashSet<PathBuf>,
    files: HashSet<PathBuf>,
}

/// A grant belongs to one Markdown document for the lifetime of this application.
#[derive(Default)]
pub(super) struct ExportImages {
    documents: Mutex<HashMap<PathBuf, ImageLocations>>,
}

pub(super) fn export_images() -> &'static ExportImages {
    static ACCESS: OnceLock<ExportImages> = OnceLock::new();
    ACCESS.get_or_init(ExportImages::default)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImage {
    bytes: Vec<u8>,
    mime_type: &'static str,
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("无法定位 {}：{e}", path.display()))
}

impl ExportImages {
    pub(super) fn opened(&self, path: &Path) -> Result<(), String> {
        let doc = canonical(path)?;
        self.documents
            .lock()
            .map_err(|_| "图片授权不可用")?
            .entry(doc)
            .or_default();
        Ok(())
    }

    fn locations(&self, doc: &Path) -> Result<ImageLocations, String> {
        self.documents
            .lock()
            .map_err(|_| "图片授权不可用")?
            .get(doc)
            .cloned()
            .ok_or_else(|| "请重新打开或保存要导出的文档。".into())
    }

    pub(super) fn allow_folder(&self, document: &Path, folder: &Path) -> Result<(), String> {
        let dir = canonical(folder)?;
        if !dir.is_dir() {
            return Err(format!("不是图片目录：{}", folder.display()));
        }
        self.add_location(document, |locations| {
            locations.folders.insert(dir);
        })
    }

    pub(super) fn allow_file(&self, document: &Path, file: &Path) -> Result<(), String> {
        let file = canonical(file)?;
        self.add_location(document, |locations| {
            locations.files.insert(file);
        })
    }

    fn add_location(
        &self,
        document: &Path,
        add: impl FnOnce(&mut ImageLocations),
    ) -> Result<(), String> {
        let doc = canonical(document)?;
        let mut docs = self.documents.lock().map_err(|_| "图片授权不可用")?;
        let locations = docs.get_mut(&doc).ok_or("请先打开要授权的文档。")?;
        add(locations);
        Ok(())
    }

    pub(super) fn read(&self, document: &Path, reference: &str) -> Result<ExportImage, String> {
        let doc = canonical(document)?;
        let locations = self.locations(&doc)?;
        let root = doc.parent().ok_or("文档没有父目录。")?;
        let path = image_reference_path(root, reference)?;
        let resolved = canonical(&path)?;
        if !resolved.starts_with(root)
            && !locations.files.contains(&resolved)
            && !locations
                .folders
                .iter()
                .any(|folder| resolved.starts_with(folder))
        {
            return Err("图片位于文档目录外。请在导出菜单选择“允许导出图片目录”，或在 CLI 使用 --resource-root。".into());
        }
        if !fs::metadata(&resolved)
            .map_err(|e| e.to_string())?
            .is_file()
        {
            return Err("图片必须是普通文件。".into());
        }
        let mut file = File::open(&resolved).map_err(|e| format!("无法打开图片：{e}"))?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("图片必须是普通文件。".into());
        }
        // Read only the handle whose identity and resolved location we checked.
        let current = canonical(&path)?;
        let handle = Handle::from_file(file.try_clone().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if current != resolved
            || handle != Handle::from_path(&current).map_err(|e| e.to_string())?
        {
            return Err("图片在导出期间已更改，请重试。".into());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        let mime_type = image_mime(&bytes).ok_or("文件内容不是支持的图片格式。")?;
        Ok(ExportImage { bytes, mime_type })
    }
}

fn image_reference_path(root: &Path, reference: &str) -> Result<PathBuf, String> {
    if let Ok(url) = tauri::Url::parse(reference) {
        if url.scheme() == "file" {
            return url.to_file_path().map_err(|_| "本地图片 URL 无效。".into());
        }
        if url.scheme() == "asset" || url.host_str() == Some("asset.localhost") {
            let encoded = url.path().strip_prefix('/').unwrap_or(url.path());
            return Ok(root.join(super::export::percent_decode_path(encoded)?));
        }
        if matches!(url.scheme(), "http" | "https" | "tauri" | "ipc") {
            return Err("应用页面不能作为本地图片。".into());
        }
    }
    Ok(root.join(super::export::percent_decode_path(reference)?))
}

fn svg_text(bytes: &[u8]) -> Option<Cow<'_, str>> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let decode = if bytes[0] == 0xff {
            u16::from_le_bytes
        } else {
            u16::from_be_bytes
        };
        let pairs = bytes[2..].chunks_exact(2);
        if !pairs.remainder().is_empty() {
            return None;
        }
        let value: Result<String, _> =
            char::decode_utf16(pairs.map(|p| decode([p[0], p[1]]))).collect();
        return value.ok().map(Cow::Owned);
    }
    std::str::from_utf8(bytes)
        .ok()
        .map(|s| Cow::Borrowed(s.trim_start_matches('\u{feff}')))
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes) {
        Ok(ImageFormat::Png) => Some("image/png"),
        Ok(ImageFormat::Jpeg) => Some("image/jpeg"),
        Ok(ImageFormat::Gif) => Some("image/gif"),
        Ok(ImageFormat::WebP) => Some("image/webp"),
        Ok(ImageFormat::Bmp) => Some("image/bmp"),
        Ok(ImageFormat::Ico) => Some("image/x-icon"),
        Ok(ImageFormat::Avif) => Some("image/avif"),
        _ => is_svg(&svg_text(bytes)?).then_some("image/svg+xml"),
    }
}

fn is_svg(text: &str) -> bool {
    use quick_xml::events::Event;
    use quick_xml::name::{Namespace, ResolveResult};
    use quick_xml::NsReader;

    // A legacy SVG may declare an external DTD. Inspect XML events without
    // resolving entities or loading the DTD.
    let mut reader = NsReader::from_str(text);
    let mut seen_root = false;
    let mut depth = 0usize;
    while let Ok((namespace, event)) = reader.read_resolved_event() {
        match &event {
            Event::Start(element) | Event::Empty(element) => {
                if depth == 0 {
                    if seen_root
                        || element.local_name().as_ref() != b"svg"
                        || !matches!(
                            namespace,
                            ResolveResult::Unbound
                                | ResolveResult::Bound(Namespace(b"http://www.w3.org/2000/svg"))
                        )
                    {
                        return false;
                    }
                    seen_root = true;
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) if depth > 0 => depth -= 1,
            Event::End(_) => return false,
            Event::Text(t) if depth == 0 && !t.iter().all(u8::is_ascii_whitespace) => {
                return false
            }
            Event::CData(_) | Event::GeneralRef(_) if depth == 0 => return false,
            Event::Decl(_) | Event::DocType(_) if seen_root => return false,
            Event::Eof => return seen_root && depth == 0,
            _ => {}
        }
    }
    false
}
#[cfg(test)]
mod tests {
    use super::*;

    const COVER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8"/></svg>"#;

    #[test]
    fn exported_images_follow_the_open_document_and_explicit_choices() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("A");
        let b = dir.path().join("B");
        let shared = dir.path().join("shared");
        let other = dir.path().join("shared-other");
        for path in [&a, &b, &shared, &other] {
            fs::create_dir(path).unwrap();
        }
        let first = a.join("文章.md");
        let second = b.join("文章.md");
        for doc in [&first, &second] {
            fs::write(doc, "notes").unwrap();
        }
        fs::write(a.join("封 面.svg"), COVER).unwrap();
        fs::write(shared.join("cover.svg"), COVER).unwrap();
        fs::write(other.join("cover.svg"), COVER).unwrap();
        fs::write(a.join("broken.png"), "plain text").unwrap();
        let access = ExportImages::default();
        assert!(access.read(&first, "封%20面.svg").is_err());
        access.opened(&first).unwrap();
        access.opened(&second).unwrap();
        let original = access.read(&first, "封%20面.svg").unwrap();
        assert_eq!(original.bytes, COVER.as_bytes());
        assert_eq!(original.mime_type, "image/svg+xml");
        assert!(access.read(&first, "broken.png").is_err());
        let shared_reference = "../shared/cover.svg";
        assert!(access.read(&first, shared_reference).is_err());
        access.allow_folder(&first, &shared).unwrap();
        assert_eq!(
            access.read(&first, shared_reference).unwrap().bytes,
            COVER.as_bytes()
        );
        assert!(access.read(&first, "../shared-other/cover.svg").is_err());
        assert!(access.read(&second, shared_reference).is_err());
        access
            .allow_file(&second, &shared.join("cover.svg"))
            .unwrap();
        assert_eq!(
            access.read(&second, shared_reference).unwrap().mime_type,
            "image/svg+xml"
        );
        fs::write(shared.join("another.svg"), COVER).unwrap();
        assert!(access.read(&second, "../shared/another.svg").is_err());
    }

    #[test]
    fn exported_image_type_comes_from_the_file() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(1, 1)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        assert_eq!(image_mime(&png.into_inner()), Some("image/png"));
        let legacy = format!(
            r#"<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">{COVER}"#
        );
        assert_eq!(image_mime(legacy.as_bytes()), Some("image/svg+xml"));
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend(COVER.encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(image_mime(&utf16), Some("image/svg+xml"));
        assert_eq!(image_mime(b"<html><svg/></html>"), None);
    }
}

#[tauri::command(async)]
pub fn allow_export_image_folder(markdown_path: String) -> Result<Option<String>, String> {
    let doc = canonical(Path::new(&markdown_path))?;
    export_images().locations(&doc)?;
    let title = format!(
        "允许 {} 从所选目录及子目录导出图片（本次启动）",
        doc.file_name().unwrap_or_default().to_string_lossy()
    );
    let folder = rfd::FileDialog::new()
        .set_title(title)
        .set_directory(doc.parent().ok_or("文档没有父目录。")?)
        .pick_folder();
    let Some(folder) = folder else {
        return Ok(None);
    };
    export_images().allow_folder(&doc, &folder)?;
    Ok(Some(folder.to_string_lossy().into_owned()))
}
