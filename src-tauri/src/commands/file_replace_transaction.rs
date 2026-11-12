//! Shared file replacement transaction primitive for LM-006.
//!
//! This module is the shared save boundary for normal, large-file, and draft
//! writes.  The important distinction is that a
//! successful `ReplaceFileW` call is not a compare-and-swap: the expected old
//! bytes are verified again in the API-created backup, and an independent
//! output copy is retained until that evidence is classified.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::large_file_base::{FileBaseSnapshot, SourceFingerprint};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{
    MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVE_FILE_FLAGS, REPLACE_FILE_FLAGS,
};

const IO_CHUNK_SIZE: usize = 64 * 1024;
const TXN_ROOT_NAME: &str = ".lightmark-txn";
const MANIFEST_NAME: &str = "manifest.json";
const MANIFEST_NEXT_NAME: &str = "manifest.next";
const REPLACEMENT_NAME: &str = "replacement";
const OUTPUT_NAME: &str = "output";
const BACKUP_NAME: &str = "backup";
const INDEX_SUFFIX: &str = ".json";
const MANIFEST_SCHEMA: u32 = 1;
const INDEX_SCHEMA: u32 = 1;

static NEXT_TRANSACTION_ID: AtomicU64 = AtomicU64::new(0);

/// The four states a replacement can have after the OS call and post-call
/// evidence have been inspected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransactionOutcome {
    Committed,
    Conflict,
    NotCommitted,
    Ambiguous,
}

impl TransactionOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Committed => "committed",
            Self::Conflict => "conflict",
            Self::NotCommitted => "not-committed",
            Self::Ambiguous => "ambiguous",
        }
    }
}

/// Whether this helper has evidence that the target received the new bytes.
/// `Unknown` is deliberately distinct from false: an OS error can leave
/// target, replacement, and backup under different names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiskWriteStatus {
    Yes,
    No,
    Unknown,
}

impl DiskWriteStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::No => "no",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug)]
pub(crate) struct TransactionError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) recovery_artifact: Option<PathBuf>,
    pub(crate) cleanup_warning: Option<String>,
}

impl TransactionError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recovery_artifact: None,
            cleanup_warning: None,
        }
    }

    fn with_artifact(mut self, path: impl Into<PathBuf>) -> Self {
        self.recovery_artifact = Some(path.into());
        self
    }

    #[allow(dead_code)]
    pub(crate) fn with_cleanup_warning(mut self, warning: impl Into<String>) -> Self {
        self.cleanup_warning = Some(warning.into());
        self
    }
}

impl std::fmt::Display for TransactionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for TransactionError {}

