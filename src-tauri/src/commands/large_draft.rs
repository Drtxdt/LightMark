//! Independent large-file draft snapshots.
//!
//! A draft snapshot is a private, immutable payload plus a small manifest. It
//! is deliberately separate from a live large-file session: capture streams
//! the current view into a new directory, and open copies that payload into a
//! new session-owned base. The copy on open means deleting the draft cannot
//! invalidate the recovered session and changing the original source cannot
//! change either payload.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::file::{
    clone_large_session_for_draft, register_recovered_large_session,
    verify_large_session_for_draft, LargeDraftCaptureSource,
};
use super::large_file_base::{FileBaseSnapshot, SourceFingerprint};
use super::persistent_text::SegmentedTextView;
use super::models::{
    LargeCoordinateSpace, LargeDraftCaptureReceipt, LargeDraftDeleteReceipt, LargeDraftOpenReceipt,
    LargeDraftSnapshotRef, LargeFileError, LargeFileFingerprint,
};

const IO_CHUNK_SIZE: usize = 64 * 1024;
const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const DRAFT_ROOT_NAME: &str = "large-file-drafts";
const PAYLOAD_NAME: &str = "payload";
const PAYLOAD_TEMP_NAME: &str = "payload.tmp";
const MANIFEST_NAME: &str = "manifest.json";
const MANIFEST_NEXT_NAME: &str = "manifest.next";

static NEXT_SNAPSHOT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftManifestRecord {
    schema_version: u32,
    snapshot_id: String,
    draft_id: String,
    origin_path: String,
    origin_fingerprint: LargeFileFingerprint,
    captured_revision: u64,
    coordinate_space: LargeCoordinateSpace,
    byte_length: u64,
    total_lines: usize,
    sha256: String,
    payload: String,
    stage: String,
}

struct HashingWriter {
    file: File,
    hasher: Sha256,
    bytes: u64,
}

impl HashingWriter {
    fn new(file: File) -> Self {
        Self {
            file,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (File, u64, String) {
        let digest = self.hasher.finalize();
        let sha256 = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        (self.file, self.bytes, sha256)
    }
}

impl Write for HashingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.file.write(bytes)?;
        self.hasher.update(&bytes[..written]);
        self.bytes = self.bytes.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// Capture the current session view into a private immutable draft snapshot.
#[tauri::command(async)]
pub fn capture_large_file_draft(
    app: AppHandle,
    session_id: String,
    draft_id: String,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<LargeDraftCaptureReceipt, LargeFileError> {
    let root = draft_root(&app)?;
    capture_large_file_draft_at_root(
        &session_id,
        &draft_id,
        expected_revision,
        coordinate_space,
        &root,
    )
}

/// Testable root-explicit entry point. The production command supplies the
/// application-local root and does not allow a caller-provided path.
pub(crate) fn capture_large_file_draft_at_root(
    session_id: &str,
    draft_id: &str,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
    root: &Path,
) -> Result<LargeDraftCaptureReceipt, LargeFileError> {
    let source = clone_large_session_for_draft(session_id, expected_revision, coordinate_space)?;
    capture_large_file_draft_inner(source, draft_id, coordinate_space, root, None)
}

#[cfg(test)]
fn capture_large_file_draft_at_root_with_hook(
    session_id: &str,
    draft_id: &str,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
    root: &Path,
    hook: impl FnOnce(&str) + Send + 'static,
) -> Result<LargeDraftCaptureReceipt, LargeFileError> {
    let source = clone_large_session_for_draft(session_id, expected_revision, coordinate_space)?;
    capture_large_file_draft_inner(
        source,
        draft_id,
        coordinate_space,
        root,
        Some(Box::new(hook)),
    )
}

fn capture_large_file_draft_inner(
    source: LargeDraftCaptureSource,
    draft_id: &str,
    coordinate_space: LargeCoordinateSpace,
    root: &Path,
    #[cfg_attr(not(test), allow(unused_variables))] before_publish: Option<
        Box<dyn FnOnce(&str) + Send>,
    >,
) -> Result<LargeDraftCaptureReceipt, LargeFileError> {
    validate_coordinate_space(coordinate_space)?;
    validate_draft_id(draft_id)
        .map_err(|message| LargeFileError::new("invalid-draft-id", message))?;

    let root = prepare_directory(root, "large draft root")?;
    let snapshot_id = next_snapshot_id();
    let snapshot_dir = create_snapshot_directory(&root, &snapshot_id)?;
    let payload_temp = snapshot_dir.join(PAYLOAD_TEMP_NAME);
    let payload = snapshot_dir.join(PAYLOAD_NAME);

    let (byte_length, sha256) = match stream_view_to_payload(&source.view, &payload_temp) {
        Ok(value) => value,
        Err(error) => {
            return Err(with_recovery_artifact(
                LargeFileError::new("large-draft-capture-failed", error),
                &snapshot_dir,
            ))
        }
    };
    if let Err(error) = fs::rename(&payload_temp, &payload) {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-publish-failed",
                format!(
                    "failed to finalize draft payload {}: {error}",
                    payload.display()
                ),
            ),
            &snapshot_dir,
        ));
    }

