use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::SystemTime,
};

use super::large_text_view::{BaseLine, ByteSpan, ImmutableBase};

pub const DEFAULT_IO_CHUNK_SIZE: usize = 64 * 1024;

/// Metadata and content hash captured for the source at snapshot time.
///
/// The hash is authoritative for conflict detection. The timestamp is retained
/// as diagnostic information and as a cheap early signal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceFingerprint {
    pub size_bytes: u64,
    pub modified: Option<SystemTime>,
    pub sha256: [u8; 32],
}

impl SourceFingerprint {
    pub fn sha256_hex(&self) -> String {
        self.sha256
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

#[derive(Clone, Debug)]
pub struct SnapshotOptions {
    /// The bounded buffer size used for copy, reads, writes, and hashing.
    pub io_chunk_size: usize,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            io_chunk_size: DEFAULT_IO_CHUNK_SIZE,
        }
    }
}

#[derive(Debug)]
pub enum SnapshotError {
    InvalidOwnerId,
    InvalidChunkSize,
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Cleanup {
        path: PathBuf,
        source: io::Error,
    },
    CleanupAfterFailure {
        path: PathBuf,
        primary: Box<SnapshotError>,
        source: io::Error,
    },
    InvalidUtf8 {
        offset: u64,
    },
    SourceChanged {
        path: PathBuf,
    },
    InvalidSpan {
        start: u64,
        len: u64,
        size: u64,
    },
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidOwnerId => write!(formatter, "invalid snapshot owner id"),
            Self::InvalidChunkSize => write!(formatter, "snapshot IO chunk size must be positive"),
            Self::Io {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "failed to {operation} {}: {source}",
                path.display()
            ),
            Self::Cleanup { path, source } => {
                write!(
                    formatter,
                    "failed to clean snapshot {}: {source}",
                    path.display()
                )
            }
            Self::CleanupAfterFailure {
                path,
                primary,
                source,
            } => write!(
                formatter,
                "{primary}; additionally failed to clean snapshot {}: {source}",
                path.display()
            ),
            Self::InvalidUtf8 { offset } => {
                write!(formatter, "source is not valid UTF-8 at byte {offset}")
            }
            Self::SourceChanged { path } => {
                write!(
                    formatter,
                    "source changed while creating or checking snapshot: {}",
                    path.display()
                )
            }
            Self::InvalidSpan { start, len, size } => write!(
                formatter,
                "snapshot span {start}..{} is outside {size} bytes",
                start.saturating_add(*len)
            ),
        }
    }
}