/// Evidence returned for every classified OS replacement.  A non-committed
/// result always retains `transaction_dir`; a committed result may have no
/// artifact only when all owned cleanup completed.
#[derive(Debug)]
pub(crate) struct TransactionReceipt {
    pub(crate) outcome: TransactionOutcome,
    pub(crate) disk_written: DiskWriteStatus,
    pub(crate) target_fingerprint: Option<SourceFingerprint>,
    pub(crate) backup_fingerprint: Option<SourceFingerprint>,
    pub(crate) replacement_fingerprint: Option<SourceFingerprint>,
    pub(crate) output_fingerprint: Option<SourceFingerprint>,
    pub(crate) transaction_dir: PathBuf,
    pub(crate) replacement_path: PathBuf,
    pub(crate) output_path: PathBuf,
    pub(crate) backup_path: PathBuf,
    pub(crate) manifest_path: PathBuf,
    pub(crate) recovery_artifact: Option<PathBuf>,
    pub(crate) cleanup_warning: Option<String>,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FingerprintRecord {
    size_bytes: u64,
    sha256: String,
    #[serde(default)]
    modified_millis: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestRecord {
    schema: u32,
    transaction_id: String,
    target_path: String,
    #[serde(default)]
    expected_target: Option<FingerprintRecord>,
    output: FingerprintRecord,
    replacement: String,
    output_artifact: String,
    backup: String,
    stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecoveryIndexRecord {
    schema: u32,
    transaction_id: String,
    target_parent: String,
    target_path: String,
}

/// A read-only discovery result.  Discovery never writes, restores, or
/// deletes anything; callers must require an explicit action for recovery.
#[derive(Debug, Clone)]
pub(crate) struct RecoveryCandidate {
    pub(crate) transaction_id: String,
    pub(crate) target_path: PathBuf,
    pub(crate) transaction_dir: PathBuf,
    pub(crate) trusted: bool,
    pub(crate) reason: Option<String>,
}

struct NativeCall {
    succeeded: bool,
    code: Option<i32>,
    message: String,
}

/// A prepared replacement with ownership of the moved replacement and the
/// ordinary-save output copy.  The replacement is moved into the transaction
/// directory before commit; callers must treat the returned object as the
/// owner of that path.
pub(crate) struct FileReplaceTransaction {
    target: PathBuf,
    target_parent: PathBuf,
    transaction_id: String,
    transaction_dir: PathBuf,
    replacement: PathBuf,
    output: PathBuf,
    backup: PathBuf,
    manifest: PathBuf,
    index_file: PathBuf,
    index_bytes: Vec<u8>,
    expected_target: Option<SourceFingerprint>,
    output_fingerprint: SourceFingerprint,
    manifest_record: ManifestRecord,
    target_wide: Vec<u16>,
    replacement_wide: Vec<u16>,
    backup_wide: Vec<u16>,
    #[cfg(test)]
    before_replace_hook: Option<Box<dyn FnOnce(&Path) + Send>>,
    #[cfg(test)]
    after_replace_hook: Option<Box<dyn FnOnce(&Path) + Send>>,
    #[cfg(test)]
    cleanup_failure: bool,
    #[cfg(test)]
    hold_target_without_delete_share: bool,
}

impl FileReplaceTransaction {
    /// Prepare an owned replacement.  `replacement` is moved into a fresh,
    /// same-volume transaction directory.  `index_root` is supplied by the
    /// host and is only a private discovery hint; it never grants authority to
    /// use paths from an untrusted manifest.
    pub(crate) fn prepare(
        target: impl AsRef<Path>,
        expected_target: Option<SourceFingerprint>,
        replacement: impl AsRef<Path>,
        index_root: impl AsRef<Path>,
    ) -> Result<Self, TransactionError> {
        let (target, target_parent) = normalize_target(target.as_ref())?;
        let replacement_source = normalize_existing_file(replacement.as_ref())?;
        if same_path(&target, &replacement_source) {
            return Err(TransactionError::new(
                "transaction-invalid",
                "target and replacement must be different paths",
            ));
        }

        let index_root = prepare_directory(index_root.as_ref(), "recovery index")?;
        let (transaction_id, transaction_dir) = create_transaction_directory(&target_parent)?;
        let index_file = index_root.join(format!("{transaction_id}{INDEX_SUFFIX}"));
        let index_record = RecoveryIndexRecord {
            schema: INDEX_SCHEMA,
            transaction_id: transaction_id.clone(),
            target_parent: target_parent.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
        };
        let index_bytes = serialized_json(&index_record).map_err(|error| {
            TransactionError::new("transaction-index-failed", error)
                .with_artifact(transaction_dir.clone())
        })?;
        write_new_synced(&index_file, &index_bytes).map_err(|error| {
            TransactionError::new(
                "transaction-index-failed",
                format!(
                    "failed to register recovery index {}: {error}",
                    index_file.display()
                ),
            )
            .with_artifact(transaction_dir.clone())
        })?;

        let replacement = transaction_dir.join(REPLACEMENT_NAME);
        if let Err(error) = fs::rename(&replacement_source, &replacement) {
            return Err(TransactionError::new(
                "transaction-replacement-adopt-failed",
                format!(
                    "failed to adopt replacement {} into {}: {error}",
                    replacement_source.display(),
                    replacement.display()
                ),
            )
            .with_artifact(transaction_dir));
        }

        let output = transaction_dir.join(OUTPUT_NAME);
        let backup = transaction_dir.join(BACKUP_NAME);
        let manifest = transaction_dir.join(MANIFEST_NAME);

        let output_fingerprint = match fingerprint_required(&replacement) {
            Ok(value) => value,
            Err(error) => {
                return Err(TransactionError::new(
                    "transaction-replacement-fingerprint-failed",
                    error,
                )
                .with_artifact(transaction_dir))
            }
        };
        if let Err(error) = copy_to_new_synced(&replacement, &output) {
            return Err(TransactionError::new(
                "transaction-output-copy-failed",
                format!(
                    "failed to create independent output {}: {error}",
                    output.display()
                ),
            )
            .with_artifact(transaction_dir));
        }
        match fingerprint_required(&output) {
            Ok(copy_fingerprint) if same_content(&copy_fingerprint, &output_fingerprint) => {}
            Ok(_) => {
                return Err(TransactionError::new(
                    "transaction-output-fingerprint-mismatch",
                    "independent output does not match the rendered replacement",
                )
                .with_artifact(transaction_dir))
            }
            Err(error) => {
                return Err(
                    TransactionError::new("transaction-output-fingerprint-failed", error)
                        .with_artifact(transaction_dir),
                )
            }
        }

        let manifest_record = ManifestRecord {
            schema: MANIFEST_SCHEMA,
            transaction_id: transaction_id.clone(),
            target_path: target.to_string_lossy().into_owned(),
            expected_target: expected_target.as_ref().map(fingerprint_record),
            output: fingerprint_record(&output_fingerprint),
            replacement: REPLACEMENT_NAME.to_string(),
            output_artifact: OUTPUT_NAME.to_string(),
            backup: BACKUP_NAME.to_string(),
            stage: "prepared".to_string(),
        };
        let manifest_bytes = serialized_json(&manifest_record).map_err(|error| {
            TransactionError::new("transaction-manifest-failed", error)
                .with_artifact(transaction_dir.clone())
        })?;
        if let Err(error) = write_new_synced(&manifest, &manifest_bytes) {
            return Err(TransactionError::new(
                "transaction-manifest-failed",
                format!("failed to write manifest {}: {error}", manifest.display()),
            )
            .with_artifact(transaction_dir));
        }

        let target_wide = encode_path(&target).map_err(|error| {
            TransactionError::new("transaction-path-invalid", error)
                .with_artifact(transaction_dir.clone())
        })?;
        let replacement_wide = encode_path(&replacement).map_err(|error| {
            TransactionError::new("transaction-path-invalid", error)
                .with_artifact(transaction_dir.clone())
        })?;
        let backup_wide = encode_path(&backup).map_err(|error| {
            TransactionError::new("transaction-path-invalid", error)
                .with_artifact(transaction_dir.clone())
        })?;

        Ok(Self {
            target,
            target_parent,
            transaction_id,
            transaction_dir,
            replacement,
            output,
            backup,
            manifest,
            index_file,
            index_bytes,
            expected_target,
            output_fingerprint,
            manifest_record,
            target_wide,
            replacement_wide,
            backup_wide,
            #[cfg(test)]
            before_replace_hook: None,
            #[cfg(test)]
            after_replace_hook: None,
            #[cfg(test)]
            cleanup_failure: false,
            #[cfg(test)]
            hold_target_without_delete_share: false,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_before_replace_hook(
        mut self,
        hook: impl FnOnce(&Path) + Send + 'static,
    ) -> Self {
        self.before_replace_hook = Some(Box::new(hook));
        self
    }

    #[cfg(test)]
    pub(crate) fn with_after_replace_hook(
        mut self,
        hook: impl FnOnce(&Path) + Send + 'static,
    ) -> Self {
        self.after_replace_hook = Some(Box::new(hook));
        self
    }

    #[cfg(test)]
    pub(crate) fn with_cleanup_failure(mut self) -> Self {
        self.cleanup_failure = true;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_target_share_violation(mut self) -> Self {
        self.hold_target_without_delete_share = true;
        self
    }

    pub(crate) fn transaction_dir(&self) -> &Path {
        &self.transaction_dir
    }

    pub(crate) fn replacement_path(&self) -> &Path {
        &self.replacement
    }

    pub(crate) fn output_path(&self) -> &Path {
        &self.output
    }

    pub(crate) fn backup_path(&self) -> &Path {
        &self.backup
    }

    /// Perform the final expected-target check, one native OS operation, and
    /// post-call evidence classification.  All four outcomes are returned as
    /// receipts; only preparation failures use `TransactionError`.
    #[allow(unused_mut)]
    pub(crate) fn commit(mut self) -> TransactionReceipt {
        if let Err(error) = self.verify_precommit_artifacts() {
            return self.receipt(
                TransactionOutcome::Ambiguous,
                DiskWriteStatus::Unknown,
                None,
                None,
                None,
                None,
                format!("pre-commit artifact verification failed: {error}"),
            );
        }

        let target_before = match fingerprint_if_exists(&self.target) {
            Ok(value) => value,
            Err(error) => {
                return self.receipt(
                    TransactionOutcome::Ambiguous,
                    DiskWriteStatus::Unknown,
                    None,
                    None,
                    None,
                    None,
                    format!("final target fingerprint failed: {error}"),
                )
            }
        };
        if !matches_expected(target_before.as_ref(), self.expected_target.as_ref()) {
            let replacement_before = fingerprint_if_exists(&self.replacement).ok().flatten();
            let output_before = fingerprint_if_exists(&self.output).ok().flatten();
            let stage_warning = self
                .persist_stage(TransactionOutcome::Conflict.as_str())
                .err()
                .map(|error| format!("failed to persist conflict manifest stage: {error}"));
            let mut receipt = self.receipt(
                TransactionOutcome::Conflict,
                DiskWriteStatus::No,
                target_before,
                None,
                replacement_before,
                output_before,
                "target did not match the expected fingerprint at the final save boundary"
                    .to_string(),
            );
            receipt.cleanup_warning = stage_warning;
            return receipt;
        }

        // This hook exists only in test builds.  In production there is no
        // allocation, cleanup, logging, or state publication between this
        // final check and the single native call.
        #[cfg(test)]
        if let Some(hook) = self.before_replace_hook.take() {
            hook(&self.target);
        }

        #[cfg(test)]
        let held_target = if self.hold_target_without_delete_share {
            open_target_without_delete_share(&self.target)
        } else {
            None
        };

        let native = if self.expected_target.is_some() {
            replace_existing_os(&self)
        } else {
            create_only_os(&self)
        };

        #[cfg(test)]
        if let Some(hook) = self.after_replace_hook.take() {
            hook(&self.target);
        }

        #[cfg(test)]
        drop(held_target);

        let target_after = match fingerprint_if_exists(&self.target) {
            Ok(value) => value,
            Err(error) => {
                return self.receipt(
                    TransactionOutcome::Ambiguous,
                    DiskWriteStatus::Unknown,
                    None,
                    None,
                    fingerprint_if_exists(&self.replacement).ok().flatten(),
                    fingerprint_if_exists(&self.output).ok().flatten(),
                    format!(
                        "post-call target fingerprint failed: {error}; {}",
                        native.message
                    ),
                )
            }
        };
        let backup_after = match fingerprint_if_exists(&self.backup) {
            Ok(value) => value,
            Err(error) => {
                return self.receipt(
                    TransactionOutcome::Ambiguous,
                    DiskWriteStatus::Unknown,
                    target_after,
                    None,
                    fingerprint_if_exists(&self.replacement).ok().flatten(),
                    fingerprint_if_exists(&self.output).ok().flatten(),
                    format!(
                        "post-call backup fingerprint failed: {error}; {}",
                        native.message
                    ),
                )
            }
        };
        let replacement_after = match fingerprint_if_exists(&self.replacement) {
            Ok(value) => value,
            Err(error) => {
                return self.receipt(
                    TransactionOutcome::Ambiguous,
                    DiskWriteStatus::Unknown,
                    target_after,
                    backup_after,
                    None,
                    fingerprint_if_exists(&self.output).ok().flatten(),
                    format!(
                        "post-call replacement fingerprint failed: {error}; {}",
                        native.message
                    ),
                )
            }
        };
        let output_after = match fingerprint_if_exists(&self.output) {
            Ok(value) => value,
            Err(error) => {
                return self.receipt(
                    TransactionOutcome::Ambiguous,
                    DiskWriteStatus::Unknown,
                    target_after,
                    backup_after,
                    replacement_after,
                    None,
                    format!(
                        "post-call output fingerprint failed: {error}; {}",
                        native.message
                    ),
                )
            }
        };

        let (outcome, disk_written, message) = if let Some(expected) = &self.expected_target {
            classify_existing(
                &native,
                target_after.as_ref(),
                backup_after.as_ref(),
                replacement_after.as_ref(),
                output_after.as_ref(),
                expected,
                &self.output_fingerprint,
            )
        } else {
            classify_create_only(
                &native,
                target_after.as_ref(),
                backup_after.as_ref(),
                replacement_after.as_ref(),
                output_after.as_ref(),
                &self.output_fingerprint,
            )
        };

        let stage_warning = self
            .persist_stage(outcome.as_str())
            .err()
            .map(|error| format!("failed to persist {outcome:?} manifest stage: {error}"));

        let mut receipt = self.receipt(
            outcome,
            disk_written,
            target_after,
            backup_after,
            replacement_after,
            output_after,
            format!("{message}; {}", native.message),
        );
        if let Some(warning) = stage_warning {
            receipt.cleanup_warning = Some(warning);
            receipt.recovery_artifact = self.recovery_artifact_path();
            return receipt;
        }

        if outcome == TransactionOutcome::Committed {
            if let Err(warning) = self.cleanup_committed() {
                receipt.cleanup_warning = Some(warning);
                receipt.recovery_artifact = self.recovery_artifact_path();
            } else {
                receipt.recovery_artifact = None;
            }
        } else {
            receipt.recovery_artifact = Some(self.transaction_dir.clone());
        }
        receipt
    }

    fn recovery_artifact_path(&self) -> Option<PathBuf> {
        [
            &self.transaction_dir,
            &self.index_file,
            &self.manifest,
            &self.replacement,
            &self.output,
            &self.backup,
        ]
        .into_iter()
        .find(|path| fs::symlink_metadata(path).is_ok())
        .cloned()
    }

    fn verify_precommit_artifacts(&self) -> Result<(), String> {
        let replacement = fingerprint_required(&self.replacement)?;
        if !same_content(&replacement, &self.output_fingerprint) {
            return Err("replacement changed after preparation".to_string());
        }
        let output = fingerprint_required(&self.output)?;
        if !same_content(&output, &self.output_fingerprint) {
            return Err("independent output changed after preparation".to_string());
        }
        if path_exists(&self.backup)? {
            return Err("backup path was occupied before the native replace call".to_string());
        }
        Ok(())
    }

    fn persist_stage(&self, stage: &str) -> Result<(), String> {
        let mut record = self.manifest_record.clone();
        record.stage = stage.to_string();
        let bytes = serialized_json(&record)?;
        let next = self.transaction_dir.join(MANIFEST_NEXT_NAME);
        write_new_synced(&next, &bytes)
            .map_err(|error| format!("failed to write {}: {error}", next.display()))?;
        replace_metadata_file(&next, &self.manifest)
            .map_err(|error| format!("failed to publish {}: {error}", self.manifest.display()))
    }

    fn cleanup_committed(&self) -> Result<(), String> {
        #[cfg(test)]
        if self.cleanup_failure {
            return Err("test-injected cleanup failure".to_string());
        }

        remove_owned_file(&self.replacement, Some(&self.output_fingerprint))?;
        remove_owned_file(&self.output, Some(&self.output_fingerprint))?;
        if let Some(expected) = &self.expected_target {
            remove_owned_file(&self.backup, Some(expected))?;
        }
        remove_owned_file(&self.manifest, None)?;
        fs::remove_dir(&self.transaction_dir).map_err(|error| {
            format!(
                "failed to remove transaction directory {}: {error}",
                self.transaction_dir.display()
            )
        })?;
        remove_owned_index(&self.index_file, &self.index_bytes)
    }

    fn receipt(
        &self,
        outcome: TransactionOutcome,
        disk_written: DiskWriteStatus,
        target_fingerprint: Option<SourceFingerprint>,
        backup_fingerprint: Option<SourceFingerprint>,
        replacement_fingerprint: Option<SourceFingerprint>,
        output_fingerprint: Option<SourceFingerprint>,
        message: String,
    ) -> TransactionReceipt {
        TransactionReceipt {
            outcome,
            disk_written,
            target_fingerprint,
            backup_fingerprint,
            replacement_fingerprint,
            output_fingerprint,
            transaction_dir: self.transaction_dir.clone(),
            replacement_path: self.replacement.clone(),
            output_path: self.output.clone(),
            backup_path: self.backup.clone(),
            manifest_path: self.manifest.clone(),
            recovery_artifact: Some(self.transaction_dir.clone()),
            cleanup_warning: None,
            message,
        }
    }
}

/// Validate and normalize a target before a caller creates its owned
/// replacement file.  This keeps directory/reparse checks ahead of any write
/// performed by the command layer; `prepare` repeats the check at adoption.
pub(crate) fn normalize_target_for_transaction(
    target: impl AsRef<Path>,
) -> Result<(PathBuf, PathBuf), TransactionError> {
    normalize_target(target.as_ref())
}

fn classify_existing(
    native: &NativeCall,
    target: Option<&SourceFingerprint>,
    backup: Option<&SourceFingerprint>,
    replacement: Option<&SourceFingerprint>,
    output: Option<&SourceFingerprint>,
    expected: &SourceFingerprint,
    new_fingerprint: &SourceFingerprint,
) -> (TransactionOutcome, DiskWriteStatus, String) {
    let target_is_new = target.is_some_and(|value| same_content(value, new_fingerprint));
    let target_is_expected = target.is_some_and(|value| same_content(value, expected));
    let backup_is_expected = backup.is_some_and(|value| same_content(value, expected));
    let output_is_new = output.is_some_and(|value| same_content(value, new_fingerprint));
    let replacement_is_new = replacement.is_some_and(|value| same_content(value, new_fingerprint));

    if target_is_new && backup_is_expected && output_is_new {
        return (
            TransactionOutcome::Committed,
            DiskWriteStatus::Yes,
            "target is N, backup is the expected old B, and independent output is N".to_string(),
        );
    }
    if target_is_new && backup.is_some() && !backup_is_expected && output_is_new {
        return (
            TransactionOutcome::Conflict,
            DiskWriteStatus::Yes,
            "target is N but backup is an external version E rather than expected B".to_string(),
        );
    }
    if native.succeeded && output_is_new && !target_is_new {
        return (
            TransactionOutcome::Conflict,
            DiskWriteStatus::Yes,
            "ReplaceFileW reported success but target is no longer N; independent output retained"
                .to_string(),
        );
    }
    if !native.succeeded && target_is_expected && replacement_is_new && output_is_new {
        return (
            TransactionOutcome::NotCommitted,
            DiskWriteStatus::No,
            "native replacement failed while target remained B and replacement remained N"
                .to_string(),
        );
    }
    let disk = if target_is_new {
        DiskWriteStatus::Yes
    } else {
        DiskWriteStatus::Unknown
    };
    (
        TransactionOutcome::Ambiguous,
        disk,
        format!(
            "unclassified existing-target state (native_ok={}, target_is_expected={}, target_is_new={}, backup_is_expected={}, replacement_is_new={}, output_is_new={})",
            native.succeeded,
            target_is_expected,
            target_is_new,
            backup_is_expected,
            replacement_is_new,
            output_is_new
        ),
    )
}

fn classify_create_only(
    native: &NativeCall,
    target: Option<&SourceFingerprint>,
    backup: Option<&SourceFingerprint>,
    replacement: Option<&SourceFingerprint>,
    output: Option<&SourceFingerprint>,
    new_fingerprint: &SourceFingerprint,
) -> (TransactionOutcome, DiskWriteStatus, String) {
    let target_is_new = target.is_some_and(|value| same_content(value, new_fingerprint));
    let output_is_new = output.is_some_and(|value| same_content(value, new_fingerprint));
    let replacement_is_new = replacement.is_some_and(|value| same_content(value, new_fingerprint));

    if native.succeeded && target_is_new && output_is_new && backup.is_none() {
        return (
            TransactionOutcome::Committed,
            DiskWriteStatus::Yes,
            "create-only move produced target N with no backup".to_string(),
        );
    }
    if !native.succeeded && target.is_none() && replacement_is_new && output_is_new {
        return (
            TransactionOutcome::NotCommitted,
            DiskWriteStatus::No,
            "non-overwrite create failed while target remained absent and replacement remained N"
                .to_string(),
        );
    }
    if !native.succeeded
        && target.is_some()
        && !target_is_new
        && replacement_is_new
        && output_is_new
    {
        return (
            TransactionOutcome::Conflict,
            DiskWriteStatus::No,
            "non-overwrite create refused a target that appeared after the final check".to_string(),
        );
    }
    if native.succeeded && output_is_new && !target_is_new {
        return (
            TransactionOutcome::Conflict,
            DiskWriteStatus::Yes,
            "create-only move reported success but target is no longer N; independent output retained"
                .to_string(),
        );
    }
    (
        TransactionOutcome::Ambiguous,
        DiskWriteStatus::Unknown,
        format!(
            "unclassified create-only state (native_ok={}, target_is_new={}, replacement_is_new={}, output_is_new={}, backup_present={})",
            native.succeeded,
            target_is_new,
            replacement_is_new,
            output_is_new,
            backup.is_some()
        ),
    )
}

#[cfg(target_os = "macos")]
fn macos_rename(from: &Path, to: &Path, flags: libc::c_uint) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // Both C strings live for the entire call. Darwin applies the flag atomically.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), flags) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn macos_call(operation: &str, result: io::Result<()>) -> NativeCall {
    match result {
        Ok(()) => NativeCall { succeeded: true, code: None, message: format!("{operation} succeeded") },
        Err(error) => NativeCall { succeeded: false, code: error.raw_os_error(), message: format!("{operation}: {error}") },
    }
}

fn replace_existing_os(transaction: &FileReplaceTransaction) -> NativeCall {
    #[cfg(windows)]
    {
        let result = unsafe {
            ReplaceFileW(
                PCWSTR(transaction.target_wide.as_ptr()),
                PCWSTR(transaction.replacement_wide.as_ptr()),
                PCWSTR(transaction.backup_wide.as_ptr()),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
        };
        return match result {
            Ok(()) => NativeCall {
                succeeded: true,
                code: None,
                message: "ReplaceFileW succeeded".to_string(),
            },
            Err(error) => NativeCall {
                succeeded: false,
                code: Some(error.code().0),
                message: format!(
                    "ReplaceFileW failed with HRESULT {}: {error}",
                    error.code().0
                ),
            },
        };
    }
    #[cfg(target_os = "macos")]
    {
        // The displaced target lands directly at the journal's backup path.
        // A process exit after the exchange cannot strand it under another name.
        let result = (|| {
            let permissions = fs::metadata(&transaction.target)?.permissions();
            if permissions.readonly() {
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&transaction.replacement, fs::Permissions::from_mode(permissions.mode() & 0o777))?;
            fs::hard_link(&transaction.replacement, &transaction.backup)?;
            macos_rename(&transaction.backup, &transaction.target, libc::RENAME_SWAP)
        })();
        macos_call("atomic file exchange", result)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = transaction;
        NativeCall {
            succeeded: false,
            code: None,
            message: "ReplaceFileW is unavailable on this platform".to_string(),
        }
    }
}

fn create_only_os(transaction: &FileReplaceTransaction) -> NativeCall {
    #[cfg(windows)]
    {
        // No MOVEFILE_REPLACE_EXISTING: the kernel must refuse a destination
        // that appeared after the final check.  The transaction directory and
        // target are prepared on the same volume, so COPY_ALLOWED is omitted.
        let result = unsafe {
            MoveFileExW(
                PCWSTR(transaction.replacement_wide.as_ptr()),
                PCWSTR(transaction.target_wide.as_ptr()),
                MOVE_FILE_FLAGS(0),
            )
        };
        return match result {
            Ok(()) => NativeCall {
                succeeded: true,
                code: None,
                message: "MoveFileExW create-only move succeeded".to_string(),
            },
            Err(error) => NativeCall {
                succeeded: false,
                code: Some(error.code().0),
                message: format!(
                    "MoveFileExW create-only move failed with HRESULT {}: {error}",
                    error.code().0
                ),
            },
        };
    }
    #[cfg(target_os = "macos")]
    {
        macos_call("exclusive file creation", macos_rename(&transaction.replacement, &transaction.target, libc::RENAME_EXCL))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = transaction;
        NativeCall {
            succeeded: false,
            code: None,
            message: "non-overwrite native move is unavailable on this platform".to_string(),
        }
    }
}

fn normalize_target(path: &Path) -> Result<(PathBuf, PathBuf), TransactionError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    // Check all existing components before creating missing directories. This
    // preserves the evidence that the caller supplied a normal path instead
    // of canonicalizing through a junction/symlink first.
    reject_reparse_components(parent).map_err(|error| {
        TransactionError::new(
            "transaction-target-parent-failed",
            format!("target parent contains an unsafe reparse component: {error}"),
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        TransactionError::new(
            "transaction-target-parent-failed",
            format!(
                "failed to create target parent {}: {error}",
                parent.display()
            ),
        )
    })?;
    reject_reparse_components(parent).map_err(|error| {
        TransactionError::new(
            "transaction-target-parent-failed",
            format!("target parent contains an unsafe reparse component: {error}"),
        )
    })?;
    let target_parent = fs::canonicalize(parent).map_err(|error| {
        TransactionError::new(
            "transaction-target-parent-failed",
            format!(
                "failed to resolve target parent {}: {error}",
                parent.display()
            ),
        )
    })?;
    reject_reparse(&target_parent).map_err(|error| {
        TransactionError::new(
            "transaction-target-parent-failed",
            format!("target parent is not a normal directory: {error}"),
        )
    })?;
    let name = path.file_name().ok_or_else(|| {
        TransactionError::new("transaction-path-invalid", "target must have a file name")
    })?;
    let target = target_parent.join(name);
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        reject_reparse_metadata(&target, &metadata).map_err(|error| {
            TransactionError::new(
                "transaction-target-invalid",
                format!("target is not a normal file: {error}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(TransactionError::new(
                "transaction-target-invalid",
                format!("target is not a regular file: {}", target.display()),
            ));
        }
    }
    Ok((target, target_parent))
}

fn normalize_existing_file(path: &Path) -> Result<PathBuf, TransactionError> {
    reject_reparse_components(path).map_err(|error| {
        TransactionError::new(
            "transaction-replacement-invalid",
            format!("replacement path contains an unsafe reparse component: {error}"),
        )
    })?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        TransactionError::new(
            "transaction-replacement-invalid",
            format!("failed to inspect replacement {}: {error}", path.display()),
        )
    })?;
    reject_reparse_metadata(path, &metadata).map_err(|error| {
        TransactionError::new(
            "transaction-replacement-invalid",
            format!("replacement is not a normal file: {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(TransactionError::new(
            "transaction-replacement-invalid",
            format!("replacement is not a regular file: {}", path.display()),
        ));
    }
    fs::canonicalize(path).map_err(|error| {
        TransactionError::new(
            "transaction-replacement-invalid",
            format!("failed to resolve replacement {}: {error}", path.display()),
        )
    })
}

fn prepare_directory(path: &Path, label: &str) -> Result<PathBuf, TransactionError> {
    // Validate existing ancestors before create_dir_all can traverse them.
    reject_reparse_components(path).map_err(|error| {
        TransactionError::new(
            "transaction-directory-failed",
            format!("{label} contains an unsafe reparse component: {error}"),
        )
    })?;
    fs::create_dir_all(path).map_err(|error| {
        TransactionError::new(
            "transaction-directory-failed",
            format!("failed to create {label} {}: {error}", path.display()),
        )
    })?;
    reject_reparse_components(path).map_err(|error| {
        TransactionError::new(
            "transaction-directory-failed",
            format!("{label} contains an unsafe reparse component: {error}"),
        )
    })?;
    let path = fs::canonicalize(path).map_err(|error| {
        TransactionError::new(
            "transaction-directory-failed",
            format!("failed to resolve {label} {}: {error}", path.display()),
        )
    })?;
    reject_reparse(&path).map_err(|error| {
        TransactionError::new(
            "transaction-directory-failed",
            format!("{label} is not a normal directory: {error}"),
        )
    })?;
    Ok(path)
}

fn create_transaction_directory(parent: &Path) -> Result<(String, PathBuf), TransactionError> {
    let root = parent.join(TXN_ROOT_NAME);
    if let Ok(metadata) = fs::symlink_metadata(&root) {
        reject_reparse_metadata(&root, &metadata).map_err(|error| {
            TransactionError::new(
                "transaction-directory-failed",
                format!("transaction root is not a normal directory: {error}"),
            )
        })?;
        if !metadata.is_dir() {
            return Err(TransactionError::new(
                "transaction-directory-failed",
                format!("transaction root is not a directory: {}", root.display()),
            ));
        }
    } else {
        fs::create_dir(&root).map_err(|error| {
            TransactionError::new(
                "transaction-directory-failed",
                format!(
                    "failed to create transaction root {}: {error}",
                    root.display()
                ),
            )
        })?;
    }

    for _ in 0..64 {
        let id = next_transaction_id();
        let directory = root.join(&id);
        match fs::create_dir(&directory) {
            Ok(()) => return Ok((id, directory)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(TransactionError::new(
                    "transaction-directory-failed",
                    format!(
                        "failed to create transaction directory {}: {error}",
                        directory.display()
                    ),
                ))
            }
        }
    }
    Err(TransactionError::new(
        "transaction-directory-failed",
        "could not allocate a unique transaction directory",
    ))
}

fn next_transaction_id() -> String {
    let sequence = NEXT_TRANSACTION_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}-{sequence}", std::process::id())
}

fn fingerprint_required(path: &Path) -> Result<SourceFingerprint, String> {
    FileBaseSnapshot::fingerprint_path(path, IO_CHUNK_SIZE).map_err(|error| error.to_string())
}

fn fingerprint_if_exists(path: &Path) -> Result<Option<SourceFingerprint>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_reparse_metadata(path, &metadata)?;
            if !metadata.is_file() {
                return Err(format!("path is not a regular file: {}", path.display()));
            }
            fingerprint_required(path).map(Some)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect {}: {error}", path.display())),
    }
}

#[cfg(test)]
fn open_target_without_delete_share(path: &Path) -> Option<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        return OpenOptions::new().read(true).share_mode(0).open(path).ok();
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_reparse_metadata(path, &metadata)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("failed to inspect {}: {error}", path.display())),
    }
}

