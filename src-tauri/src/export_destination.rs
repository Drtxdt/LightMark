//! File identity and publication policy shared by the CLI and desktop exporters.
use same_file::Handle;
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tempfile::{TempDir, TempPath};

pub struct ExportDestination {
    selected: PathBuf,
    resolved: PathBuf,
    source: PathBuf,
    source_id: Handle,
    previous: Option<Handle>,
}

impl ExportDestination {
    /// A native Save dialog has already confirmed replacement of an existing
    /// output. Explicit CLI destinations require --force for that same choice.
    pub fn new(source: &Path, selected: &Path, overwrite: bool) -> Result<Self, String> {
        let selected = std::path::absolute(selected).map_err(|e| e.to_string())?;
        let resolved = resolve_parent(&selected)?;
        let source_id = identity(source)?;
        let previous = existing_output(&resolved)?;
        if previous.as_ref() == Some(&source_id) {
            return Err("导出路径不能覆盖源 Markdown 文件。".into());
        }
        if previous.is_some() && !overwrite {
            return Err(format!(
                "导出文件已存在；请另选文件或使用 --force：{}",
                selected.display()
            ));
        }
        Ok(Self {
            selected,
            resolved,
            source: source.to_owned(),
            source_id,
            previous,
        })
    }

    pub fn path(&self) -> &Path {
        &self.selected
    }

    pub(crate) fn stage(self, extension: &str) -> Result<StagedExport, String> {
        // Writers (notably Pandoc) infer the format from the suffix. The public
        // output name is never passed to a renderer or opened for truncation.
        if extension.is_empty()
            || !extension
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err("导出扩展名无效。".into());
        }
        let directory = tempfile::Builder::new()
            .prefix(".lightmark-export-")
            .tempdir_in(
                self.resolved
                    .parent()
                    .expect("validated destination parent"),
            )
            .map_err(|e| format!("无法在导出目录暂存文件：{e}"))?;
        let path = directory.path().join(format!("result.{extension}"));
        Ok(StagedExport {
            destination: self,
            path,
            _directory: directory,
        })
    }
}

fn resolve_parent(path: &Path) -> Result<PathBuf, String> {
    let name = path.file_name().ok_or("导出路径必须指向文件。")?;
    let parent = path.parent().ok_or("导出路径缺少父目录。")?;
    let dir = fs::canonicalize(parent)
        .map_err(|e| format!("无法定位导出目录 {}：{e}", parent.display()))?;
    if !dir.is_dir() {
        return Err(format!("不是导出目录：{}", parent.display()));
    }
    Ok(dir.join(name))
}

fn identity(path: &Path) -> Result<Handle, String> {
    Handle::from_path(path).map_err(|e| format!("无法确认文件身份 {}：{e}", path.display()))
}

fn existing_output(path: &Path) -> Result<Option<Handle>, String> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_file() => identity(path).map(Some),
        Ok(_) => Err(format!(
            "导出目标不是普通文件，请另选路径：{}",
            path.display()
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("无法检查导出目标 {}：{e}", path.display())),
    }
}

pub(crate) struct StagedExport {
    destination: ExportDestination,
    path: PathBuf,
    _directory: TempDir,
}

impl StagedExport {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn commit(self) -> Result<PathBuf, String> {
        if !fs::symlink_metadata(self.path()).is_ok_and(|meta| meta.is_file()) {
            return Err("导出器没有生成可提交的文件。".into());
        }
        fs::OpenOptions::new()
            .write(true)
            .open(self.path())
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("无法完成暂存导出文件：{e}"))?;
        // Recheck after the potentially long render. Compare both the original
        // source handle and the file now at the source path, and never promote
        // an approval for a missing target to permission to replace a new one.
        let dest = self.destination;
        let current = existing_output(&dest.resolved)?;
        if current.as_ref() == Some(&dest.source_id)
            || current.as_ref() == Some(&identity(&dest.source)?)
        {
            return Err("导出路径不能覆盖源 Markdown 文件。".into());
        }
        if resolve_parent(dest.path())? != dest.resolved || current != dest.previous {
            return Err("导出期间目标文件或目录已变化，请重新选择。".into());
        }
        let overwrite = dest.previous.is_some();
        // Windows can rename an open file aside, yet refuses to replace its
        // directory entry while our verification handles still reference it.
        drop(current);
        drop(dest.previous);
        let staged = TempPath::try_from_path(self.path).map_err(|e| e.to_string())?;
        let result = if overwrite {
            staged.persist(&dest.resolved)
        } else {
            staged.persist_noclobber(&dest.resolved)
        };
        result.map_err(|e| format!("无法提交导出文件 {}：{}", dest.selected.display(), e.error))?;
        Ok(dest.selected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendering_never_opens_an_existing_output_for_writing() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("notes.md");
        let output = dir.path().join("report.html");
        fs::write(&input, "notes").unwrap();
        fs::write(&output, "previous report").unwrap();
        let dest = ExportDestination::new(&input, &output, true).unwrap();
        {
            let stage = dest.stage("html").unwrap();
            fs::write(stage.path(), "partial").unwrap();
        }
        assert_eq!(fs::read_to_string(&output).unwrap(), "previous report");
        let dest = ExportDestination::new(&input, &output, true).unwrap();
        let stage = dest.stage("html").unwrap();
        fs::write(stage.path(), "complete").unwrap();
        stage.commit().unwrap();
        assert_eq!(fs::read_to_string(&output).unwrap(), "complete");
        assert_eq!(fs::read_to_string(&input).unwrap(), "notes");
    }

    #[test]
    fn a_new_target_is_still_exclusive_at_publication_even_with_force() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("notes.md");
        let output = dir.path().join("report.html");
        fs::write(&input, "notes").unwrap();
        let dest = ExportDestination::new(&input, &output, true).unwrap();
        let stage = dest.stage("html").unwrap();
        fs::write(stage.path(), "new report").unwrap();
        fs::write(&output, "created while rendering").unwrap();
        assert!(stage.commit().is_err());
        assert_eq!(
            fs::read_to_string(&output).unwrap(),
            "created while rendering"
        );
    }

    #[test]
    fn replacing_the_chosen_target_with_a_source_alias_aborts_publication() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("notes.md");
        let output = dir.path().join("report.html");
        fs::write(&input, "notes").unwrap();
        fs::write(&output, "old").unwrap();
        let dest = ExportDestination::new(&input, &output, true).unwrap();
        let stage = dest.stage("html").unwrap();
        fs::write(stage.path(), "new report").unwrap();
        fs::rename(&output, dir.path().join("previous.html")).unwrap();
        fs::hard_link(&input, &output).unwrap();
        assert!(stage.commit().is_err());
        assert_eq!(fs::read_to_string(&input).unwrap(), "notes");
        assert_eq!(fs::read_to_string(&output).unwrap(), "notes");
    }
}
