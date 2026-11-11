use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use super::models::AppConfig;

const CONFIG_FILE: &str = "config.json";
const PREVIOUS_CONFIG_FILE: &str = "config.previous.json";
static CONFIG_WRITER: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn read_app_config(app: AppHandle) -> Result<AppConfig, String> {
    load(&config_path(&app)?)
}

#[tauri::command]
pub fn write_app_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    save(&config_path(&app)?, &config)
}

fn load(path: &Path) -> Result<AppConfig, String> {
    match fs::read(path) {
        Ok(bytes) => parse(path, &bytes),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            ensure_first_run(path)?;
            Ok(AppConfig::default())
        }
        Err(e) => Err(format!("无法读取设置 {}：{e}", path.display())),
    }
}

fn parse(path: &Path, bytes: &[u8]) -> Result<AppConfig, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("无法解析设置 {}：{e}", path.display()))
}

fn ensure_first_run(path: &Path) -> Result<(), String> {
    let previous = path.with_file_name(PREVIOUS_CONFIG_FILE);
    match fs::symlink_metadata(&previous) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(format!(
            "设置文件缺失，上一份设置仍保存在 {}。",
            previous.display()
        )),
        Err(e) => Err(format!("无法检查设置备份 {}：{e}", previous.display())),
    }
}

fn save(path: &Path, config: &AppConfig) -> Result<(), String> {
    let _writer = CONFIG_WRITER.lock().map_err(|_| "设置写入锁不可用。")?;
    let dir = path.parent().ok_or("设置目录不存在。")?;
    fs::create_dir_all(dir).map_err(|e| format!("无法创建设置目录 {}：{e}", dir.display()))?;
    let next = serde_json::to_vec_pretty(config).map_err(|e| format!("无法序列化设置：{e}"))?;
    let previous = match fs::read(path) {
        Ok(bytes) => {
            parse(path, &bytes)?; // Leave a corrupt primary and the last good backup intact.
            if bytes == next {
                return Ok(());
            }
            Some(bytes)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            ensure_first_run(path)?;
            None
        }
        Err(e) => return Err(format!("无法检查原设置 {}：{e}", path.display())),
    };
    let stage = |bytes: &[u8]| -> std::io::Result<tempfile::NamedTempFile> {
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        Ok(file)
    };
    let candidate = stage(&next).map_err(|e| format!("无法暂存新设置：{e}"))?;
    if let Some(old) = previous {
        stage(&old)
            .and_then(|file| {
                file.persist(dir.join(PREVIOUS_CONFIG_FILE))
                    .map_err(|e| e.error)
            })
            .map_err(|e| format!("无法保存上一份有效设置，原设置未更改：{e}"))?;
        candidate.persist(path)
    } else {
        candidate.persist_noclobber(path)
    }
    .map_err(|e| format!("无法提交设置 {}：{}", path.display(), e.error))?;
    Ok(())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|err| format!("Failed to locate app config folder: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_rotation_and_corruption_preserve_the_last_good_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        let backup = dir.path().join(PREVIOUS_CONFIG_FILE);
        let mut cfg = load(&path).unwrap();
        assert!(!path.exists());
        cfg.recent_files = vec!["one.md".into()];
        save(&path, &cfg).unwrap();
        let first = fs::read(&path).unwrap();
        assert!(!backup.exists());
        cfg.recent_files = vec!["two.md".into()];
        save(&path, &cfg).unwrap();
        assert_eq!(load(&path).unwrap().recent_files, cfg.recent_files);
        save(&path, &cfg).unwrap(); // No-op must not displace the backup.
        assert_eq!(fs::read(&backup).unwrap(), first);
        fs::write(&path, b"{broken").unwrap();
        assert!(load(&path).is_err());
        assert!(save(&path, &AppConfig::default()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        assert_eq!(fs::read(&backup).unwrap(), first);
        fs::remove_file(&path).unwrap();
        assert!(load(&path).is_err());
        assert!(save(&path, &AppConfig::default()).is_err());
        assert!(!path.exists());
        assert_eq!(fs::read(&backup).unwrap(), first);
    }

    #[test]
    fn failure_to_update_the_backup_leaves_primary_bytes_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        let mut config = AppConfig::default();
        save(&path, &config).unwrap();
        let original = fs::read(&path).unwrap();
        fs::create_dir(dir.path().join(PREVIOUS_CONFIG_FILE)).unwrap();
        config.recent_files.push("changed.md".into());
        assert!(save(&path, &config).is_err());
        assert_eq!(fs::read(path).unwrap(), original);
    }
}