fn same_content(left: &SourceFingerprint, right: &SourceFingerprint) -> bool {
    left.size_bytes == right.size_bytes && left.sha256 == right.sha256
}

fn matches_expected(
    actual: Option<&SourceFingerprint>,
    expected: Option<&SourceFingerprint>,
) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(actual), Some(expected)) => same_content(actual, expected),
        _ => false,
    }
}

fn fingerprint_record(fingerprint: &SourceFingerprint) -> FingerprintRecord {
    FingerprintRecord {
        size_bytes: fingerprint.size_bytes,
        sha256: fingerprint.sha256_hex(),
        modified_millis: fingerprint.modified.map(|value| {
            value
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
                .unwrap_or_default()
        }),
    }
}

fn serialized_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|error| format!("failed to serialize JSON: {error}"))
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}

fn copy_to_new_synced(source: &Path, destination: &Path) -> io::Result<()> {
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut buffer = vec![0_u8; IO_CHUNK_SIZE];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
    }
    output.flush()?;
    output.sync_all()
}

fn replace_metadata_file(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let source_wide = encode_path(source).map_err(io::Error::other)?;
        let destination_wide = encode_path(destination).map_err(io::Error::other)?;
        unsafe {
            MoveFileExW(
                PCWSTR(source_wide.as_ptr()),
                PCWSTR(destination_wide.as_ptr()),
                MOVEFILE_REPLACE_EXISTING,
            )
        }
        .map_err(|error| io::Error::other(format!("MoveFileExW metadata replace failed: {error}")))
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}