impl std::error::Error for SnapshotError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. }
            | Self::Cleanup { source, .. }
            | Self::CleanupAfterFailure { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// A source file copied into a session-owned immutable snapshot.
///
/// The snapshot owns its directory. Dropping the object closes its read-only
/// handle but keeps the directory as recovery material; explicit cleanup
/// removes only that directory. It never removes or writes the source file.
/// Creation also verifies the source before and after copying. This detects
/// ordinary concurrent modifications, while the unavoidable final TOCTOU
/// window remains a responsibility of the later save transaction.
pub struct FileBaseSnapshot {
    source_path: PathBuf,
    snapshot_dir: PathBuf,
    snapshot_path: PathBuf,
    lines: Vec<BaseLine>,
    prefix: Option<ByteSpan>,
    size_bytes: u64,
    fingerprint: SourceFingerprint,
    io_chunk_size: usize,
    max_io_read: AtomicUsize,
    snapshot_file: Mutex<Option<File>>,
}

impl FileBaseSnapshot {
    pub fn create(
        source_path: impl AsRef<Path>,
        snapshot_root: impl AsRef<Path>,
        owner_id: &str,
    ) -> Result<Self, SnapshotError> {
        Self::create_with_options(
            source_path,
            snapshot_root,
            owner_id,
            SnapshotOptions::default(),
        )
    }

    pub fn create_with_options(
        source_path: impl AsRef<Path>,
        snapshot_root: impl AsRef<Path>,
        owner_id: &str,
        options: SnapshotOptions,
    ) -> Result<Self, SnapshotError> {
        Self::create_impl(source_path, snapshot_root, owner_id, options, None)
    }

    /// Build a new immutable base from a caller-owned, already rendered
    /// temporary file. The temporary file is copied and validated with the
    /// normal strict-UTF-8 path, then the logical source path is rebound to
    /// the destination that will be published after the caller's final
    /// session/fingerprint check. This lets save prepare a complete new base
    /// before replacing the live file without exposing a partially rebased
    /// session.
    pub(crate) fn create_from_stable_owned_file(
        owned_path: impl AsRef<Path>,
        logical_source_path: impl AsRef<Path>,
        snapshot_root: impl AsRef<Path>,
        owner_id: &str,
    ) -> Result<Self, SnapshotError> {
        let mut snapshot = Self::create(owned_path.as_ref(), snapshot_root, owner_id)?;
        snapshot.source_path = logical_source_path.as_ref().to_path_buf();
        Ok(snapshot)
    }

    #[cfg(test)]
    fn create_for_test_with_copy_hook(
        source_path: impl AsRef<Path>,
        snapshot_root: impl AsRef<Path>,
        owner_id: &str,
        options: SnapshotOptions,
        hook: &mut dyn FnMut(u64),
    ) -> Result<Self, SnapshotError> {
        Self::create_impl(source_path, snapshot_root, owner_id, options, Some(hook))
    }

    fn create_impl(
        source_path: impl AsRef<Path>,
        snapshot_root: impl AsRef<Path>,
        owner_id: &str,
        options: SnapshotOptions,
        copy_hook: Option<&mut dyn FnMut(u64)>,
    ) -> Result<Self, SnapshotError> {
        validate_options(&options)?;
        validate_owner_id(owner_id)?;

        let source_path = source_path.as_ref().to_path_buf();
        let source_before = source_metadata(&source_path)?;
        let snapshot_root = prepare_snapshot_root(snapshot_root.as_ref())?;
        let snapshot_dir = snapshot_root.join(owner_id);
        fs::create_dir(&snapshot_dir).map_err(|source| SnapshotError::Io {
            operation: "create snapshot directory",
            path: snapshot_dir.clone(),
            source,
        })?;
        let temporary_path = snapshot_dir.join("base.tmp");
        let snapshot_path = snapshot_dir.join("base.md");

        let copied = match copy_and_index(
            &source_path,
            &temporary_path,
            source_before,
            &options,
            copy_hook,
        ) {
            Ok(value) => value,
            Err(primary) => return Err(cleanup_after_failure(snapshot_dir, primary)),
        };

        let source_after = match source_metadata(&source_path) {
            Ok(metadata) => metadata,
            Err(primary) => return Err(cleanup_after_failure(snapshot_dir, primary)),
        };
        if source_after != source_before
            || source_after.0 != copied.size_bytes
            || source_after.1 != copied.fingerprint.modified
        {
            let primary = SnapshotError::SourceChanged {
                path: source_path.clone(),
            };
            return Err(cleanup_after_failure(snapshot_dir, primary));
        }

        // A second source pass catches same-size/content changes that metadata
        // alone cannot detect. The private copy remains the only accepted base.
        let current = match fingerprint_path(&source_path, options.io_chunk_size) {
            Ok(value) => value,
            Err(primary) => return Err(cleanup_after_failure(snapshot_dir, primary)),
        };
        if current != copied.fingerprint {
            let primary = SnapshotError::SourceChanged {
                path: source_path.clone(),
            };
            return Err(cleanup_after_failure(snapshot_dir, primary));
        }

        fs::rename(&temporary_path, &snapshot_path).map_err(|source| {
            cleanup_after_failure(
                snapshot_dir.clone(),
                SnapshotError::Io {
                    operation: "finalize snapshot",
                    path: snapshot_path.clone(),
                    source,
                },
            )
        })?;

        let snapshot_file = match open_snapshot_readonly(&snapshot_path) {
            Ok(file) => file,
            Err(source) => {
                let primary = SnapshotError::Io {
                    operation: "open finalized snapshot",
                    path: snapshot_path.clone(),
                    source,
                };
                return Err(cleanup_after_failure(snapshot_dir, primary));
            }
        };

        Ok(Self {
            source_path,
            snapshot_dir,
            snapshot_path,
            lines: copied.lines,
            prefix: copied.prefix,
            size_bytes: copied.size_bytes,
            fingerprint: copied.fingerprint,
            io_chunk_size: options.io_chunk_size,
            max_io_read: AtomicUsize::new(0),
            snapshot_file: Mutex::new(Some(snapshot_file)),
        })
    }

    pub fn source_path(&self) -> &Path {
        &self.source_path
    }

    pub fn snapshot_dir(&self) -> &Path {
        &self.snapshot_dir
    }

    pub fn snapshot_path(&self) -> &Path {
        &self.snapshot_path
    }

    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    pub fn fingerprint(&self) -> &SourceFingerprint {
        &self.fingerprint
    }

    pub fn line_spans(&self) -> &[BaseLine] {
        &self.lines
    }

    /// A UTF-8 BOM is file prefix metadata, not an editable UTF-16 column.
    pub fn prefix(&self) -> Option<ByteSpan> {
        self.prefix
    }

    pub fn max_io_read(&self) -> usize {
        self.max_io_read.load(Ordering::Relaxed)
    }

    /// Re-hash the live source and reject detected external changes.
    ///
    /// This check is intentionally separate from snapshot creation. A caller
    /// must run it at the save boundary, immediately before its own file
    /// replacement transaction.
    pub fn verify_source_unchanged(&self) -> Result<(), SnapshotError> {
        let current = fingerprint_path(&self.source_path, self.io_chunk_size)?;
        if current == self.fingerprint {
            Ok(())
        } else {
            Err(SnapshotError::SourceChanged {
                path: self.source_path.clone(),
            })
        }
    }

    /// Compute a complete fingerprint for a path using the same strict,
    /// chunked reader used during snapshot creation. This is public so the
    /// command layer can re-check the live file at a save boundary without
    /// reaching into snapshot internals.
    pub fn fingerprint_path(
        path: impl AsRef<Path>,
        io_chunk_size: usize,
    ) -> Result<SourceFingerprint, SnapshotError> {
        fingerprint_path(path.as_ref(), io_chunk_size)
    }

    pub fn cleanup(self) -> Result<(), SnapshotError> {
        let mut snapshot = self;
        let directory = snapshot.snapshot_dir.clone();
        snapshot.close_snapshot_file();
        remove_owned_snapshot_dir(&directory)
    }

    fn validate_span(&self, span: ByteSpan) -> Result<(u64, u64), SnapshotError> {
        let end = span
            .start
            .checked_add(span.len)
            .ok_or(SnapshotError::InvalidSpan {
                start: span.start,
                len: span.len,
                size: self.size_bytes,
            })?;
        if end > self.size_bytes {
            return Err(SnapshotError::InvalidSpan {
                start: span.start,
                len: span.len,
                size: self.size_bytes,
            });
        }
        Ok((span.start, end))
    }

    fn read_span_checked(&self, span: ByteSpan) -> Result<Vec<u8>, SnapshotError> {
        let (start, end) = self.validate_span(span)?;
        let length = usize::try_from(end - start).map_err(|_| SnapshotError::InvalidSpan {
            start,
            len: end - start,
            size: self.size_bytes,
        })?;
        let mut file_guard = self.snapshot_file.lock().map_err(|_| SnapshotError::Io {
            operation: "lock snapshot",
            path: self.snapshot_path.clone(),
            source: io::Error::new(io::ErrorKind::Other, "snapshot lock poisoned"),
        })?;
        let file = file_guard.as_mut().ok_or_else(|| SnapshotError::Io {
            operation: "read closed snapshot",
            path: self.snapshot_path.clone(),
            source: io::Error::new(io::ErrorKind::Other, "snapshot handle is closed"),
        })?;
        file.seek(SeekFrom::Start(start))
            .map_err(|source| SnapshotError::Io {
                operation: "seek snapshot",
                path: self.snapshot_path.clone(),
                source,
            })?;

        let mut output = Vec::with_capacity(length);
        let mut remaining = length;
        let mut buffer = vec![0_u8; self.io_chunk_size.min(remaining.max(1))];
        while remaining > 0 {
            let request = remaining.min(buffer.len());
            self.max_io_read.fetch_max(request, Ordering::Relaxed);
            file.read_exact(&mut buffer[..request])
                .map_err(|source| SnapshotError::Io {
                    operation: "read snapshot",
                    path: self.snapshot_path.clone(),
                    source,
                })?;
            output.extend_from_slice(&buffer[..request]);
            remaining -= request;
        }
        Ok(output)
    }

    fn write_span_checked(
        &self,
        span: ByteSpan,
        writer: &mut dyn Write,
    ) -> Result<(), SnapshotError> {
        let (start, end) = self.validate_span(span)?;
        let mut file_guard = self.snapshot_file.lock().map_err(|_| SnapshotError::Io {
            operation: "lock snapshot",
            path: self.snapshot_path.clone(),
            source: io::Error::new(io::ErrorKind::Other, "snapshot lock poisoned"),
        })?;
        let file = file_guard.as_mut().ok_or_else(|| SnapshotError::Io {
            operation: "read closed snapshot",
            path: self.snapshot_path.clone(),
            source: io::Error::new(io::ErrorKind::Other, "snapshot handle is closed"),
        })?;
        file.seek(SeekFrom::Start(start))
            .map_err(|source| SnapshotError::Io {
                operation: "seek snapshot",
                path: self.snapshot_path.clone(),
                source,
            })?;
        let mut remaining = end - start;
        let mut buffer = vec![0_u8; self.io_chunk_size];
        while remaining > 0 {
            let request = remaining.min(buffer.len() as u64) as usize;
            self.max_io_read.fetch_max(request, Ordering::Relaxed);
            file.read_exact(&mut buffer[..request])
                .map_err(|source| SnapshotError::Io {
                    operation: "read snapshot",
                    path: self.snapshot_path.clone(),
                    source,
                })?;
            writer
                .write_all(&buffer[..request])
                .map_err(|source| SnapshotError::Io {
                    operation: "write snapshot span",
                    path: self.snapshot_path.clone(),
                    source,
                })?;
            remaining -= request as u64;
        }
        Ok(())
    }

    fn close_snapshot_file(&mut self) {
        if let Ok(mut guard) = self.snapshot_file.lock() {
            let _ = guard.take();
        }
    }
}

impl ImmutableBase for FileBaseSnapshot {
    fn prefix(&self) -> Option<ByteSpan> {
        self.prefix
    }

    fn line_spans(&self) -> &[BaseLine] {
        &self.lines
    }

    fn read_span(&self, span: ByteSpan) -> Result<Vec<u8>, String> {
        self.read_span_checked(span)
            .map_err(|error| error.to_string())
    }

    fn write_span(&self, span: ByteSpan, writer: &mut dyn Write) -> Result<(), String> {
        self.write_span_checked(span, writer)
            .map_err(|error| error.to_string())
    }
}

struct CopiedSnapshot {
    lines: Vec<BaseLine>,
    prefix: Option<ByteSpan>,
    size_bytes: u64,
    fingerprint: SourceFingerprint,
}

fn copy_and_index(
    source_path: &Path,
    temporary_path: &Path,
    source_before: (u64, Option<SystemTime>),
    options: &SnapshotOptions,
    mut copy_hook: Option<&mut dyn FnMut(u64)>,
) -> Result<CopiedSnapshot, SnapshotError> {
    let mut input = File::open(source_path).map_err(|source| SnapshotError::Io {
        operation: "open source",
        path: source_path.to_path_buf(),
        source,
    })?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary_path)
        .map_err(|source| SnapshotError::Io {
            operation: "create snapshot temporary file",
            path: temporary_path.to_path_buf(),
            source,
        })?;

    let mut hash = Sha256::new();
    let mut validator = StrictUtf8Validator::default();
    let mut scanner = LineScanner::default();
    let mut prefix_detector = PrefixDetector::default();
    let mut bytes = 0_u64;
    let mut buffer = vec![0_u8; options.io_chunk_size];

    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|source| SnapshotError::Io {
                operation: "read source",
                path: source_path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        validator.push(chunk)?;
        scanner.push(chunk);
        prefix_detector.push(chunk);
        hash.update(chunk);
        output
            .write_all(chunk)
            .map_err(|source| SnapshotError::Io {
                operation: "write snapshot temporary file",
                path: temporary_path.to_path_buf(),
                source,
            })?;
        bytes = bytes.saturating_add(read as u64);
        if let Some(hook) = copy_hook.as_mut() {
            (**hook)(bytes);
        }
    }
    validator.finish()?;
    let prefix = prefix_detector.finish();
    let mut lines = scanner.finish();
    if let Some(prefix) = prefix {
        strip_prefix_from_first_line(&mut lines, prefix);
    }
    output.sync_all().map_err(|source| SnapshotError::Io {
        operation: "flush snapshot temporary file",
        path: temporary_path.to_path_buf(),
        source,
    })?;

    let fingerprint = SourceFingerprint {
        size_bytes: bytes,
        modified: source_before.1,
        sha256: hash.finalize().into(),
    };
    Ok(CopiedSnapshot {
        lines,
        prefix,
        size_bytes: bytes,
        fingerprint,
    })
}

