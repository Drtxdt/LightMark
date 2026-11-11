use std::ffi::OsString;

/// A public, persistent configuration profile. Names never become arbitrary paths.
pub fn profile_identifier(name: &str) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 48
        || !name.bytes().next().is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        || !name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("profile name must be 1–48 lowercase ASCII letters, digits or hyphens, starting with a letter or digit".into());
    }
    Ok(format!("com.lightmark.profile.{name}"))
}

pub fn select_profile(
    arguments: impl IntoIterator<Item = OsString>,
    environment: Option<OsString>,
) -> Result<Option<String>, String> {
    let mut arguments = arguments.into_iter();
    let mut selected = None;
    while let Some(argument) = arguments.next() {
        if argument == "--" { break; }
        let candidate = if argument == "--profile" {
            let value = arguments.next().ok_or("--profile requires a name")?;
            if value.to_string_lossy().starts_with("--") { return Err("--profile requires a name".into()); }
            Some(value)
        } else {
            if argument.to_str().is_none() && argument.to_string_lossy().starts_with("--profile=") {
                return Err("profile name must be valid ASCII".into());
            }
            argument.to_str().and_then(|value| value.strip_prefix("--profile=")).map(OsString::from)
        };
        if let Some(candidate) = candidate {
            if selected.is_some() { return Err("--profile may be specified only once".into()); }
            selected = Some(candidate);
        }
    }
    let selected = selected.or(environment);
    selected.map(|name| {
        let name = name.into_string().map_err(|_| "profile name must be valid ASCII")?;
        profile_identifier(&name)?;
        Ok(name)
    }).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<OsString> { values.iter().map(OsString::from).collect() }
    #[test] fn default_retains_production_identity() { assert_eq!(select_profile(args(&[]), None).unwrap(), None); }
    #[test] fn cli_selects_named_profile() { assert_eq!(select_profile(args(&["--profile", "work-1"]), None).unwrap().as_deref(), Some("work-1")); assert_eq!(profile_identifier("work-1").unwrap(), "com.lightmark.profile.work-1"); }
    #[test] fn environment_selects_same_profile() { assert_eq!(select_profile(args(&[]), Some("work-1".into())).unwrap().as_deref(), Some("work-1")); }
    #[test] fn cli_overrides_environment() { assert_eq!(select_profile(args(&["--profile=cli"]), Some("env".into())).unwrap().as_deref(), Some("cli")); }
    #[test] fn duplicate_cli_is_rejected() { assert!(select_profile(args(&["--profile", "a", "--profile=b"]), None).is_err()); }
    #[test] fn missing_value_is_rejected() { for values in [&["--profile"][..], &["--profile", "--headless-export-request"][..], &["--profile="][..]] { assert!(select_profile(args(values), None).is_err()); } }
    #[test] fn unsafe_names_never_become_paths_or_identifiers() { for name in ["", "../x", "a.b", "A", "a_b", "a/b", "a\\b", " a", "中文", "-name"] { assert!(profile_identifier(name).is_err(), "{name}"); } assert!(profile_identifier(&"a".repeat(49)).is_err()); }
    #[test] fn maximum_length_is_accepted() { assert!(profile_identifier(&"a".repeat(48)).is_ok()); }
    #[test] fn unrelated_headless_arguments_are_preserved() { assert_eq!(select_profile(args(&["--headless-export-request", "C:\\owned\\request.json", "--profile", "export"]), None).unwrap().as_deref(), Some("export")); }
    #[test] fn argument_terminator_is_respected() { assert_eq!(select_profile(args(&["--", "--profile", "literal"]), None).unwrap(), None); }
    #[test] fn invalid_environment_fails_closed() { assert!(select_profile(args(&[]), Some("../real".into())).is_err()); }
    #[cfg(windows)]
    #[test]
    fn malformed_joined_profile_fails_closed_without_default_or_environment_fallback() {
        use std::os::windows::ffi::OsStringExt;
        let mut argument: Vec<u16> = "--profile=".encode_utf16().collect();
        argument.push(0xd800);
        for environment in [None, Some(OsString::from("work"))] {
            assert!(select_profile([OsString::from_wide(&argument)], environment).is_err());
        }
    }
}