fn remove_owned_file(path: &Path, expected: Option<&SourceFingerprint>) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect {}: {error}", path.display())),
    };
    reject_reparse_metadata(path, &metadata)?;
    if !metadata.is_file() {
        return Err(format!(
            "refusing to remove non-file artifact {}",
            path.display()
        ));
    }
    if let Some(expected) = expected {
        let actual = fingerprint_required(path)?;
        if !same_content(&actual, expected) {
            return Err(format!(
                "refusing to remove artifact {} whose content changed",
                path.display()
            ));
        }
    }
    fs::remove_file(path).map_err(|error| format!("failed to remove {}: {error}", path.display()))
}

fn remove_owned_index(path: &Path, expected_bytes: &[u8]) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect index {}: {error}", path.display()))?;
    reject_reparse_metadata(path, &metadata)?;
    if !metadata.is_file() {
        return Err(format!(
            "refusing to remove non-file index {}",
            path.display()
        ));
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read index {}: {error}", path.display()))?;
    if bytes != expected_bytes {
        return Err(format!(
            "recovery index changed before cleanup: {}",
            path.display()
        ));
    }
    fs::remove_file(path)
        .map_err(|error| format!("failed to remove index {}: {error}", path.display()))
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "macos")]
    return left == right || same_file::is_same_file(left, right).unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    { path_key(left) == path_key(right) }
}