fn strip_prefix_from_first_line(lines: &mut [BaseLine], prefix: ByteSpan) {
    let Some(first) = lines.first_mut() else {
        return;
    };
    let content_end = first.content.end();
    if first.content.start <= prefix.end() && content_end >= prefix.end() {
        first.content = ByteSpan::new(prefix.end(), content_end.saturating_sub(prefix.end()));
    }
}

fn fingerprint_path(path: &Path, chunk_size: usize) -> Result<SourceFingerprint, SnapshotError> {
    let before = source_metadata(path)?;
    let mut file = File::open(path).map_err(|source| SnapshotError::Io {
        operation: "open source for fingerprint",
        path: path.to_path_buf(),
        source,
    })?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = vec![0_u8; chunk_size];
    loop {
        let read = file.read(&mut buffer).map_err(|source| SnapshotError::Io {
            operation: "hash source",
            path: path.to_path_buf(),
            source,
        })?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes = bytes.saturating_add(read as u64);
    }
    let after = source_metadata(path)?;
    if before != after || before.0 != bytes {
        return Err(SnapshotError::SourceChanged {
            path: path.to_path_buf(),
        });
    }
    Ok(SourceFingerprint {
        size_bytes: bytes,
        modified: before.1,
        sha256: hash.finalize().into(),
    })
}