    let actual = match fingerprint_path(&payload) {
        Ok(value) => value,
        Err(error) => return Err(with_recovery_artifact(error, &snapshot_dir)),
    };
    if actual.size_bytes != byte_length || actual.sha256_hex() != sha256 {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-fingerprint-mismatch",
                "draft payload changed while it was being finalized",
            ),
            &snapshot_dir,
        ));
    }

    let snapshot = LargeDraftSnapshotRef {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        snapshot_id: snapshot_id.clone(),
        draft_id: draft_id.to_string(),
        origin_path: source.origin_path.to_string_lossy().into_owned(),
        origin_fingerprint: fingerprint_model(&source.origin_fingerprint),
        captured_revision: source.revision,
        coordinate_space,
        byte_length,
        total_lines: source.view.line_count(),
        sha256: sha256.clone(),
    };
    let manifest = DraftManifestRecord::from_snapshot(&snapshot, "payload-ready");
    if let Err(error) = write_manifest(&snapshot_dir.join(MANIFEST_NAME), &manifest) {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-manifest-failed",
                format!("failed to publish draft manifest: {error}"),
            ),
            &snapshot_dir,
        ));
    }

    // The payload and its manifest are already immutable recovery material.
    // The final session check gates the receipt publication. If the session
    // closes or changes during capture, the caller gets an explicit error but
    // can still recover this independent payload by snapshot id.
    #[cfg(test)]
    if let Some(hook) = before_publish {
        hook(&source.session_id);
    }
    #[cfg(not(test))]
    let _ = before_publish;
    if let Err(error) = verify_large_session_for_draft(&source) {
        return Err(with_recovery_artifact(error, &snapshot_dir));
    }

    Ok(LargeDraftCaptureReceipt {
        session_id: source.session_id,
        requested_revision: source.revision,
        current_revision: source.revision,
        snapshot,
    })
}

/// Open an immutable draft payload as a new large-file session. The returned
/// session has no target path and must go through Save As before normal save.
#[tauri::command(async)]
pub fn open_large_file_draft(
    app: AppHandle,
    snapshot_id: String,
) -> Result<LargeDraftOpenReceipt, LargeFileError> {
    let draft_root = draft_root(&app)?;
    let opened_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| {
            LargeFileError::new(
                "snapshot-root-unavailable",
                format!("failed to resolve the application local data directory: {error}"),
            )
        })?
        .join("large-file-snapshots");
    open_large_file_draft_at_roots(&snapshot_id, &draft_root, &opened_root)
}

pub(crate) fn open_large_file_draft_at_roots(
    snapshot_id: &str,
    draft_root: &Path,
    opened_root: &Path,
) -> Result<LargeDraftOpenReceipt, LargeFileError> {
    validate_snapshot_id(snapshot_id)
        .map_err(|message| LargeFileError::new("invalid-snapshot-id", message))?;
    let draft_root = resolve_existing_directory(draft_root, "large draft root")?;
    let snapshot_dir = resolve_snapshot_directory(&draft_root, snapshot_id)?;
    let manifest_path = snapshot_dir.join(MANIFEST_NAME);
    let manifest = read_manifest(&manifest_path, &snapshot_dir)?;
    validate_manifest(&manifest, snapshot_id, &snapshot_dir)?;

    let payload = snapshot_dir.join(PAYLOAD_NAME);
    let payload_fingerprint = match fingerprint_path(&payload) {
        Ok(value) => value,
        Err(error) => return Err(with_recovery_artifact(error, &snapshot_dir)),
    };
    if payload_fingerprint.size_bytes != manifest.byte_length
        || payload_fingerprint.sha256_hex() != manifest.sha256
    {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-integrity-failed",
                "draft payload length or SHA-256 does not match its manifest",
            ),
            &snapshot_dir,
        ));
    }

    let opened_root = prepare_directory(opened_root, "opened large snapshot root")?;
    let owner_id = format!("recovered-{}-{}", snapshot_id, next_sequence());
    let base = FileBaseSnapshot::create_from_stable_owned_file(
        &payload,
        Path::new(""),
        &opened_root,
        &owner_id,
    )
    .map_err(|error| {
        with_recovery_artifact(
            LargeFileError::new("large-draft-open-failed", error.to_string()),
            &snapshot_dir,
        )
    })?;
    if base.size_bytes() != manifest.byte_length
        || base.fingerprint().sha256_hex() != manifest.sha256
    {
        let base_dir = base.snapshot_dir().to_path_buf();
        let mut error = LargeFileError::new(
            "large-draft-integrity-failed",
            "opened snapshot base does not match the draft manifest",
        )
        .with_recovery_artifact(snapshot_dir.to_string_lossy());
        if let Err(cleanup) = base.cleanup() {
            error = error
                .with_recovery_artifact(base_dir.to_string_lossy())
                .with_cleanup_warning(cleanup.to_string());
        }
        return Err(error);
    }

    let base = std::sync::Arc::new(base);
    let view = SegmentedTextView::new(std::sync::Arc::clone(&base));
    if view.line_count() != manifest.total_lines {
        let base_dir = base.snapshot_dir().to_path_buf();
        let mut error = LargeFileError::new(
            "large-draft-integrity-failed",
            "opened snapshot line count does not match the draft manifest",
        )
        .with_recovery_artifact(snapshot_dir.to_string_lossy());
        drop(view);
        match std::sync::Arc::try_unwrap(base) {
            Ok(base) => {
                if let Err(cleanup) = base.cleanup() {
                    error = error
                        .with_recovery_artifact(base_dir.to_string_lossy())
                        .with_cleanup_warning(cleanup.to_string());
                }
            }
            Err(_) => {
                error = error.with_recovery_artifact(base_dir.to_string_lossy());
            }
        }
        return Err(error);
    }
    let outline = match super::file::scan_outline_view(&view, "large-draft-open") {
        Ok(value) => value,
        Err(error) => {
            let base_dir = base.snapshot_dir().to_path_buf();
            drop(view);
            let mut error = error.with_recovery_artifact(snapshot_dir.to_string_lossy());
            match std::sync::Arc::try_unwrap(base) {
                Ok(base) => {
                    if let Err(cleanup) = base.cleanup() {
                        error = error
                            .with_recovery_artifact(base_dir.to_string_lossy())
                            .with_cleanup_warning(cleanup.to_string());
                    }
                }
                Err(_) => {
                    error = error.with_recovery_artifact(base_dir.to_string_lossy());
                }
            }
            return Err(error);
        }
    };
    let origin_fingerprint =
        fingerprint_from_model(&manifest.origin_fingerprint).ok_or_else(|| {
            with_recovery_artifact(
                LargeFileError::new(
                    "large-draft-manifest-failed",
                    "manifest provenance fingerprint is not representable",
                ),
                &snapshot_dir,
            )
        })?;
    let session = match register_recovered_large_session(
        base,
        view,
        outline,
        PathBuf::from(&manifest.origin_path),
        origin_fingerprint,
        opened_root,
        manifest.draft_id.clone(),
    ) {
        Ok(value) => value,
        Err(error) => return Err(with_recovery_artifact(error, &snapshot_dir)),
    };

    Ok(LargeDraftOpenReceipt {
        snapshot: manifest.snapshot_ref(),
        origin_path: manifest.origin_path,
        target_path: None,
        recovery_draft_id: manifest.draft_id,
        session,
    })
}