#[cfg(not(target_os = "macos"))]
fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn is_within(path: &Path, root: &Path) -> bool {
    #[cfg(target_os = "macos")]
    return path.starts_with(root);
    #[cfg(not(target_os = "macos"))]
    {
    let path = path_key(path);
    let root = path_key(root);
    path == root || path.starts_with(&(root + "\\"))
    }
}

fn validate_transaction_id(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn reject_reparse(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    reject_reparse_metadata(path, &metadata)
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
        #[cfg(target_os = "macos")]
        if (component == Path::new("/var") || component == Path::new("/tmp"))
            && fs::canonicalize(&component).ok().as_deref() == Some(Path::new("/private").join(component.file_name().unwrap()).as_path())
        {
            // Darwin exposes both system directories through root-owned aliases.
            // Their descendants are still checked individually.
            continue;
        }
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

fn encode_path(path: &Path) -> Result<Vec<u16>, String> {
    #[cfg(windows)]
    {
        if path.as_os_str().encode_wide().any(|value| value == 0) {
            return Err(format!("path contains an embedded NUL: {}", path.display()));
        }
        let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
        encoded.push(0);
        Ok(encoded)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(Vec::new())
    }
}

/// Discover only indexed transactions under caller-supplied allowed roots.
/// This function intentionally has no write/delete side effects.
pub(crate) fn discover_recovery(
    index_root: impl AsRef<Path>,
    allowed_target_roots: &[PathBuf],
) -> io::Result<Vec<RecoveryCandidate>> {
    let index_root = index_root.as_ref();
    match fs::symlink_metadata(index_root) {
        Ok(metadata) => {
            if let Err(error) = reject_reparse_metadata(index_root, &metadata) {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, error));
            }
            if !metadata.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "recovery index root is not a directory: {}",
                        index_root.display()
                    ),
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    }
    let entries = match fs::read_dir(index_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let allowed_roots = allowed_target_roots
        .iter()
        .filter(|root| reject_reparse_components(root).is_ok())
        .filter_map(|root| fs::canonicalize(root).ok())
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) => {
                candidates.push(untrusted_candidate(
                    String::new(),
                    PathBuf::new(),
                    PathBuf::new(),
                    format!("failed to inspect index entry: {error}"),
                ));
                continue;
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some(&INDEX_SUFFIX[1..]) {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(value) => value,
            Err(error) => {
                candidates.push(untrusted_candidate(
                    String::new(),
                    PathBuf::new(),
                    PathBuf::new(),
                    format!("failed to read index entry: {error}"),
                ));
                continue;
            }
        };
        let record = match serde_json::from_slice::<RecoveryIndexRecord>(&bytes) {
            Ok(value) => value,
            Err(error) => {
                candidates.push(untrusted_candidate(
                    String::new(),
                    PathBuf::new(),
                    PathBuf::new(),
                    format!("invalid recovery index JSON: {error}"),
                ));
                continue;
            }
        };
        let target_parent = PathBuf::from(&record.target_parent);
        let target_path = PathBuf::from(&record.target_path);
        if record.schema != INDEX_SCHEMA
            || !validate_transaction_id(&record.transaction_id)
            || !target_parent.is_absolute()
            || !target_path.is_absolute()
            || reject_reparse_components(&target_parent).is_err()
            || !allowed_roots
                .iter()
                .any(|root| is_within(&target_parent, root))
        {
            candidates.push(untrusted_candidate(
                record.transaction_id,
                target_path,
                PathBuf::new(),
                "index entry failed schema, id, absolute-path, or allowed-root validation"
                    .to_string(),
            ));
            continue;
        }
        let target_parent = match fs::canonicalize(&target_parent) {
            Ok(value) => value,
            Err(error) => {
                candidates.push(untrusted_candidate(
                    record.transaction_id,
                    target_path,
                    PathBuf::new(),
                    format!("target parent cannot be resolved: {error}"),
                ));
                continue;
            }
        };
        if !allowed_roots
            .iter()
            .any(|root| is_within(&target_parent, root))
        {
            candidates.push(untrusted_candidate(
                record.transaction_id,
                target_path,
                PathBuf::new(),
                "resolved target parent escaped allowed roots".to_string(),
            ));
            continue;
        }
        let target_name = match target_path.file_name() {
            Some(value) => value,
            None => {
                candidates.push(untrusted_candidate(
                    record.transaction_id,
                    target_path,
                    PathBuf::new(),
                    "indexed target has no file name".to_string(),
                ));
                continue;
            }
        };
        if target_name == "." || target_name == ".." {
            candidates.push(untrusted_candidate(
                record.transaction_id,
                target_path,
                PathBuf::new(),
                "indexed target uses a reserved file name".to_string(),
            ));
            continue;
        }
        let derived_target = target_parent.join(target_name);
        if !same_path(&derived_target, &target_path) {
            candidates.push(untrusted_candidate(
                record.transaction_id,
                target_path,
                PathBuf::new(),
                "indexed target does not match canonical parent plus file name".to_string(),
            ));
            continue;
        }
        let transaction_root = target_parent.join(TXN_ROOT_NAME);
        let transaction_dir = transaction_root.join(&record.transaction_id);
        let root_metadata = match fs::symlink_metadata(&transaction_root) {
            Ok(value) => value,
            Err(error) => {
                candidates.push(untrusted_candidate(
                    record.transaction_id,
                    derived_target,
                    transaction_dir,
                    format!("transaction root is unavailable: {error}"),
                ));
                continue;
            }
        };
        let dir_metadata = match fs::symlink_metadata(&transaction_dir) {
            Ok(value) => value,
            Err(error) => {
                candidates.push(untrusted_candidate(
                    record.transaction_id,
                    derived_target,
                    transaction_dir,
                    format!("transaction directory is unavailable: {error}"),
                ));
                continue;
            }
        };
        if reject_reparse_metadata(&transaction_root, &root_metadata).is_err()
            || reject_reparse_metadata(&transaction_dir, &dir_metadata).is_err()
            || !root_metadata.is_dir()
            || !dir_metadata.is_dir()
            || !is_within(&transaction_dir, &target_parent)
        {
            candidates.push(untrusted_candidate(
                record.transaction_id,
                derived_target,
                transaction_dir,
                "transaction directory failed ownership or reparse validation".to_string(),
            ));
            continue;
        }
        let manifest_path = transaction_dir.join(MANIFEST_NAME);
        let manifest_metadata = match fs::symlink_metadata(&manifest_path) {
            Ok(value) => value,
            Err(_) => {
                candidates.push(untrusted_candidate(
                    record.transaction_id,
                    derived_target,
                    transaction_dir,
                    "manifest is missing".to_string(),
                ));
                continue;
            }
        };
        if reject_reparse_metadata(&manifest_path, &manifest_metadata).is_err()
            || !manifest_metadata.is_file()
        {
            candidates.push(untrusted_candidate(
                record.transaction_id,
                derived_target,
                transaction_dir,
                "manifest is not a normal file".to_string(),
            ));
            continue;
        }
        let manifest = match fs::read(&manifest_path)
            .ok()
            .and_then(|value| serde_json::from_slice::<ManifestRecord>(&value).ok())
        {
            Some(value) => value,
            None => {
                candidates.push(untrusted_candidate(
                    record.transaction_id,
                    derived_target,
                    transaction_dir,
                    "manifest is invalid".to_string(),
                ));
                continue;
            }
        };
        if manifest.schema != MANIFEST_SCHEMA
            || manifest.transaction_id != record.transaction_id
            || !same_path(Path::new(&manifest.target_path), &derived_target)
            || manifest.replacement != REPLACEMENT_NAME
            || manifest.output_artifact != OUTPUT_NAME
            || manifest.backup != BACKUP_NAME
        {
            candidates.push(untrusted_candidate(
                record.transaction_id,
                derived_target,
                transaction_dir,
                "manifest failed fixed-artifact or target validation".to_string(),
            ));
            continue;
        }
        let mut artifacts_valid = true;
        for artifact in [REPLACEMENT_NAME, OUTPUT_NAME, BACKUP_NAME] {
            let path = transaction_dir.join(artifact);
            if let Ok(metadata) = fs::symlink_metadata(&path) {
                if reject_reparse_metadata(&path, &metadata).is_err() || !metadata.is_file() {
                    artifacts_valid = false;
                    break;
                }
            }
        }
        if !artifacts_valid {
            candidates.push(untrusted_candidate(
                record.transaction_id,
                derived_target,
                transaction_dir,
                "transaction artifact is not a normal file".to_string(),
            ));
            continue;
        }
        candidates.push(RecoveryCandidate {
            transaction_id: record.transaction_id,
            target_path: derived_target,
            transaction_dir,
            trusted: true,
            reason: None,
        });
    }
    Ok(candidates)
}