fn source_metadata(path: &Path) -> Result<(u64, Option<SystemTime>), SnapshotError> {
    let metadata = fs::metadata(path).map_err(|source| SnapshotError::Io {
        operation: "inspect source",
        path: path.to_path_buf(),
        source,
    })?;
    Ok((metadata.len(), metadata.modified().ok()))
}

fn open_snapshot_readonly(path: &Path) -> Result<File, io::Error> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        // Permit other readers while denying writes and deletion of the
        // snapshot while this session owns its handle.
        options.share_mode(0x0000_0001);
    }
    options.open(path)
}

fn prepare_snapshot_root(root: &Path) -> Result<PathBuf, SnapshotError> {
    fs::create_dir_all(root).map_err(|source| SnapshotError::Io {
        operation: "create snapshot root",
        path: root.to_path_buf(),
        source,
    })?;
    fs::canonicalize(root).map_err(|source| SnapshotError::Io {
        operation: "resolve snapshot root",
        path: root.to_path_buf(),
        source,
    })
}

fn validate_options(options: &SnapshotOptions) -> Result<(), SnapshotError> {
    if options.io_chunk_size == 0 {
        Err(SnapshotError::InvalidChunkSize)
    } else {
        Ok(())
    }
}

fn validate_owner_id(owner_id: &str) -> Result<(), SnapshotError> {
    if owner_id.is_empty()
        || owner_id == "."
        || owner_id == ".."
        || !owner_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(SnapshotError::InvalidOwnerId);
    }
    Ok(())
}