/// Delete a draft only after deriving its directory from the validated id and
/// confirming the payload SHA-256. Manifest paths are never used as delete
/// authority.
#[tauri::command(async)]
pub fn delete_large_file_draft(
    app: AppHandle,
    snapshot_id: String,
    expected_sha256: String,
) -> Result<LargeDraftDeleteReceipt, LargeFileError> {
    let root = draft_root(&app)?;
    delete_large_file_draft_at_root(&snapshot_id, &expected_sha256, &root)
}

pub(crate) fn delete_large_file_draft_at_root(
    snapshot_id: &str,
    expected_sha256: &str,
    root: &Path,
) -> Result<LargeDraftDeleteReceipt, LargeFileError> {
    validate_snapshot_id(snapshot_id)
        .map_err(|message| LargeFileError::new("invalid-snapshot-id", message))?;
    let expected_sha256 = normalize_sha256(expected_sha256).ok_or_else(|| {
        LargeFileError::new(
            "invalid-snapshot-hash",
            "expected SHA-256 must be 64 hex digits",
        )
    })?;
    let Some(root) = resolve_optional_directory(root, "large draft root")? else {
        return Ok(LargeDraftDeleteReceipt {
            snapshot_id: snapshot_id.to_string(),
            deleted: false,
            cleanup_warning: None,
        });
    };
    let snapshot_dir = resolve_snapshot_directory(&root, snapshot_id)?;
    let manifest_path = snapshot_dir.join(MANIFEST_NAME);
    let manifest = read_manifest(&manifest_path, &snapshot_dir)?;
    validate_manifest(&manifest, snapshot_id, &snapshot_dir)?;
    if manifest.sha256 != expected_sha256 {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-hash-mismatch",
                "expected SHA-256 does not authorize this draft snapshot",
            ),
            &snapshot_dir,
        ));
    }
    let payload = snapshot_dir.join(PAYLOAD_NAME);
    let actual =
        fingerprint_path(&payload).map_err(|error| with_recovery_artifact(error, &snapshot_dir))?;
    if actual.size_bytes != manifest.byte_length || actual.sha256_hex() != manifest.sha256 {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-integrity-failed",
                "draft payload length or SHA-256 does not match its manifest",
            ),
            &snapshot_dir,
        ));
    }
    remove_owned_snapshot_directory(&snapshot_dir).map_err(|error| {
        with_recovery_artifact(
            LargeFileError::new("large-draft-cleanup-failed", error),
            &snapshot_dir,
        )
    })?;
    Ok(LargeDraftDeleteReceipt {
        snapshot_id: snapshot_id.to_string(),
        deleted: true,
        cleanup_warning: None,
    })
}

#[tauri::command(async)]
pub fn get_large_file_fingerprint(
    path: String,
) -> Result<Option<LargeFileFingerprint>, LargeFileError> {
    let path = PathBuf::from(path);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(LargeFileError::new(
                "fingerprint-failed",
                format!("failed to inspect {}: {error}", path.display()),
            ))
        }
    };
    reject_reparse_metadata(&path, &metadata).map_err(|error| {
        LargeFileError::new("fingerprint-unsafe-path", error).with_path(path.to_string_lossy())
    })?;
    if !metadata.is_file() {
        return Err(LargeFileError::new(
            "fingerprint-invalid-path",
            "fingerprint target is not a file",
        )
        .with_path(path.to_string_lossy()));
    }
    fingerprint_path(&path)
        .map(|fingerprint| fingerprint_model(&fingerprint))
        .map(Some)
}

fn draft_root(app: &AppHandle) -> Result<PathBuf, LargeFileError> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(DRAFT_ROOT_NAME))
        .map_err(|error| {
            LargeFileError::new(
                "draft-root-unavailable",
                format!("failed to resolve the application local data directory: {error}"),
            )
        })
}

