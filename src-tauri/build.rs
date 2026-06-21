fn main() {
    configure_windows_resource_compiler();
    tauri_build::build()
}

#[cfg(windows)]
fn configure_windows_resource_compiler() {
    if std::env::var_os("RC").is_some() {
        return;
    }
    if command_exists("rc.exe") {
        return;
    }
    if let Some(path) = find_windows_kit_rc() {
        println!("cargo:warning=Using Windows SDK resource compiler: {}", path.display());
        std::env::set_var("RC", path);
    }
}

#[cfg(not(windows))]
fn configure_windows_resource_compiler() {}

#[cfg(windows)]
fn command_exists(command: &str) -> bool {
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|path| path.join(command))
                .find(|candidate| candidate.is_file())
        })
        .is_some()
}

#[cfg(windows)]
fn find_windows_kit_rc() -> Option<std::path::PathBuf> {
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Program Files (x86)"));
    let bin_dir = program_files_x86.join("Windows Kits").join("10").join("bin");
    let arch = target_arch_folder();
    let mut versions = std::fs::read_dir(bin_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|file_type| file_type.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    versions
        .iter()
        .map(|version| version.join(arch).join("rc.exe"))
        .find(|candidate| candidate.is_file())
        .or_else(|| {
            versions
                .iter()
                .flat_map(|version| ["x64", "x86", "arm64"].map(move |folder| version.join(folder).join("rc.exe")))
                .find(|candidate| candidate.is_file())
        })
}

#[cfg(windows)]
fn target_arch_folder() -> &'static str {
    match std::env::var("TARGET").unwrap_or_default().as_str() {
        target if target.contains("aarch64") => "arm64",
        target if target.contains("i686") => "x86",
        _ => "x64",
    }
}