fn untrusted_candidate(
    transaction_id: String,
    target_path: PathBuf,
    transaction_dir: PathBuf,
    reason: String,
) -> RecoveryCandidate {
    RecoveryCandidate {
        transaction_id,
        target_path,
        transaction_dir,
        trusted: false,
        reason: Some(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        discover_recovery, same_content, DiskWriteStatus, FileReplaceTransaction,
        TransactionOutcome,
    };
    use crate::commands::large_file_base::FileBaseSnapshot;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    fn test_root(label: &str) -> PathBuf {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "lightmark-file-replace-{label}-{}-{timestamp}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn replacement(root: &Path, bytes: &[u8]) -> PathBuf {
        let path = root.join("replacement-input.md");
        fs::write(&path, bytes).unwrap();
        path
    }

    fn fingerprint(path: &Path) -> super::SourceFingerprint {
        FileBaseSnapshot::fingerprint_path(path, 1024).unwrap()
    }

    #[test]
    fn existing_target_commit_requires_expected_backup_and_cleans_owned_artifacts() {
        let root = test_root("commit");
        let target = root.join("note.md");
        let input = replacement(&root, b"new bytes");
        fs::write(&target, b"old bytes").unwrap();
        let legacy_temp = target.with_extension("md.lightmark-tmp");
        let legacy_backup = target.with_extension("md.lightmark-bak");
        fs::write(&legacy_temp, b"legacy temp sentinel").unwrap();
        fs::write(&legacy_backup, b"legacy backup sentinel").unwrap();
        let expected = fingerprint(&target);
        let index = root.join("private-index");

        let transaction =
            FileReplaceTransaction::prepare(&target, Some(expected), &input, &index).unwrap();
        let txn_dir = transaction.transaction_dir().to_path_buf();
        let receipt = transaction.commit();

        assert_eq!(receipt.outcome, TransactionOutcome::Committed);
        assert_eq!(receipt.disk_written, DiskWriteStatus::Yes);
        assert_eq!(fs::read(&target).unwrap(), b"new bytes");
        assert_eq!(fs::read(&legacy_temp).unwrap(), b"legacy temp sentinel");
        assert_eq!(fs::read(&legacy_backup).unwrap(), b"legacy backup sentinel");
        assert!(!txn_dir.exists());
        assert!(fs::read_dir(index).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_external_version_is_conflict_and_preserves_external_and_new_bytes() {
        let root = test_root("backup-conflict");
        let target = root.join("note.md");
        let input = replacement(&root, b"new bytes");
        fs::write(&target, b"old bytes").unwrap();
        let expected = fingerprint(&target);
        let index = root.join("private-index");
        let transaction = FileReplaceTransaction::prepare(&target, Some(expected), &input, &index)
            .unwrap()
            .with_before_replace_hook(|target| {
                fs::write(target, b"raced E!!").unwrap();
            });
        let txn_dir = transaction.transaction_dir().to_path_buf();
        let receipt = transaction.commit();

        assert_eq!(receipt.outcome, TransactionOutcome::Conflict);
        assert_eq!(receipt.disk_written, DiskWriteStatus::Yes);
        assert_eq!(fs::read(&target).unwrap(), b"new bytes");
        assert_eq!(fs::read(receipt.backup_path).unwrap(), b"raced E!!");
        assert_eq!(fs::read(receipt.output_path).unwrap(), b"new bytes");
        assert!(txn_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn post_replace_external_write_keeps_independent_output_after_replacement_moves() {
        let root = test_root("post-replace-conflict");
        let target = root.join("note.md");
        let input = replacement(&root, b"new bytes");
        fs::write(&target, b"old bytes").unwrap();
        let expected = fingerprint(&target);
        let index = root.join("private-index");
        let transaction = FileReplaceTransaction::prepare(&target, Some(expected), &input, &index)
            .unwrap()
            .with_after_replace_hook(|target| {
                fs::write(target, b"raced E2!").unwrap();
            });
        let replacement_path = transaction.replacement_path().to_path_buf();
        let receipt = transaction.commit();

        assert_eq!(receipt.outcome, TransactionOutcome::Conflict);
        assert_eq!(receipt.disk_written, DiskWriteStatus::Yes);
        assert_eq!(fs::read(&target).unwrap(), b"raced E2!");
        assert!(!replacement_path.exists());
        assert_eq!(fs::read(receipt.output_path).unwrap(), b"new bytes");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_only_race_refuses_new_target_without_overwrite() {
        let root = test_root("create-race");
        let target = root.join("new.md");
        let input = replacement(&root, b"new bytes");
        let index = root.join("private-index");
        let transaction = FileReplaceTransaction::prepare(&target, None, &input, &index)
            .unwrap()
            .with_before_replace_hook(|target| {
                fs::write(target, b"external E").unwrap();
            });
        let receipt = transaction.commit();

        assert_eq!(receipt.outcome, TransactionOutcome::Conflict);
        assert_eq!(receipt.disk_written, DiskWriteStatus::No);
        assert_eq!(fs::read(&target).unwrap(), b"external E");
        assert_eq!(fs::read(receipt.output_path).unwrap(), b"new bytes");
        assert!(receipt.recovery_artifact.unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_failure_is_committed_success_with_warning_and_artifact() {
        let root = test_root("cleanup-failure");
        let target = root.join("note.md");
        let input = replacement(&root, b"new bytes");
        fs::write(&target, b"old bytes").unwrap();
        let expected = fingerprint(&target);
        let index = root.join("private-index");
        let transaction = FileReplaceTransaction::prepare(&target, Some(expected), &input, &index)
            .unwrap()
            .with_cleanup_failure();
        let receipt = transaction.commit();

        assert_eq!(receipt.outcome, TransactionOutcome::Committed);
        assert_eq!(receipt.disk_written, DiskWriteStatus::Yes);
        assert!(receipt.cleanup_warning.is_some());
        assert!(receipt.recovery_artifact.unwrap().exists());
        assert_eq!(fs::read(&target).unwrap(), b"new bytes");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_share_violation_is_not_committed_with_b_and_n_retained() {
        let root = test_root("share-violation");
        let target = root.join("note.md");
        let input = replacement(&root, b"new bytes");
        fs::write(&target, b"old bytes").unwrap();
        let expected = fingerprint(&target);
        let index = root.join("private-index");
        let transaction = FileReplaceTransaction::prepare(&target, Some(expected), &input, &index)
            .unwrap()
            .with_target_share_violation();
        let receipt = transaction.commit();

        #[cfg(windows)]
        {
            assert_eq!(receipt.outcome, TransactionOutcome::NotCommitted);
            assert_eq!(receipt.disk_written, DiskWriteStatus::No);
            assert_eq!(fs::read(&target).unwrap(), b"old bytes");
            assert_eq!(fs::read(receipt.replacement_path).unwrap(), b"new bytes");
            assert_eq!(fs::read(receipt.output_path).unwrap(), b"new bytes");
            assert!(receipt.recovery_artifact.unwrap().exists());
        }
        #[cfg(not(windows))]
        {
            assert_eq!(receipt.outcome, TransactionOutcome::Ambiguous);
            assert_eq!(receipt.disk_written, DiskWriteStatus::Unknown);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unrecognized_state_is_explicitly_ambiguous_classifier_fixture() {
        // This is a pure classifier fixture.  It documents an evidence gap;
        // it is not presented as a reproducible OS crash/error transition.
        let root = test_root("ambiguous-classifier");
        let expected_path = root.join("expected");
        let new_path = root.join("new");
        fs::write(&expected_path, b"old bytes").unwrap();
        fs::write(&new_path, b"new bytes").unwrap();
        let expected = fingerprint(&expected_path);
        let new_fingerprint = fingerprint(&new_path);
        let native = super::NativeCall {
            succeeded: false,
            code: Some(5),
            message: "fixture: unspecified native failure".to_string(),
        };
        let (outcome, disk_written, message) = super::classify_existing(
            &native,
            Some(&expected),
            None,
            None,
            Some(&new_fingerprint),
            &expected,
            &new_fingerprint,
        );

        assert_eq!(outcome, TransactionOutcome::Ambiguous);
        assert_eq!(disk_written, DiskWriteStatus::Unknown);
        assert!(message.contains("unclassified"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_discovery_rejects_manifest_paths_and_index_roots_outside_allowlist() {
        let root = test_root("recovery-boundary");
        let index = root.join("private-index");
        fs::create_dir_all(&index).unwrap();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let index_file = index.join("bad-1.json");
        let record = serde_json::json!({
            "schema": 1,
            "transaction_id": "bad-1",
            "target_parent": outside.to_string_lossy(),
            "target_path": outside.join("note.md").to_string_lossy(),
        });
        fs::write(&index_file, serde_json::to_vec(&record).unwrap()).unwrap();
        let candidates = discover_recovery(&index, &[root.clone()]).unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(!candidates[0].trusted);
        assert!(candidates[0].reason.is_some());
        assert!(!outside.join("note.md").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_discovery_rejects_valid_json_with_out_of_allowlist_parent() {
        let root = test_root("recovery-outside");
        let index = root.join("private-index");
        let outside = test_root("recovery-outside-target");
        fs::create_dir_all(&index).unwrap();
        let record = serde_json::json!({
            "schema": 1,
            "transaction_id": "safe-id",
            "target_parent": outside.to_string_lossy(),
            "target_path": outside.join("note.md").to_string_lossy(),
        });
        fs::write(
            index.join("safe-id.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        let candidates = discover_recovery(&index, &[root.clone()]).unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(!candidates[0].trusted);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn independent_copy_has_new_content_after_target_changes() {
        let root = test_root("independent-copy");
        let target = root.join("note.md");
        let input = replacement(&root, b"new bytes");
        fs::write(&target, b"old bytes").unwrap();
        let expected = fingerprint(&target);
        let index = root.join("private-index");
        let transaction =
            FileReplaceTransaction::prepare(&target, Some(expected), &input, &index).unwrap();
        let output_before = fingerprint(transaction.output_path());
        fs::write(&target, b"external").unwrap();
        let output_after = fingerprint(transaction.output_path());
        assert!(same_content(&output_before, &output_after));
        assert_eq!(fs::read(transaction.output_path()).unwrap(), b"new bytes");
        fs::remove_dir_all(root).unwrap();
    }
}