fn validate_coordinate_space(space: LargeCoordinateSpace) -> Result<(), LargeFileError> {
    match space {
        LargeCoordinateSpace::Utf16CodeUnits => Ok(()),
    }
}

fn stream_view_to_payload(
    view: &SegmentedTextView<FileBaseSnapshot>,
    path: &Path,
) -> Result<(u64, String), String> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("failed to create payload {}: {error}", path.display()))?;
    let mut writer = HashingWriter::new(file);
    view.write_to(&mut writer)
        .map_err(|error| format!("failed to stream large-file view: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("failed to flush payload {}: {error}", path.display()))?;
    writer
        .file
        .sync_all()
        .map_err(|error| format!("failed to sync payload {}: {error}", path.display()))?;
    let (_, byte_length, sha256) = writer.finish();
    Ok((byte_length, sha256))
}

fn write_manifest(path: &Path, manifest: &DraftManifestRecord) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| io::Error::other(format!("failed to serialize manifest: {error}")))?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&bytes)?;
    file.flush()?;
    file.sync_all()
}

fn read_manifest(path: &Path, snapshot_dir: &Path) -> Result<DraftManifestRecord, LargeFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        with_recovery_artifact(
            LargeFileError::new(
                "large-draft-manifest-failed",
                format!("failed to inspect manifest {}: {error}", path.display()),
            ),
            snapshot_dir,
        )
    })?;
    reject_reparse_metadata(path, &metadata).map_err(|error| {
        with_recovery_artifact(
            LargeFileError::new("large-draft-manifest-failed", error),
            snapshot_dir,
        )
    })?;
    if !metadata.is_file() {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-manifest-failed",
                "manifest is not a regular file",
            ),
            snapshot_dir,
        ));
    }
    let bytes = fs::read(path).map_err(|error| {
        with_recovery_artifact(
            LargeFileError::new(
                "large-draft-manifest-failed",
                format!("failed to read manifest {}: {error}", path.display()),
            ),
            snapshot_dir,
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        with_recovery_artifact(
            LargeFileError::new(
                "large-draft-manifest-failed",
                format!("invalid manifest: {error}"),
            ),
            snapshot_dir,
        )
    })
}

fn validate_manifest(
    manifest: &DraftManifestRecord,
    snapshot_id: &str,
    snapshot_dir: &Path,
) -> Result<(), LargeFileError> {
    if manifest.schema_version != SNAPSHOT_SCHEMA_VERSION
        || manifest.snapshot_id != snapshot_id
        || manifest.payload != PAYLOAD_NAME
        || !matches!(manifest.stage.as_str(), "payload-ready" | "published")
    {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-manifest-failed",
                "manifest schema, snapshot id, payload name, or stage is invalid",
            ),
            snapshot_dir,
        ));
    }
    validate_draft_id(&manifest.draft_id).map_err(|message| {
        with_recovery_artifact(
            LargeFileError::new("large-draft-manifest-failed", message),
            snapshot_dir,
        )
    })?;
    validate_coordinate_space(manifest.coordinate_space)?;
    if normalize_sha256(&manifest.sha256).as_deref() != Some(manifest.sha256.as_str())
        || fingerprint_from_model(&manifest.origin_fingerprint).is_none()
    {
        return Err(with_recovery_artifact(
            LargeFileError::new(
                "large-draft-manifest-failed",
                "manifest fingerprint is invalid",
            ),
            snapshot_dir,
        ));
    }
    Ok(())
}

fn remove_owned_snapshot_directory(path: &Path) -> Result<(), String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(path)
        .map_err(|error| format!("failed to enumerate {}: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to inspect draft entry: {error}"))?;
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path)
            .map_err(|error| format!("failed to inspect {}: {error}", entry_path.display()))?;
        reject_reparse_metadata(&entry_path, &metadata)?;
        if !metadata.is_file() {
            return Err(format!(
                "refusing to remove non-file draft entry {}",
                entry_path.display()
            ));
        }
        let name = entry.file_name();
        if name != PAYLOAD_NAME
            && name != MANIFEST_NAME
            && name != PAYLOAD_TEMP_NAME
            && name != MANIFEST_NEXT_NAME
        {
            return Err(format!(
                "refusing to remove unknown draft entry {}",
                entry_path.display()
            ));
        }
        files.push((name.to_string_lossy().into_owned(), entry_path));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    // Leave the manifest until the payload has been removed, so a failure
    // while removing temporary material still leaves an inspectable record.
    for name in [
        PAYLOAD_TEMP_NAME,
        MANIFEST_NEXT_NAME,
        PAYLOAD_NAME,
        MANIFEST_NAME,
    ] {
        if let Some((_, path)) = files.iter().find(|(entry, _)| entry == name) {
            fs::remove_file(path)
                .map_err(|error| format!("failed to remove {}: {error}", path.display()))?;
        }
    }
    fs::remove_dir(path).map_err(|error| {
        format!(
            "failed to remove draft directory {}: {error}",
            path.display()
        )
    })
}

fn fingerprint_path(path: &Path) -> Result<SourceFingerprint, LargeFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        LargeFileError::new(
            "fingerprint-failed",
            format!("failed to inspect {}: {error}", path.display()),
        )
        .with_path(path.to_string_lossy())
    })?;
    reject_reparse_metadata(path, &metadata).map_err(|error| {
        LargeFileError::new("fingerprint-unsafe-path", error).with_path(path.to_string_lossy())
    })?;
    if !metadata.is_file() {
        return Err(LargeFileError::new(
            "fingerprint-invalid-path",
            "fingerprint target is not a file",
        )
        .with_path(path.to_string_lossy()));
    }
    FileBaseSnapshot::fingerprint_path(path, IO_CHUNK_SIZE).map_err(|error| {
        LargeFileError::new("fingerprint-failed", error.to_string())
            .with_path(path.to_string_lossy())
    })
}