fn cleanup_after_failure(snapshot_dir: PathBuf, primary: SnapshotError) -> SnapshotError {
    match remove_owned_snapshot_dir(&snapshot_dir) {
        Ok(()) => primary,
        Err(SnapshotError::Cleanup { path, source }) => SnapshotError::CleanupAfterFailure {
            path,
            primary: Box::new(primary),
            source,
        },
        Err(other) => SnapshotError::CleanupAfterFailure {
            path: snapshot_dir,
            primary: Box::new(primary),
            source: io::Error::new(io::ErrorKind::Other, other.to_string()),
        },
    }
}

fn remove_owned_snapshot_dir(path: &Path) -> Result<(), SnapshotError> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(path).map_err(|source| SnapshotError::Cleanup {
        path: path.to_path_buf(),
        source,
    })
}

#[derive(Default)]
struct StrictUtf8Validator {
    carry: Vec<u8>,
    consumed: u64,
}

impl StrictUtf8Validator {
    fn push(&mut self, bytes: &[u8]) -> Result<(), SnapshotError> {
        let carry_len = self.carry.len() as u64;
        let data_start = self.consumed.saturating_sub(carry_len);
        let mut combined = Vec::with_capacity(self.carry.len() + bytes.len());
        combined.extend_from_slice(&self.carry);
        combined.extend_from_slice(bytes);
        self.consumed = self.consumed.saturating_add(bytes.len() as u64);

        match std::str::from_utf8(&combined) {
            Ok(_) => {
                self.carry.clear();
                Ok(())
            }
            Err(error) if error.error_len().is_none() => {
                self.carry = combined[error.valid_up_to()..].to_vec();
                Ok(())
            }
            Err(error) => Err(SnapshotError::InvalidUtf8 {
                offset: data_start.saturating_add(error.valid_up_to() as u64),
            }),
        }
    }