fn fingerprint_model(fingerprint: &SourceFingerprint) -> LargeFileFingerprint {
    LargeFileFingerprint {
        size_bytes: fingerprint.size_bytes,
        modified_millis: fingerprint.modified.map(system_time_millis),
        sha256: fingerprint.sha256_hex(),
    }
}

fn fingerprint_from_model(fingerprint: &LargeFileFingerprint) -> Option<SourceFingerprint> {
    let normalized = normalize_sha256(&fingerprint.sha256)?;
    let mut sha256 = [0_u8; 32];
    for (index, pair) in normalized.as_bytes().chunks_exact(2).enumerate() {
        sha256[index] = (hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]);
    }
    let modified = match fingerprint.modified_millis {
        Some(value) => UNIX_EPOCH.checked_add(std::time::Duration::from_millis(value))?,
        None => {
            return Some(SourceFingerprint {
                size_bytes: fingerprint.size_bytes,
                modified: None,
                sha256,
            })
        }
    };
    Some(SourceFingerprint {
        size_bytes: fingerprint.size_bytes,
        modified: Some(modified),
        sha256,
    })
}

fn system_time_millis(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn normalize_sha256(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn hex_nibble(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        b'A'..=b'F' => value - b'A' + 10,
        _ => 0,
    }
}

impl DraftManifestRecord {
    fn from_snapshot(snapshot: &LargeDraftSnapshotRef, stage: &str) -> Self {
        Self {
            schema_version: snapshot.schema_version,
            snapshot_id: snapshot.snapshot_id.clone(),
            draft_id: snapshot.draft_id.clone(),
            origin_path: snapshot.origin_path.clone(),
            origin_fingerprint: snapshot.origin_fingerprint.clone(),
            captured_revision: snapshot.captured_revision,
            coordinate_space: snapshot.coordinate_space,
            byte_length: snapshot.byte_length,
            total_lines: snapshot.total_lines,
            sha256: snapshot.sha256.clone(),
            payload: PAYLOAD_NAME.to_string(),
            stage: stage.to_string(),
        }
    }

    fn snapshot_ref(&self) -> LargeDraftSnapshotRef {
        LargeDraftSnapshotRef {
            schema_version: self.schema_version,
            snapshot_id: self.snapshot_id.clone(),
            draft_id: self.draft_id.clone(),
            origin_path: self.origin_path.clone(),
            origin_fingerprint: self.origin_fingerprint.clone(),
            captured_revision: self.captured_revision,
            coordinate_space: self.coordinate_space,
            byte_length: self.byte_length,
            total_lines: self.total_lines,
            sha256: self.sha256.clone(),
        }
    }
}

fn next_snapshot_id() -> String {
    format!("snapshot-{}-{}", next_sequence(), std::process::id())
}

fn next_sequence() -> u128 {
    let sequence = NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    nanos.saturating_add(sequence as u128)
}

fn validate_snapshot_id(value: &str) -> Result<(), String> {
    validate_component(value, "snapshot id")
}

fn validate_draft_id(value: &str) -> Result<(), String> {
    validate_component(value, "draft id")
}

fn validate_component(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains("..")
        || value.contains('/')
        || value.contains('\\')
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("{label} contains unsafe path characters"));
    }
    Ok(())
}

fn create_snapshot_directory(root: &Path, snapshot_id: &str) -> Result<PathBuf, LargeFileError> {
    let path = root.join(snapshot_id);
    fs::create_dir(&path).map_err(|error| {
        LargeFileError::new(
            "large-draft-directory-failed",
            format!(
                "failed to create draft directory {}: {error}",
                path.display()
            ),
        )
    })?;
    Ok(path)
}

fn prepare_directory(path: &Path, label: &str) -> Result<PathBuf, LargeFileError> {
    // Validate every existing ancestor before create_dir_all can traverse it.
    // The post-create check below still closes the race where a component is
    // replaced while the directory is being prepared.
    reject_reparse_components(path).map_err(|error| {
        LargeFileError::new(
            "large-draft-directory-failed",
            format!("{label} contains an unsafe reparse component: {error}"),
        )
    })?;
    fs::create_dir_all(path).map_err(|error| {
        LargeFileError::new(
            "large-draft-directory-failed",
            format!("failed to create {label} {}: {error}", path.display()),
        )
    })?;
    reject_reparse_components(path).map_err(|error| {
        LargeFileError::new(
            "large-draft-directory-failed",
            format!("{label} contains an unsafe reparse component: {error}"),
        )
    })?;
    let canonical = fs::canonicalize(path).map_err(|error| {
        LargeFileError::new(
            "large-draft-directory-failed",
            format!("failed to resolve {label} {}: {error}", path.display()),
        )
    })?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        LargeFileError::new(
            "large-draft-directory-failed",
            format!("failed to inspect {label} {}: {error}", canonical.display()),
        )
    })?;
    reject_reparse_metadata(&canonical, &metadata)
        .map_err(|error| LargeFileError::new("large-draft-directory-failed", error))?;
    if !metadata.is_dir() {
        return Err(LargeFileError::new(
            "large-draft-directory-failed",
            format!("{label} is not a directory: {}", canonical.display()),
        ));
    }
    Ok(canonical)
}

fn resolve_existing_directory(path: &Path, label: &str) -> Result<PathBuf, LargeFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        LargeFileError::new(
            "large-draft-directory-failed",
            format!("failed to inspect {label} {}: {error}", path.display()),
        )
    })?;
    reject_reparse_metadata(path, &metadata)
        .map_err(|error| LargeFileError::new("large-draft-directory-failed", error))?;
    if !metadata.is_dir() {
        return Err(LargeFileError::new(
            "large-draft-directory-failed",
            format!("{label} is not a directory: {}", path.display()),
        ));
    }
    prepare_directory(path, label)
}

fn resolve_optional_directory(path: &Path, label: &str) -> Result<Option<PathBuf>, LargeFileError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_reparse_metadata(path, &metadata)
                .map_err(|error| LargeFileError::new("large-draft-directory-failed", error))?;
            if !metadata.is_dir() {
                return Err(LargeFileError::new(
                    "large-draft-directory-failed",
                    format!("{label} is not a directory: {}", path.display()),
                ));
            }
            Ok(Some(prepare_directory(path, label)?))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(LargeFileError::new(
            "large-draft-directory-failed",
            format!("failed to inspect {label} {}: {error}", path.display()),
        )),
    }
}

fn resolve_snapshot_directory(root: &Path, snapshot_id: &str) -> Result<PathBuf, LargeFileError> {
    let candidate = root.join(snapshot_id);
    let metadata = fs::symlink_metadata(&candidate).map_err(|error| {
        LargeFileError::new(
            "large-draft-not-found",
            format!(
                "failed to inspect draft snapshot {}: {error}",
                candidate.display()
            ),
        )
    })?;
    reject_reparse_metadata(&candidate, &metadata)
        .map_err(|error| LargeFileError::new("large-draft-unsafe-path", error))?;
    if !metadata.is_dir() {
        return Err(LargeFileError::new(
            "large-draft-invalid-path",
            "draft snapshot path is not a directory",
        ));
    }
    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        LargeFileError::new(
            "large-draft-directory-failed",
            format!("failed to resolve draft snapshot: {error}"),
        )
    })?;
    if !is_within(&canonical, root) {
        return Err(LargeFileError::new(
            "large-draft-unsafe-path",
            "draft snapshot escaped its private root",
        ));
    }
    Ok(canonical)
}

fn with_recovery_artifact(mut error: LargeFileError, path: &Path) -> LargeFileError {
    error = error.with_recovery_artifact(path.to_string_lossy());
    error
}

fn reject_reparse_components(path: &Path) -> Result<(), String> {
    let mut components = Vec::new();
    let mut current = path;
    loop {
        components.push(current.to_path_buf());
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    components.reverse();
    for component in components {
        match fs::symlink_metadata(&component) {
            Ok(metadata) => reject_reparse_metadata(&component, &metadata)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "failed to inspect path component {}: {error}",
                    component.display()
                ))
            }
        }
    }
    Ok(())
}