    fn finish(self) -> Result<(), SnapshotError> {
        if self.carry.is_empty() {
            Ok(())
        } else {
            Err(SnapshotError::InvalidUtf8 {
                offset: self.consumed.saturating_sub(self.carry.len() as u64),
            })
        }
    }
}

#[derive(Default)]
struct LineScanner {
    lines: Vec<BaseLine>,
    content_start: u64,
    cursor: u64,
    pending_cr: Option<u64>,
}

#[derive(Default)]
struct PrefixDetector {
    bytes: [u8; 3],
    length: usize,
}

impl PrefixDetector {
    fn push(&mut self, bytes: &[u8]) {
        let remaining = self.bytes.len().saturating_sub(self.length);
        let copy = remaining.min(bytes.len());
        self.bytes[self.length..self.length + copy].copy_from_slice(&bytes[..copy]);
        self.length += copy;
    }

    fn finish(self) -> Option<ByteSpan> {
        (self.length == 3 && self.bytes == [0xef, 0xbb, 0xbf]).then_some(ByteSpan::new(0, 3))
    }
}

impl LineScanner {
    fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            let position = self.cursor;
            self.cursor = self.cursor.saturating_add(1);
            if let Some(cr_position) = self.pending_cr.take() {
                if byte == b'\n' {
                    self.lines.push(BaseLine {
                        content: ByteSpan::new(
                            self.content_start,
                            cr_position.saturating_sub(self.content_start),
                        ),
                        ending: Some(ByteSpan::new(cr_position, 2)),
                    });
                    self.content_start = position.saturating_add(1);
                    continue;
                }
                self.lines.push(BaseLine {
                    content: ByteSpan::new(
                        self.content_start,
                        cr_position.saturating_sub(self.content_start),
                    ),
                    ending: Some(ByteSpan::new(cr_position, 1)),
                });
                self.content_start = cr_position.saturating_add(1);
            }

            match byte {
                b'\r' => self.pending_cr = Some(position),
                b'\n' => {
                    self.lines.push(BaseLine {
                        content: ByteSpan::new(
                            self.content_start,
                            position.saturating_sub(self.content_start),
                        ),
                        ending: Some(ByteSpan::new(position, 1)),
                    });
                    self.content_start = position.saturating_add(1);
                }
                _ => {}
            }
        }
    }

    fn finish(mut self) -> Vec<BaseLine> {
        if let Some(cr_position) = self.pending_cr.take() {
            self.lines.push(BaseLine {
                content: ByteSpan::new(
                    self.content_start,
                    cr_position.saturating_sub(self.content_start),
                ),
                ending: Some(ByteSpan::new(cr_position, 1)),
            });
            self.content_start = self.cursor;
        }
        if self.lines.is_empty() || self.content_start < self.cursor {
            self.lines.push(BaseLine {
                content: ByteSpan::new(
                    self.content_start,
                    self.cursor.saturating_sub(self.content_start),
                ),
                ending: None,
            });
        }
        self.lines
    }
}

#[cfg(test)]
mod tests {
    use super::{FileBaseSnapshot, SnapshotError, SnapshotOptions, DEFAULT_IO_CHUNK_SIZE};
    use crate::commands::large_text_view::{ByteSpan, ImmutableBase};
    #[cfg(windows)]
    use std::fs::OpenOptions;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    fn test_root(label: &str) -> PathBuf {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "lightmark-file-base-{label}-{}-{timestamp}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn source_path(root: &Path) -> PathBuf {
        root.join("source.md")
    }

    fn create_snapshot(
        root: &Path,
        bytes: &[u8],
        chunk_size: usize,
    ) -> (FileBaseSnapshot, PathBuf, PathBuf) {
        let source = source_path(root);
        fs::write(&source, bytes).unwrap();
        let snapshots = root.join("snapshots");
        let owner = "test-session";
        let snapshot = FileBaseSnapshot::create_with_options(
            &source,
            &snapshots,
            owner,
            SnapshotOptions {
                io_chunk_size: chunk_size,
            },
        )
        .unwrap();
        (snapshot, source, snapshots.join(owner))
    }

    #[test]
    fn strict_utf8_cross_buffer_and_mixed_eol_preserve_bom_and_spans() {
        let root = test_root("mixed");
        let bytes =
            b"\xEF\xBB\xBF\xe4\xb8\xad\xe6\x96\x87\xf0\x9f\x98\x80\r\n\xe7\xa9\xba\rline\ntail"
                .to_vec();
        let (snapshot, source, snapshot_dir) = create_snapshot(&root, &bytes, 1);

        assert_eq!(snapshot.source_path(), source.as_path());
        assert!(snapshot.snapshot_dir().is_dir());
        assert_eq!(snapshot.size_bytes(), bytes.len() as u64);
        assert!(snapshot.snapshot_path().is_file());
        assert_eq!(snapshot.prefix(), Some(ByteSpan::new(0, 3)));
        assert_eq!(snapshot.line_spans().len(), 4);
        assert_eq!(snapshot.line_spans()[0].content, ByteSpan::new(3, 10));
        assert_eq!(snapshot.line_spans()[0].ending, Some(ByteSpan::new(13, 2)));
        assert_eq!(snapshot.line_spans()[1].content, ByteSpan::new(15, 3));
        assert_eq!(snapshot.line_spans()[1].ending, Some(ByteSpan::new(18, 1)));
        assert_eq!(snapshot.line_spans()[2].content, ByteSpan::new(19, 4));
        assert_eq!(snapshot.line_spans()[2].ending, Some(ByteSpan::new(23, 1)));
        assert_eq!(snapshot.line_spans()[3].content, ByteSpan::new(24, 4));
        assert_eq!(snapshot.line_spans()[3].ending, None);

        let mut restored = Vec::new();
        snapshot
            .write_span(snapshot.prefix().unwrap(), &mut restored)
            .expect("prefix");
        for line in snapshot.line_spans() {
            snapshot
                .write_span(line.content, &mut restored)
                .expect("content");
            if let Some(ending) = line.ending {
                snapshot.write_span(ending, &mut restored).expect("ending");
            }
        }
        assert_eq!(restored, bytes);
        assert!(snapshot.fingerprint().sha256_hex().len() == 64);
        assert!(snapshot.max_io_read() <= 1);

        snapshot.cleanup().unwrap();
        assert!(!snapshot_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_utf8_is_rejected_and_owned_partial_snapshot_is_cleaned() {
        let root = test_root("invalid");
        let source = source_path(&root);
        let bytes = vec![b'a', 0xf0, 0x9f, b'('];
        fs::write(&source, &bytes).unwrap();
        let snapshots = root.join("snapshots");
        let result = FileBaseSnapshot::create_with_options(
            &source,
            &snapshots,
            "invalid-session",
            SnapshotOptions { io_chunk_size: 1 },
        );
        assert!(matches!(
            result,
            Err(SnapshotError::InvalidUtf8 { offset: 1 })
        ));
        assert!(!snapshots.join("invalid-session").exists());
        assert_eq!(fs::read(&source).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn long_span_uses_bounded_io_reads_and_streamed_writes() {
        let root = test_root("long");
        let mut bytes = vec![b'x'; 32 * 1024 + 17];
        bytes.extend_from_slice(b"\r\nlast");
        let (snapshot, _source, snapshot_dir) = create_snapshot(&root, &bytes, 7);
        let span = snapshot.line_spans()[0].content;
        let content = snapshot.read_span(span).unwrap();
        assert_eq!(content.len(), 32 * 1024 + 17);
        assert_eq!(snapshot.max_io_read(), 7);

        let mut output = Vec::new();
        snapshot.write_span(span, &mut output).unwrap();
        assert_eq!(output, content);
        assert_eq!(snapshot.max_io_read(), 7);

        snapshot.cleanup().unwrap();
        assert!(!snapshot_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_size_source_change_is_detected_without_touching_original() {
        let root = test_root("changed");
        let (snapshot, source, snapshot_dir) =
            create_snapshot(&root, b"abc\n", DEFAULT_IO_CHUNK_SIZE);
        fs::write(&source, b"xyz\n").unwrap();
        assert!(matches!(
            snapshot.verify_source_unchanged(),
            Err(SnapshotError::SourceChanged { .. })
        ));
        assert_eq!(snapshot.read_span(ByteSpan::new(0, 4)).unwrap(), b"abc\n");
        assert_eq!(fs::read(&source).unwrap(), b"xyz\n");

        snapshot.cleanup().unwrap();
        assert!(!snapshot_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_change_during_copy_is_rejected_and_partial_snapshot_is_cleaned() {
        let root = test_root("changed-during-copy");
        let source = source_path(&root);
        fs::write(&source, b"original").unwrap();
        let snapshots = root.join("snapshots");
        let mut changed = false;
        let mut hook = |copied: u64| {
            if !changed && copied >= 1 {
                fs::write(&source, b"CHANGED!").unwrap();
                changed = true;
            }
        };
        let result = FileBaseSnapshot::create_for_test_with_copy_hook(
            &source,
            &snapshots,
            "changed-during-copy-session",
            SnapshotOptions { io_chunk_size: 1 },
            &mut hook,
        );

        assert!(changed);
        assert!(matches!(result, Err(SnapshotError::SourceChanged { .. })));
        assert!(!snapshots.join("changed-during-copy-session").exists());
        assert_eq!(fs::read(&source).unwrap(), b"CHANGED!");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_source_does_not_create_owned_directory_or_modify_original() {
        let root = test_root("missing");
        let source = source_path(&root);
        let snapshots = root.join("snapshots");
        let result = FileBaseSnapshot::create(&source, &snapshots, "missing-session");
        assert!(matches!(result, Err(SnapshotError::Io { .. })));
        assert!(!snapshots.join("missing-session").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_owner_id_is_rejected_before_filesystem_changes() {
        let root = test_root("owner");
        let source = source_path(&root);
        fs::write(&source, b"ok").unwrap();
        let snapshots = root.join("snapshots");
        let result = FileBaseSnapshot::create(&source, &snapshots, "../escape");
        assert!(matches!(result, Err(SnapshotError::InvalidOwnerId)));
        assert!(!snapshots.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn utf8_validator_rejects_invalid_sequence_after_valid_prefix() {
        let root = test_root("invalid-prefix");
        let source = source_path(&root);
        fs::write(&source, [0xe2, 0x82, b'(', b'\n']).unwrap();
        let snapshots = root.join("snapshots");
        let result = FileBaseSnapshot::create_with_options(
            &source,
            &snapshots,
            "invalid-prefix-session",
            SnapshotOptions { io_chunk_size: 2 },
        );
        assert!(matches!(
            result,
            Err(SnapshotError::InvalidUtf8 { offset: 0 })
        ));
        assert!(!snapshots.join("invalid-prefix-session").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dropping_snapshot_preserves_recovery_artifact_until_explicit_cleanup() {
        let root = test_root("retained");
        let (snapshot, _source, snapshot_dir) = create_snapshot(&root, b"recover me", 3);
        drop(snapshot);
        assert!(snapshot_dir.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn readonly_snapshot_handle_rejects_external_write_and_delete() {
        let root = test_root("readonly");
        let (snapshot, _source, snapshot_dir) = create_snapshot(&root, b"private", 2);
        assert!(OpenOptions::new()
            .write(true)
            .open(snapshot.snapshot_path())
            .is_err());
        assert!(fs::remove_file(snapshot.snapshot_path()).is_err());
        snapshot.cleanup().unwrap();
        assert!(!snapshot_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