fn reject_reparse_metadata(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "reparse/symlink path is not allowed: {}",
            path.display()
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("reparse path is not allowed: {}", path.display()));
        }
    }
    Ok(())
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn is_within(path: &Path, root: &Path) -> bool {
    let path = path_key(path);
    let root = path_key(root);
    path == root || path.starts_with(&(root + "\\"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file::{
        apply_file_edits, close_large_file, open_large_file_at_root, read_file_chunk,
        save_large_file, save_large_file_as, search_large_file,
    };
    use crate::commands::models::{
        LargeCloseDisposition, LargeCoordinateSpace, LargeFindOptions, TextEdit,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    fn test_root(label: &str) -> PathBuf {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "lightmark-large-draft-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn utf16() -> LargeCoordinateSpace {
        LargeCoordinateSpace::Utf16CodeUnits
    }

    #[test]
    fn capture_survives_original_close_source_change_and_recapture() {
        let root = test_root("survives-close");
        let source_path = root.join("origin.md");
        let original = b"\xEF\xBB\xBF# Title\r\nemoji \xF0\x9F\x98\x80\nlast\r\n".to_vec();
        fs::write(&source_path, &original).unwrap();
        let session_root = root.join("sessions");
        let draft_root = root.join("drafts");
        let opened_root = root.join("opened");
        let session =
            open_large_file_at_root(source_path.to_string_lossy().into_owned(), session_root)
                .unwrap();
        let captured = capture_large_file_draft_at_root(
            &session.session_id,
            "draft-close",
            0,
            utf16(),
            &draft_root,
        )
        .unwrap();
        assert_eq!(captured.snapshot.byte_length, original.len() as u64);
        assert_eq!(
            fs::read(
                draft_root
                    .join(&captured.snapshot.snapshot_id)
                    .join(PAYLOAD_NAME)
            )
            .unwrap(),
            original
        );
        close_large_file(session.session_id, 0, LargeCloseDisposition::Discard).unwrap();
        fs::write(&source_path, b"external replacement").unwrap();

        let opened = open_large_file_draft_at_roots(
            &captured.snapshot.snapshot_id,
            &draft_root,
            &opened_root,
        )
        .unwrap();
        assert_eq!(opened.session.path, "");
        assert_eq!(opened.session.target_path, None);
        assert_eq!(opened.session.disk_fingerprint, None);
        assert_eq!(opened.origin_path, source_path.to_string_lossy());
        assert_eq!(
            opened.session.origin_path.as_deref(),
            Some(source_path.to_string_lossy().as_ref())
        );
        assert_eq!(fs::read(&source_path).unwrap(), b"external replacement");
        let save_error =
            save_large_file(opened.session.session_id.clone(), 0, utf16()).unwrap_err();
        assert_eq!(save_error.code, "save-as-required");
        let no_op_edit =
            apply_file_edits(opened.session.session_id.clone(), Vec::new(), 0, utf16()).unwrap();
        assert!(
            no_op_edit.is_dirty,
            "a recovered session has no saved target"
        );
        assert_eq!(no_op_edit.pending_edit_count, 0);
        let no_op_search = search_large_file(
            opened.session.session_id.clone(),
            String::new(),
            LargeFindOptions {
                case_sensitive: false,
                whole_word: false,
                regex: false,
            },
            None,
            None,
            0,
            utf16(),
        )
        .unwrap();
        assert_eq!(no_op_search.revision, 0);
        let close_before_save_as = close_large_file(
            opened.session.session_id.clone(),
            0,
            LargeCloseDisposition::Saved,
        )
        .unwrap_err();
        assert_eq!(close_before_save_as.code, "save-as-required");

        let deleted = delete_large_file_draft_at_root(
            &captured.snapshot.snapshot_id,
            &captured.snapshot.sha256,
            &draft_root,
        )
        .unwrap();
        assert!(deleted.deleted);
        let chunk = read_file_chunk(opened.session.session_id.clone(), 0, 10, 0, utf16()).unwrap();
        assert!(chunk.text.contains("emoji 😀"));

        let recaptured = capture_large_file_draft_at_root(
            &opened.session.session_id,
            "draft-recapture",
            0,
            utf16(),
            &draft_root,
        )
        .unwrap();
        let recaptured_bytes = fs::read(
            draft_root
                .join(&recaptured.snapshot.snapshot_id)
                .join(PAYLOAD_NAME),
        )
        .unwrap();
        assert_eq!(recaptured_bytes, original);
        let recovered_target = root.join("recovered.md");
        let save_as = save_large_file_as(
            opened.session.session_id.clone(),
            recovered_target.to_string_lossy().into_owned(),
            0,
            utf16(),
            None,
        )
        .unwrap();
        assert!(!save_as.is_dirty);
        assert_eq!(save_as.path, recovered_target.to_string_lossy());
        close_large_file(opened.session.session_id, 0, LargeCloseDisposition::Saved).unwrap();
        delete_large_file_draft_at_root(
            &recaptured.snapshot.snapshot_id,
            &recaptured.snapshot.sha256,
            &draft_root,
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn capture_failure_after_session_close_retains_openable_material() {
        let root = test_root("capture-failure");
        let source_path = root.join("origin.md");
        fs::write(&source_path, b"# retained\nbytes \xF0\x9F\x98\x80\n").unwrap();
        let session = open_large_file_at_root(
            source_path.to_string_lossy().into_owned(),
            root.join("sessions"),
        )
        .unwrap();
        let session_id = session.session_id.clone();
        let draft_root = root.join("drafts");
        let error = capture_large_file_draft_at_root_with_hook(
            &session_id,
            "draft-failed",
            0,
            utf16(),
            &draft_root,
            move |id| {
                let _ = close_large_file(id.to_string(), 0, LargeCloseDisposition::Discard);
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "draft-capture-stale");
        let artifact = PathBuf::from(error.recovery_artifact.unwrap());
        assert!(artifact.join(PAYLOAD_NAME).is_file());
        let opened = open_large_file_draft_at_roots(
            artifact.file_name().unwrap().to_string_lossy().as_ref(),
            &draft_root,
            &root.join("opened"),
        )
        .unwrap();
        assert_eq!(opened.session.path, "");
        close_large_file(opened.session.session_id, 0, LargeCloseDisposition::Discard).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edited_view_roundtrips_byte_for_byte_after_source_changes() {
        let root = test_root("edited-view-roundtrip");
        let source_path = root.join("origin.md");
        let original = b"\xEF\xBB\xBF# Title\r\nemoji \xF0\x9F\x98\x80\nsecond\r\nthird\n".to_vec();
        fs::write(&source_path, &original).unwrap();
        let session = open_large_file_at_root(
            source_path.to_string_lossy().into_owned(),
            root.join("sessions"),
        )
        .unwrap();

        let edited = apply_file_edits(
            session.session_id.clone(),
            vec![
                TextEdit {
                    start_line: 0,
                    start_column: 0,
                    end_line: 0,
                    end_column: "# Title".encode_utf16().count(),
                    text: "## Updated".to_string(),
                },
                TextEdit {
                    start_line: 1,
                    start_column: 6,
                    end_line: 1,
                    end_column: 8,
                    text: "🚀".to_string(),
                },
                TextEdit {
                    start_line: 2,
                    start_column: 0,
                    end_line: 3,
                    end_column: 0,
                    text: "second-updated\r\ninserted 😀\n".to_string(),
                },
            ],
            0,
            utf16(),
        )
        .unwrap();
        assert!(edited.is_dirty);
        assert_eq!(edited.revision, 1);

        let draft_root = root.join("drafts");
        let opened_root = root.join("opened");
        let captured = capture_large_file_draft_at_root(
            &session.session_id,
            "edited-roundtrip",
            1,
            utf16(),
            &draft_root,
        )
        .unwrap();
        let expected_view = fs::read(
            draft_root
                .join(&captured.snapshot.snapshot_id)
                .join(PAYLOAD_NAME),
        )
        .unwrap();
        assert_ne!(expected_view, original);

        close_large_file(session.session_id, 1, LargeCloseDisposition::Discard).unwrap();
        fs::write(&source_path, b"external source after capture").unwrap();

        let opened = open_large_file_draft_at_roots(
            &captured.snapshot.snapshot_id,
            &draft_root,
            &opened_root,
        )
        .unwrap();
        let target = root.join("restored.md");
        let save_as = save_large_file_as(
            opened.session.session_id.clone(),
            target.to_string_lossy().into_owned(),
            0,
            utf16(),
            None,
        )
        .unwrap();
        assert_eq!(save_as.saved_revision, 0);
        assert!(!save_as.is_dirty);
        assert_eq!(fs::read(&target).unwrap(), expected_view);
        assert_eq!(fs::read(&source_path).unwrap(), b"external source after capture");
        close_large_file(
            opened.session.session_id,
            0,
            LargeCloseDisposition::Saved,
        )
        .unwrap();
        delete_large_file_draft_at_root(
            &captured.snapshot.snapshot_id,
            &captured.snapshot.sha256,
            &draft_root,
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn five_mib_plus_one_stream_preserves_hash_and_length() {
        let root = test_root("large-stream");
        let source_path = root.join("large.md");
        let bytes = vec![b'a'; 5 * 1024 * 1024 + 1];
        fs::write(&source_path, &bytes).unwrap();
        let session = open_large_file_at_root(
            source_path.to_string_lossy().into_owned(),
            root.join("sessions"),
        )
        .unwrap();
        let captured = capture_large_file_draft_at_root(
            &session.session_id,
            "draft-large",
            0,
            utf16(),
            &root.join("drafts"),
        )
        .unwrap();
        let payload = fs::read(
            root.join("drafts")
                .join(&captured.snapshot.snapshot_id)
                .join(PAYLOAD_NAME),
        )
        .unwrap();
        assert_eq!(payload.len(), 5 * 1024 * 1024 + 1);
        assert_eq!(
            captured.snapshot.sha256,
            format!("{:x}", Sha256::digest(&bytes))
        );
        close_large_file(session.session_id, 0, LargeCloseDisposition::Discard).unwrap();
        delete_large_file_draft_at_root(
            &captured.snapshot.snapshot_id,
            &captured.snapshot.sha256,
            &root.join("drafts"),
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovered_session_requires_save_as_and_manifest_cannot_escape_delete_root() {
        let root = test_root("save-as-boundary");
        let draft_root = root.join("drafts");
        fs::create_dir_all(draft_root.join("snapshot-safe")).unwrap();
        let outside = root.join("outside");
        fs::write(&outside, b"do not delete").unwrap();
        let valid_sha = "00".repeat(32);
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "snapshotId": "snapshot-safe",
            "draftId": "draft-safe",
            "originPath": "C:/origin.md",
            "originFingerprint": {"sizeBytes": 0, "modifiedMillis": null, "sha256": valid_sha.clone()},
            "capturedRevision": 0,
            "coordinateSpace": "utf16-code-units",
            "byteLength": 0,
            "totalLines": 1,
            "sha256": valid_sha,
            "payload": "../outside",
            "stage": "published"
        });
        fs::write(
            draft_root.join("snapshot-safe").join(MANIFEST_NAME),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let error =
            delete_large_file_draft_at_root("snapshot-safe", &valid_sha, &draft_root).unwrap_err();
        assert_eq!(error.code, "large-draft-manifest-failed");
        assert!(outside.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_rejects_invalid_provenance_hex_and_unrepresentable_timestamp() {
        let root = test_root("manifest-provenance");
        let draft_root = root.join("drafts");
        let snapshot_dir = draft_root.join("snapshot-provenance");
        fs::create_dir_all(&snapshot_dir).unwrap();
        let payload_sha = "11".repeat(32);
        let mut manifest = serde_json::json!({
            "schemaVersion": 1,
            "snapshotId": "snapshot-provenance",
            "draftId": "draft-provenance",
            "originPath": "C:/origin.md",
            "originFingerprint": {
                "sizeBytes": 0,
                "modifiedMillis": null,
                "sha256": "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"
            },
            "capturedRevision": 0,
            "coordinateSpace": "utf16-code-units",
            "byteLength": 0,
            "totalLines": 1,
            "sha256": payload_sha,
            "payload": "payload",
            "stage": "published"
        });
        fs::write(
            snapshot_dir.join(MANIFEST_NAME),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let invalid_hex =
            delete_large_file_draft_at_root("snapshot-provenance", &payload_sha, &draft_root)
                .unwrap_err();
        assert_eq!(invalid_hex.code, "large-draft-manifest-failed");

        manifest["originFingerprint"]["sha256"] = serde_json::json!("22".repeat(32));
        manifest["originFingerprint"]["modifiedMillis"] = serde_json::json!(u64::MAX);
        fs::write(
            snapshot_dir.join(MANIFEST_NAME),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let invalid_timestamp =
            delete_large_file_draft_at_root("snapshot-provenance", &payload_sha, &draft_root)
                .unwrap_err();
        assert_eq!(invalid_timestamp.code, "large-draft-manifest-failed");
        fs::remove_dir_all(root).unwrap();
    }
}
