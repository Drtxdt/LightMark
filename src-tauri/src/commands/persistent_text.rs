//! Persistent bounded segments. Roots are immutable; cloning a view and undo
//! retain Arc roots rather than copying one record for every logical line.
use super::large_file_base::FileBaseSnapshot;
use super::large_text_view::{
    ByteSpan, ImmutableBase, RenderedChunk, SearchHit, ViewEdit, ViewError,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
pub const SEGMENT_BYTES: usize = 64 * 1024;
pub const RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Default)]
pub struct Summary {
    pub bytes: u64,
    pub utf16: u64,
    pub breaks: usize,
    pub ends_break: bool,
    pub starts_lf: bool,
    pub ends_cr: bool,
    pub tail_utf16: u64,
}
impl Summary {
    pub fn text(text: &str) -> Self {
        let bytes = text.as_bytes();
        let mut breaks = 0;
        for i in memchr::memchr2_iter(b'\r', b'\n', bytes) {
            if bytes[i] != b'\n' || i == 0 || bytes[i - 1] != b'\r' { breaks += 1; }
        }
        let ascii = text.is_ascii();
        let tail = &text[memchr::memrchr2(b'\r', b'\n', bytes).map_or(0, |at| at + 1)..];
        Self {
            bytes: bytes.len() as u64,
            utf16: if ascii { bytes.len() as u64 } else { text.encode_utf16().count() as u64 },
            breaks,
            ends_break: bytes.last().is_some_and(|b| *b == b'\r' || *b == b'\n'),
            starts_lf: bytes.first() == Some(&b'\n'),
            ends_cr: bytes.last() == Some(&b'\r'),
            tail_utf16: if ascii { tail.len() as u64 } else { tail.encode_utf16().count() as u64 },
        }
    }
    fn plus(self, other: Self) -> Self {
        Self {
            bytes: self.bytes + other.bytes,
            utf16: self.utf16 + other.utf16,
            breaks: self.breaks + other.breaks - usize::from(self.ends_cr && other.starts_lf),
            ends_break: if other.bytes > 0 {
                other.ends_break
            } else {
                self.ends_break
            },
            starts_lf: if self.bytes > 0 {
                self.starts_lf
            } else {
                other.starts_lf
            },
            ends_cr: if other.bytes > 0 {
                other.ends_cr
            } else {
                self.ends_cr
            },
            tail_utf16: if other.breaks > 0 {
                other.tail_utf16
            } else {
                self.tail_utf16 + other.utf16
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::large_text_view::{BaseLine, MemoryBase};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn summary_fast_path_matches_unicode_line_ending_oracle() {
        let alphabet = ['x', '中', '😀', '\r', '\n', '\t', ' '];
        let mut seed = 0x1234_5678_u64;
        for length in 0..512 {
            let text: String = (0..length).map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                alphabet[(seed >> 32) as usize % alphabet.len()]
            }).collect();
            let actual = Summary::text(&text);
            let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
            assert_eq!(actual.bytes, text.len() as u64);
            assert_eq!(actual.utf16, text.encode_utf16().count() as u64);
            assert_eq!(actual.breaks, normalized.bytes().filter(|byte| *byte == b'\n').count());
            assert_eq!(actual.tail_utf16, normalized.rsplit('\n').next().unwrap().encode_utf16().count() as u64);
        }
        let ascii = "x".repeat(64 * 1024);
        assert_eq!(Summary::text(&ascii).utf16, 64 * 1024);
        assert_eq!(Summary::text(&ascii).tail_utf16, 64 * 1024);
    }
    #[test]
    fn navigation_resolves_scalars_crlf_short_lines_and_eof() {
        let view=SegmentedTextView::new(Arc::new(MemoryBase::from_bytes("a😀中\r\nx\nlast".as_bytes().to_vec())));
        assert_eq!(view.resolve_position(0,1,1).unwrap(),(0,3));
        assert_eq!(view.resolve_position(0,3,-1).unwrap(),(0,1));
        assert_eq!(view.resolve_position(0,4,1).unwrap(),(1,0));
        assert_eq!(view.resolve_position(1,0,-1).unwrap(),(0,4));
        assert_eq!(view.resolve_position(1,999,0).unwrap(),(1,1));
        assert_eq!(view.resolve_position(0,2,0).unwrap(),(0,1));
        assert_eq!(view.resolve_position(2,4,1).unwrap(),(2,4));
        assert_eq!(view.resolve_position(999,0,0).unwrap(),(2,4));
        assert!(view.resolve_position(0,2,1).is_err(),"scalar navigation starts from an exact anchor");
        assert!(view.resolve_position(0,999,1).is_err());
        let tail=SegmentedTextView::new(Arc::new(MemoryBase::from_bytes(b"x\n".to_vec())));
        assert_eq!(tail.resolve_position(0,1,1).unwrap(),(1,0));
        assert_eq!(tail.resolve_position(1,0,-1).unwrap(),(0,1));
        assert_eq!(tail.resolve_position(1,0,1).unwrap(),(1,0));
    }
    #[test]
    fn navigation_in_a_500mib_virtual_document_reads_only_bounded_segments() {
        let size=500_u64*1024*1024;
        let base=Arc::new(RepeatingBase::new(size,false));
        let view=SegmentedTextView::new(base.clone());
        assert_eq!(view.resolve_position(0,size as usize,-1).unwrap(),(0,size as usize-1));
        assert_eq!(view.resolve_position(0,size as usize-1,1).unwrap(),(0,size as usize));
        assert!(base.max_read.load(Ordering::Relaxed)<=SEGMENT_BYTES);
        assert!(base.reads.load(Ordering::Relaxed)<512*1024,"navigation must not scan the long line");
        let base=Arc::new(RepeatingBase::new(size,true));
        let view=SegmentedTextView::new(base.clone());
        let last=size as usize/2-1;
        assert_eq!(view.resolve_position(last,999,0).unwrap(),(last,1));
        assert_eq!(view.resolve_position(last,1,1).unwrap(),(last+1,0));
        assert_eq!(view.resolve_position(last+1,0,-1).unwrap(),(last,1));
        assert!(base.max_read.load(Ordering::Relaxed)<=SEGMENT_BYTES);
        assert!(base.reads.load(Ordering::Relaxed)<2*1024*1024,"navigation must not scan all short lines");
    }
    struct RepeatingBase {
        segments: Vec<BaseSegment>,
        size: u64,
        short_lines: bool,
        max_read: AtomicUsize,
        reads: AtomicUsize,
    }
    impl RepeatingBase {
        fn new(size: u64, short_lines: bool) -> Self {
            let mut segments = Vec::new();
            let mut at = 0;
            let full = Summary::text(&if short_lines {
                "x\n".repeat(SEGMENT_BYTES / 2)
            } else {
                "x".repeat(SEGMENT_BYTES)
            });
            while at < size {
                let len = (size - at).min(SEGMENT_BYTES as u64);
                let metadata = if len == SEGMENT_BYTES as u64 {
                    full
                } else {
                    Summary::text(&if short_lines {
                        "x\n".repeat(len as usize / 2)
                    } else {
                        "x".repeat(len as usize)
                    })
                };
                segments.push(BaseSegment {
                    span: ByteSpan::new(at, len),
                    summary: metadata,
                });
                at += len;
            }
            Self {
                segments,
                size,
                short_lines,
                max_read: AtomicUsize::new(0),
                reads: AtomicUsize::new(0),
            }
        }
    }
    impl ImmutableBase for RepeatingBase {
        fn line_spans(&self) -> &[BaseLine] {
            panic!("sparse engine must not request a full line index")
        }
        fn sparse_segments(&self) -> Option<&[BaseSegment]> {
            Some(&self.segments)
        }
        fn read_span(&self, s: ByteSpan) -> Result<Vec<u8>, String> {
            assert!(s.end() <= self.size);
            self.max_read.fetch_max(s.len as usize, Ordering::Relaxed);
            self.reads.fetch_add(s.len as usize, Ordering::Relaxed);
            Ok((s.start..s.end())
                .map(|at| {
                    if self.short_lines && at % 2 == 1 {
                        b'\n'
                    } else {
                        b'x'
                    }
                })
                .collect())
        }
        fn write_span(&self, s: ByteSpan, w: &mut dyn Write) -> Result<(), String> {
            for chunk in (s.start..s.end()).step_by(SEGMENT_BYTES) {
                let bytes = self.read_span(ByteSpan::new(
                    chunk,
                    (s.end() - chunk).min(SEGMENT_BYTES as u64),
                ))?;
                w.write_all(&bytes).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
    fn rendered<B: ImmutableBase + ?Sized>(view: &SegmentedTextView<B>) -> String {
        let mut bytes = Vec::new();
        view.write_to(&mut bytes).unwrap();
        String::from_utf8(bytes).unwrap()
    }
    #[test]
    fn history_and_crlf_boundary_edits_are_atomic() {
        let mut view =
            SegmentedTextView::new(Arc::new(MemoryBase::from_bytes(b"a\nb\r\nc\rd".to_vec())));
        view.apply_batch(0, &[ViewEdit::new(0, 1, 0, 1, "\r")])
            .unwrap();
        assert_eq!(rendered(&view), "a\r\nb\r\nc\rd");
        assert_eq!(view.line_count(), 4);
        assert_eq!(view.read_line_content(1).unwrap(), "b");
        view.apply_batch(1, &[ViewEdit::new(1, 0, 2, 1, "😀\nX")])
            .unwrap();
        assert_eq!(rendered(&view), "a\r\n😀\nX\rd");
        let frozen = view.clone();
        view.move_history(2, true).unwrap();
        assert_eq!(rendered(&view), "a\r\nb\r\nc\rd");
        view.move_history(3, true).unwrap();
        assert_eq!(rendered(&view), "a\nb\r\nc\rd");
        view.move_history(4, false).unwrap();
        assert_eq!(view.line_count(), 4);
        assert_eq!(rendered(&frozen), "a\r\n😀\nX\rd");
    }

    #[test]
    fn randomized_utf16_edits_match_independent_bytes_and_history() {
        fn coordinates(text: &str, byte: usize) -> (usize, usize) {
            let mut line = 0;
            let mut column = 0;
            let mut chars = text[..byte].chars().peekable();
            while let Some(ch) = chars.next() {
                if ch == '\r' {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    line += 1;
                    column = 0;
                } else if ch == '\n' {
                    line += 1;
                    column = 0;
                } else {
                    column += ch.len_utf16();
                }
            }
            (line, column)
        }
        let mut source = "a😀中\r\nsecond\nthird\rfinal".to_string();
        let mut view =
            SegmentedTextView::new(Arc::new(MemoryBase::from_bytes(source.as_bytes().to_vec())));
        let mut seed = 7_u64;
        for revision in 0..1500 {
            let mut next = || {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 32) as usize
            };
            let mut boundaries: Vec<usize> = source
                .char_indices()
                .map(|(i, _)| i)
                .chain(std::iter::once(source.len()))
                .filter(|i| {
                    *i == 0
                        || *i == source.len()
                        || !(source.as_bytes()[*i - 1] == b'\r' && source.as_bytes()[*i] == b'\n')
                })
                .collect();
            boundaries.sort_unstable();
            boundaries.dedup();
            let mut from = boundaries[next() % boundaries.len()];
            let mut to = boundaries[next() % boundaries.len()];
            if from > to {
                std::mem::swap(&mut from, &mut to);
            }
            let insert = ["x", "😀", "中\r\n", "\n", "\r", "", "ab\ncd"][next() % 7];
            let (a, b) = coordinates(&source, from);
            let (c, d) = coordinates(&source, to);
            let previous = view.clone();
            let before = source.clone();
            view.apply_batch(revision, &[ViewEdit::new(a, b, c, d, insert)])
                .unwrap();
            source.replace_range(from..to, insert);
            assert_eq!(rendered(&view), source, "revision {revision}");
            assert_eq!(rendered(&previous), before);
            for byte in source
                .char_indices()
                .map(|(i, _)| i)
                .chain(std::iter::once(source.len()))
                .filter(|i| {
                    *i == 0
                        || *i == source.len()
                        || !(source.as_bytes()[*i - 1] == b'\r' && source.as_bytes()[*i] == b'\n')
                })
            {
                assert_eq!(
                    view.byte_position(byte as u64).unwrap(),
                    coordinates(&source, byte)
                );
            }
        }
    }

    #[test]
    fn long_history_releases_iteratively_and_tree_stays_balanced() {
        let mut view = SegmentedTextView::new(Arc::new(MemoryBase::from_bytes(b"x".to_vec())));
        for revision in 0..20_000 {
            view.apply_batch(revision, &[ViewEdit::new(0, 0, 0, 0, "x")])
                .unwrap();
        }
        assert!(height(&view.root) < 32);
        assert_eq!(view.byte_length(), 20_001);
        drop(view);
    }
    #[test]
    fn bounded_unicode_range_preserves_crlf_and_surrogate_boundaries() {
        let source = format!("{}😀\r\nnext", "x".repeat(RESPONSE_BYTES - 2));
        let view = SegmentedTextView::new(Arc::new(MemoryBase::from_bytes(source.into_bytes())));
        let (text, end, truncated) = view.read_range(0, 0, None, RESPONSE_BYTES).unwrap();
        assert_eq!(text.len(), RESPONSE_BYTES - 2);
        assert_eq!(end, (0, RESPONSE_BYTES - 2));
        assert!(truncated);
        let (text, end, _) = view.read_range(end.0, end.1, None, 8).unwrap();
        assert_eq!(text, "😀\r\nne");
        assert_eq!(end, (1, 2));
        assert!(matches!(
            view.position_byte(0, RESPONSE_BYTES - 1),
            Err(ViewError::InvalidUtf16Boundary { .. })
        ));
        let view = SegmentedTextView::new(Arc::new(MemoryBase::from_bytes(
            "end😀".as_bytes().to_vec(),
        )));
        assert_eq!(view.read_range(0, 0, None, 128).unwrap().0, "end😀");
        assert_eq!(view.position_byte(0, 5).unwrap(), 7);
    }

    #[test]
    fn disk_journal_keeps_insertions_and_history_shared_until_close() {
        let root = std::env::temp_dir().join(format!(
            "lm-journal-{}-{}",
            std::process::id(),
            JOURNAL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("source.md");
        fs::write(&path, "original😀").unwrap();
        let base = Arc::new(
            FileBaseSnapshot::create(&path, root.join("snapshots"), "journal-test").unwrap(),
        );
        let directory = base.snapshot_dir().to_path_buf();
        let mut view = SegmentedTextView::new(base.clone());
        view.apply_batch(0, &[ViewEdit::new(0, 0, 0, 0, "FIRST ")])
            .unwrap();
        let frozen = view.clone();
        view.apply_batch(1, &[ViewEdit::new(0, 6, 0, 6, "SECOND ")])
            .unwrap();
        let journals: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("edits-"))
            .collect();
        assert_eq!(journals.len(), 1);
        assert_eq!(fs::read(journals[0].path()).unwrap(), b"FIRST SECOND ");
        assert_eq!(rendered(&frozen), "FIRST original😀");
        view.move_history(2, true).unwrap();
        assert_eq!(rendered(&view), rendered(&frozen));
        drop(frozen);
        drop(view);
        assert!(!journals[0].path().exists());
        Arc::try_unwrap(base).ok().unwrap().cleanup().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn five_hundred_mib_long_line_and_short_lines_use_sparse_bounded_reads() {
        for short in [false, true] {
            let base = Arc::new(RepeatingBase::new(500 * 1024 * 1024, short));
            let mut view = SegmentedTextView::new(base.clone());
            assert_eq!(base.reads.load(Ordering::Relaxed), 0);
            assert_eq!(base.segments.len(), 8000);
            let (line, col) = if short {
                (view.line_count() - 1, 0)
            } else {
                (0, 500 * 1024 * 1024 - 4)
            };
            let (text, _, _) = view.read_range(line, col, None, 256 * 1024).unwrap();
            assert!(text.len() <= 256 * 1024);
            view.apply_batch(0, &[ViewEdit::new(line, col, line, col, "EDIT")])
                .unwrap();
            assert_eq!(view.read_range(line, col, None, 4).unwrap().0, "EDIT");
            assert!(base.max_read.load(Ordering::Relaxed) <= SEGMENT_BYTES);
            assert!(
                base.reads.load(Ordering::Relaxed) < 2 * 1024 * 1024,
                "local access read more than 2MiB"
            );
            view.move_history(1, true).unwrap();
            assert_eq!(view.byte_length(), 500 * 1024 * 1024);
        }
    }
}
#[derive(Clone, Debug)]
pub struct BaseSegment {
    pub span: ByteSpan,
    pub summary: Summary,
}
#[derive(Clone)]
enum Content {
    Base(ByteSpan),
    Added(Arc<str>, usize, usize),
    Delta(Arc<DeltaStore>, ByteSpan),
    Journal(Arc<DeltaJournal>, ByteSpan),
}
struct DeltaStore {
    snapshot: Option<FileBaseSnapshot>,
}
impl Drop for DeltaStore {
    fn drop(&mut self) {
        if let Some(snapshot) = self.snapshot.take() {
            let _ = snapshot.cleanup();
        }
    }
}
struct DeltaJournal {
    file: Mutex<Option<File>>,
    path: PathBuf,
}
static JOURNAL_SEQUENCE: AtomicU64 = AtomicU64::new(0);
impl DeltaJournal {
    fn read(&self, span: ByteSpan) -> Result<Vec<u8>, ViewError> {
        let mut guard = self
            .file
            .lock()
            .map_err(|_| ViewError::BaseRead("journal lock poisoned".into()))?;
        let file = guard
            .as_mut()
            .ok_or_else(|| ViewError::BaseRead("journal closed".into()))?;
        file.seek(SeekFrom::Start(span.start))
            .map_err(|e| ViewError::BaseRead(e.to_string()))?;
        let mut bytes = vec![0; span.len as usize];
        file.read_exact(&mut bytes)
            .map_err(|e| ViewError::BaseRead(e.to_string()))?;
        Ok(bytes)
    }
    fn append(&self, text: &str) -> Result<u64, ViewError> {
        let mut guard = self
            .file
            .lock()
            .map_err(|_| ViewError::Write("journal lock poisoned".into()))?;
        let file = guard
            .as_mut()
            .ok_or_else(|| ViewError::Write("journal closed".into()))?;
        let start = file
            .seek(SeekFrom::End(0))
            .map_err(|e| ViewError::Write(e.to_string()))?;
        file.write_all(text.as_bytes())
            .map_err(|e| ViewError::Write(e.to_string()))?;
        file.sync_data()
            .map_err(|e| ViewError::Write(e.to_string()))?;
        Ok(start)
    }
}
impl Drop for DeltaJournal {
    fn drop(&mut self) {
        if let Ok(guard) = self.file.get_mut() {
            let _ = guard.take();
        }
        let _ = fs::remove_file(&self.path);
    }
}
struct Node {
    summary: Summary,
    height: u16,
    body: Body,
}
enum Body {
    Leaf(Content),
    Branch(Arc<Node>, Arc<Node>),
}
type Root = Option<Arc<Node>>;
fn height(root: &Root) -> u16 {
    root.as_ref().map_or(0, |n| n.height)
}
fn summary(root: &Root) -> Summary {
    root.as_ref().map_or(Summary::default(), |n| n.summary)
}
fn leaf(content: Content, s: Summary) -> Root {
    if s.bytes == 0 {
        None
    } else {
        Some(Arc::new(Node {
            summary: s,
            height: 1,
            body: Body::Leaf(content),
        }))
    }
}
fn branch(a: Root, b: Root) -> Root {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => Some(Arc::new(Node {
            summary: a.summary.plus(b.summary),
            height: 1 + a.height.max(b.height),
            body: Body::Branch(a, b),
        })),
    }
}
fn join(a: Root, b: Root) -> Root {
    if height(&a) > height(&b) + 1 {
        if let Some(n) = &a {
            if let Body::Branch(l, r) = &n.body {
                return balance(Some(l.clone()), join(Some(r.clone()), b));
            }
        }
    }
    if height(&b) > height(&a) + 1 {
        if let Some(n) = &b {
            if let Body::Branch(l, r) = &n.body {
                return balance(join(a, Some(l.clone())), Some(r.clone()));
            }
        }
    }
    branch(a, b)
}
fn balance(a: Root, b: Root) -> Root {
    if height(&a) > height(&b) + 1 {
        if let Some(n) = &a {
            if let Body::Branch(l, r) = &n.body {
                if l.height >= r.height {
                    return branch(Some(l.clone()), branch(Some(r.clone()), b));
                }
                if let Body::Branch(rl, rr) = &r.body {
                    return branch(
                        branch(Some(l.clone()), Some(rl.clone())),
                        branch(Some(rr.clone()), b),
                    );
                }
            }
        }
    }
    if height(&b) > height(&a) + 1 {
        if let Some(n) = &b {
            if let Body::Branch(l, r) = &n.body {
                if r.height >= l.height {
                    return branch(branch(a, Some(l.clone())), Some(r.clone()));
                }
                if let Body::Branch(ll, lr) = &l.body {
                    return branch(
                        branch(a, Some(ll.clone())),
                        branch(Some(lr.clone()), Some(r.clone())),
                    );
                }
            }
        }
    }
    branch(a, b)
}
fn read_content<B: ImmutableBase + ?Sized>(
    base: &B,
    content: &Content,
) -> Result<String, ViewError> {
    match content {
        Content::Base(span) => {
            String::from_utf8(base.read_span(*span).map_err(ViewError::BaseRead)?)
                .map_err(|_| ViewError::InvalidUtf8)
        }
        Content::Added(s, a, b) => Ok(s[*a..*b].to_string()),
        Content::Journal(journal, span) => {
            String::from_utf8(journal.read(*span)?).map_err(|_| ViewError::InvalidUtf8)
        }
        Content::Delta(store, span) => String::from_utf8(
            store
                .snapshot
                .as_ref()
                .ok_or_else(|| ViewError::BaseRead("closed delta".into()))?
                .read_span(*span)
                .map_err(ViewError::BaseRead)?,
        )
        .map_err(|_| ViewError::InvalidUtf8),
    }
}
fn read_content_slice<B: ImmutableBase + ?Sized>(base: &B, content: &Content, from: u64, to: u64) -> Result<String, ViewError> {
    if from > to { return Err(ViewError::InvalidRange); }
    let bytes = match content {
        Content::Base(span) => base.read_span(ByteSpan::new(span.start + from, to - from)).map_err(ViewError::BaseRead)?,
        Content::Added(text, start, _) => return text.get(start + from as usize..start + to as usize).map(str::to_string).ok_or(ViewError::InvalidUtf8),
        Content::Journal(store, span) => store.read(ByteSpan::new(span.start + from, to - from))?,
        Content::Delta(store, span) => store.snapshot.as_ref().ok_or_else(|| ViewError::BaseRead("closed delta".into()))?.read_span(ByteSpan::new(span.start + from, to - from)).map_err(ViewError::BaseRead)?,
    };
    String::from_utf8(bytes).map_err(|_| ViewError::InvalidUtf8)
}
fn split<B: ImmutableBase + ?Sized>(
    base: &B,
    root: Root,
    offset: u64,
) -> Result<(Root, Root), ViewError> {
    let Some(n) = root else {
        return Ok((None, None));
    };
    if offset == 0 {
        return Ok((None, Some(n)));
    }
    if offset >= n.summary.bytes {
        return Ok((Some(n), None));
    }
    match &n.body {
        Body::Branch(l, r) => {
            if offset < l.summary.bytes {
                let (a, b) = split(base, Some(l.clone()), offset)?;
                Ok((a, join(b, Some(r.clone()))))
            } else {
                let (a, b) = split(base, Some(r.clone()), offset - l.summary.bytes)?;
                Ok((join(Some(l.clone()), a), b))
            }
        }
        Body::Leaf(c) => {
            let text = read_content(base, c)?;
            let at = offset as usize;
            if !text.is_char_boundary(at) {
                return Err(ViewError::InvalidUtf8);
            }
            let (a, b) = match c {
                Content::Base(s) => (
                    Content::Base(ByteSpan::new(s.start, offset)),
                    Content::Base(ByteSpan::new(s.start + offset, s.len - offset)),
                ),
                Content::Added(s, a, b) => (
                    Content::Added(s.clone(), *a, *a + at),
                    Content::Added(s.clone(), *a + at, *b),
                ),
                Content::Delta(store, s) => (
                    Content::Delta(store.clone(), ByteSpan::new(s.start, offset)),
                    Content::Delta(
                        store.clone(),
                        ByteSpan::new(s.start + offset, s.len - offset),
                    ),
                ),
                Content::Journal(store, s) => (
                    Content::Journal(store.clone(), ByteSpan::new(s.start, offset)),
                    Content::Journal(
                        store.clone(),
                        ByteSpan::new(s.start + offset, s.len - offset),
                    ),
                ),
            };
            Ok((
                leaf(a, Summary::text(&text[..at])),
                leaf(b, Summary::text(&text[at..])),
            ))
        }
    }
}
fn added(text: &str) -> Root {
    let data: Arc<str> = Arc::from(text);
    let mut root = None;
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + SEGMENT_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end < text.len() && text.as_bytes()[end - 1] == b'\r' && text.as_bytes()[end] == b'\n' {
            end -= 1;
        }
        root = join(
            root,
            leaf(
                Content::Added(data.clone(), start, end),
                Summary::text(&text[start..end]),
            ),
        );
        start = end;
    }
    root
}

struct HistoryNode {
    root: Root,
    previous: Option<Arc<HistoryNode>>,
}
impl Drop for HistoryNode {
    fn drop(&mut self) {
        let mut next = self.previous.take();
        while let Some(entry) = next {
            match Arc::try_unwrap(entry) {
                Ok(mut owned) => next = owned.previous.take(),
                Err(_) => break,
            }
        }
    }
}

pub struct SegmentedTextView<B: ImmutableBase + ?Sized> {
    base: Arc<B>,
    root: Root,
    prefix: Option<ByteSpan>,
    revision: u64,
    journal: Arc<Mutex<Option<Arc<DeltaJournal>>>>,
    undo: Option<Arc<HistoryNode>>,
    redo: Option<Arc<HistoryNode>>,
}
impl<B: ImmutableBase + ?Sized> Clone for SegmentedTextView<B> {
    fn clone(&self) -> Self {
        Self {
            base: self.base.clone(),
            root: self.root.clone(),
            prefix: self.prefix,
            revision: self.revision,
            journal: self.journal.clone(),
            undo: self.undo.clone(),
            redo: self.redo.clone(),
        }
    }
}
impl<B: ImmutableBase + ?Sized> SegmentedTextView<B> {
    pub fn new(base: Arc<B>) -> Self {
        let mut root = None;
        if let Some(segments) = base.sparse_segments() {
            for s in segments {
                root = join(root, leaf(Content::Base(s.span), s.summary));
            }
        } else {
            for line in base.line_spans() {
                for span in [Some(line.content), line.ending].into_iter().flatten() {
                    let mut offset = 0;
                    while offset < span.len {
                        let len = (span.len - offset).min(SEGMENT_BYTES as u64);
                        let mut bytes = base
                            .read_span(ByteSpan::new(span.start + offset, len))
                            .expect("validated immutable base");
                        while std::str::from_utf8(&bytes).is_err() {
                            bytes.pop();
                        }
                        let text = std::str::from_utf8(&bytes).expect("validated UTF-8");
                        let s = ByteSpan::new(span.start + offset, bytes.len() as u64);
                        root = join(root, leaf(Content::Base(s), Summary::text(text)));
                        offset += s.len;
                    }
                }
            }
        }
        Self {
            prefix: base.prefix(),
            base,
            root,
            revision: 0,
            journal: Arc::new(Mutex::new(None)),
            undo: None,
            redo: None,
        }
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn with_revision(mut self, revision: u64) -> Self {
        self.revision = revision;
        self
    }
    pub fn byte_length(&self) -> u64 {
        summary(&self.root).bytes + self.prefix.map_or(0, |s| s.len)
    }
    pub fn line_count(&self) -> usize {
        let s = summary(&self.root);
        s.breaks + usize::from(!s.ends_break || s.bytes == 0)
    }
    pub fn eof_position(&self) -> Option<(usize, usize)> {
        Some((self.line_count(), 0))
    }
    fn break_end(&self, nth: usize) -> Result<u64, ViewError> {
        if nth == 0 {
            return Ok(0);
        }
        let mut n = self
            .root
            .as_ref()
            .ok_or(ViewError::InvalidLine { line: nth })?;
        let mut wanted = nth;
        let mut offset = 0;
        loop {
            match &n.body {
                Body::Branch(l, r) => {
                    if wanted < l.summary.breaks
                        || (wanted == l.summary.breaks
                            && !(l.summary.ends_cr && r.summary.starts_lf))
                    {
                        n = l
                    } else {
                        wanted = wanted - l.summary.breaks
                            + usize::from(l.summary.ends_cr && r.summary.starts_lf);
                        offset += l.summary.bytes;
                        n = r
                    }
                }
                Body::Leaf(c) => {
                    let text = read_content(self.base.as_ref(), c)?;
                    let b = text.as_bytes();
                    let mut i = 0;
                    while i < b.len() {
                        if b[i] == b'\r' || b[i] == b'\n' {
                            if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') {
                                i += 1;
                            }
                            wanted -= 1;
                            if wanted == 0 {
                                return Ok(offset + i as u64 + 1);
                            }
                        }
                        i += 1;
                    }
                    return Err(ViewError::InvalidLine { line: nth });
                }
            }
        }
    }
    fn walk_range(
        &self,
        root: &Root,
        from: u64,
        to: u64,
        out: &mut impl FnMut(&Content, u64, u64) -> Result<(), ViewError>,
    ) -> Result<(), ViewError> {
        let Some(n) = root else { return Ok(()) };
        if from >= to {
            return Ok(());
        }
        match &n.body {
            Body::Leaf(c) => out(c, from, to),
            Body::Branch(l, r) => {
                let mid = l.summary.bytes;
                if from < mid {
                    self.walk_range(&Some(l.clone()), from, to.min(mid), out)?;
                }
                if to > mid {
                    self.walk_range(&Some(r.clone()), from.saturating_sub(mid), to - mid, out)?;
                }
                Ok(())
            }
        }
    }
    fn bytes(&self, from: u64, to: u64) -> Result<String, ViewError> {
        let mut result = String::new();
        self.walk_range(&self.root, from, to, &mut |c, a, b| {
            result.push_str(&read_content_slice(self.base.as_ref(), c, a, b)?);
            Ok(())
        })?;
        Ok(result)
    }
    fn line_bounds(&self, line: usize) -> Result<(u64, u64), ViewError> {
        if line >= self.line_count() {
            return Err(ViewError::InvalidLine { line });
        }
        let start = self.break_end(line)?;
        let end = if line < summary(&self.root).breaks {
            self.break_end(line + 1)?
        } else {
            summary(&self.root).bytes
        };
        Ok((start, end))
    }
    fn utf16_before(&self, byte: u64) -> Result<u64, ViewError> {
        fn count<B: ImmutableBase + ?Sized>(
            base: &B,
            root: &Root,
            byte: u64,
        ) -> Result<u64, ViewError> {
            let Some(n) = root else { return Ok(0) };
            if byte >= n.summary.bytes {
                return Ok(n.summary.utf16);
            }
            match &n.body {
                Body::Leaf(c) => {
                    let text = read_content(base, c)?;
                    Ok(text
                        .get(..byte as usize)
                        .ok_or(ViewError::InvalidUtf8)?
                        .encode_utf16()
                        .count() as u64)
                }
                Body::Branch(l, r) => {
                    if byte < l.summary.bytes {
                        count(base, &Some(l.clone()), byte)
                    } else {
                        Ok(
                            l.summary.utf16
                                + count(base, &Some(r.clone()), byte - l.summary.bytes)?,
                        )
                    }
                }
            }
        }
        count(self.base.as_ref(), &self.root, byte)
    }
    fn byte_at_utf16(&self, offset: u64, line: usize, column: usize) -> Result<u64, ViewError> {
        let Some(mut node) = self.root.as_ref() else {
            return if offset == 0 {
                Ok(0)
            } else {
                Err(ViewError::InvalidColumn {
                    line,
                    column,
                    max: 0,
                })
            };
        };
        let mut remaining = offset;
        let mut bytes = 0;
        loop {
            match &node.body {
                Body::Branch(l, r) => {
                    if remaining < l.summary.utf16 {
                        node = l
                    } else {
                        remaining -= l.summary.utf16;
                        bytes += l.summary.bytes;
                        node = r
                    }
                }
                Body::Leaf(c) => {
                    let text = read_content(self.base.as_ref(), c)?;
                    for (at, ch) in text.char_indices() {
                        if remaining == 0 {
                            return Ok(bytes + at as u64);
                        }
                        if remaining < ch.len_utf16() as u64 {
                            return Err(ViewError::InvalidUtf16Boundary { line, column });
                        }
                        remaining -= ch.len_utf16() as u64;
                    }
                    return if remaining == 0 {
                        Ok(bytes + text.len() as u64)
                    } else {
                        Err(ViewError::InvalidColumn {
                            line,
                            column,
                            max: column.saturating_sub(remaining as usize),
                        })
                    };
                }
            }
        }
    }
    pub fn position_byte(&self, line: usize, column: usize) -> Result<u64, ViewError> {
        if line == self.line_count() && column == 0 {
            return Ok(summary(&self.root).bytes);
        }
        let (start, end) = self.line_bounds(line)?;
        let start_utf16 = self.utf16_before(start)?;
        let byte = self.byte_at_utf16(start_utf16 + column as u64, line, column)?;
        let mut content_end = end;
        if line < summary(&self.root).breaks && end > start {
            let suffix = self
                .bytes(end.saturating_sub(2).max(start), end)
                .or_else(|_| self.bytes(end - 1, end))?;
            if suffix.ends_with("\r\n") {
                content_end -= 2
            } else if suffix.ends_with(['\r', '\n']) {
                content_end -= 1
            }
        }
        if byte > content_end {
            return Err(ViewError::InvalidColumn {
                line,
                column,
                max: (self.utf16_before(content_end)? - start_utf16) as usize,
            });
        }
        Ok(byte)
    }
    /// Resolve a window navigation target without loading a complete line.
    /// Direction -1/1 moves one Unicode scalar (or one CRLF); 0 clamps a
    /// requested vertical position to the destination line's content boundary.
    pub fn resolve_position(&self, line: usize, column: usize, direction: i8) -> Result<(usize, usize), ViewError> {
        if direction == 0 {
            if line >= self.line_count() { return self.byte_position(summary(&self.root).bytes); }
            let (start, mut end) = self.line_bounds(line)?;
            if line < summary(&self.root).breaks && end > start {
                let suffix = self.bytes(end.saturating_sub(2).max(start), end).or_else(|_| self.bytes(end - 1, end))?;
                end -= if suffix.ends_with("\r\n") { 2 } else if suffix.ends_with(['\r', '\n']) { 1 } else { 0 };
            }
            let max = (self.utf16_before(end)? - self.utf16_before(start)?) as usize;
            let requested = column.min(max);
            let byte = match self.position_byte(line, requested) {
                Err(ViewError::InvalidUtf16Boundary { .. }) if requested > 0 => self.position_byte(line, requested - 1)?,
                result => result?,
            };
            return self.byte_position(byte);
        }
        if direction != -1 && direction != 1 { return Err(ViewError::InvalidRange); }
        let byte = self.position_byte(line, column)?;
        let length = summary(&self.root).bytes;
        if direction < 0 {
            if byte == 0 { return self.byte_position(0); }
            let mut start = byte.saturating_sub(4);
            for _ in 0..4 {
                match self.bytes(start, byte) {
                    Ok(text) => {
                        let step = if text.ends_with("\r\n") { 2 } else { text.chars().next_back().map_or(0, char::len_utf8) };
                        return self.byte_position(byte - step as u64);
                    }
                    Err(ViewError::InvalidUtf8) => start += 1,
                    Err(error) => return Err(error),
                }
            }
        } else {
            if byte == length { return self.byte_position(byte); }
            let mut end = (byte + 4).min(length);
            for _ in 0..4 {
                match self.bytes(byte, end) {
                    Ok(text) => {
                        let step = if text.starts_with("\r\n") { 2 } else { text.chars().next().map_or(0, char::len_utf8) };
                        return self.byte_position(byte + step as u64);
                    }
                    Err(ViewError::InvalidUtf8) => end -= 1,
                    Err(error) => return Err(error),
                }
            }
        }
        Err(ViewError::InvalidUtf8)
    }
    pub fn byte_position(&self, byte: u64) -> Result<(usize, usize), ViewError> {
        let mut offset = byte;
        let mut aggregate = Summary::default();
        let Some(mut node) = self.root.as_ref() else {
            return Ok((0, 0));
        };
        if byte > node.summary.bytes {
            return Err(ViewError::InvalidRange);
        }
        loop {
            if offset == node.summary.bytes {
                aggregate = aggregate.plus(node.summary);
                break;
            }
            match &node.body {
                Body::Branch(l, r) => {
                    if offset < l.summary.bytes {
                        node = l
                    } else {
                        offset -= l.summary.bytes;
                        aggregate = aggregate.plus(l.summary);
                        node = r
                    }
                }
                Body::Leaf(c) => {
                    let text = read_content(self.base.as_ref(), c)?;
                    aggregate = aggregate.plus(Summary::text(
                        text.get(..offset as usize).ok_or(ViewError::InvalidUtf8)?,
                    ));
                    break;
                }
            }
        }
        Ok((aggregate.breaks, aggregate.tail_utf16 as usize))
    }
    pub fn read_range(
        &self,
        start_line: usize,
        start_column: usize,
        end: Option<(usize, usize)>,
        limit: usize,
    ) -> Result<(String, (usize, usize), bool), ViewError> {
        let start = self.position_byte(start_line, start_column)?;
        let requested = match end {
            Some((l, c)) => self.position_byte(l, c)?,
            None => summary(&self.root).bytes,
        };
        if requested < start {
            return Err(ViewError::InvalidRange);
        }
        let mut stop = (start + limit.min(RESPONSE_BYTES) as u64).min(requested);
        let mut attempts = 0;
        let mut text = loop {
            match self.bytes(start, stop) {
                Ok(text) => break text,
                Err(ViewError::InvalidUtf8) if stop > start && attempts < 3 => {
                    stop -= 1;
                    attempts += 1
                }
                Err(e) => return Err(e),
            }
        };
        if stop < requested && text.ends_with('\r') {
            text.pop();
            stop -= 1;
        }
        let mut line = start_line;
        let mut col = start_column;
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\r' {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                line += 1;
                col = 0;
            } else if ch == '\n' {
                line += 1;
                col = 0;
            } else {
                col += ch.len_utf16();
            }
        }
        Ok((text, (line, col), stop < requested))
    }
    pub fn read_chunk(&self, start_line: usize, count: usize) -> Result<RenderedChunk, ViewError> {
        let start = start_line.min(self.line_count());
        if start == self.line_count() {
            return Ok(RenderedChunk {
                revision: self.revision,
                start_line: start,
                end_line: start,
                total_lines: self.line_count(),
                text: String::new(),
            });
        }
        let end = (start + count).min(self.line_count());
        let from = self.break_end(start)?;
        let to = if end < self.line_count() {
            self.break_end(end)?
        } else {
            summary(&self.root).bytes
        };
        if to - from > RESPONSE_BYTES as u64 {
            return Err(ViewError::BaseRead(
                "line chunk exceeds 256KiB; use read_file_range with a partial-line coordinate"
                    .into(),
            ));
        }
        Ok(RenderedChunk {
            revision: self.revision,
            start_line: start,
            end_line: end,
            total_lines: self.line_count(),
            text: self.bytes(from, to)?,
        })
    }
    pub fn read_line_content(&self, line: usize) -> Result<String, ViewError> {
        let (a, b) = self.line_bounds(line)?;
        Ok(self.bytes(a, b)?.trim_end_matches(['\r', '\n']).to_string())
    }
    /// Stream line prefixes for navigation without materializing a very long
    /// line or allocating an entry for every short line.
    pub fn visit_line_prefixes(
        &self,
        max_prefix: usize,
        visit: impl FnMut(usize, &str),
    ) -> Result<(), ViewError> {
        self.visit_prefixes_until(None, max_prefix, visit)
    }
    pub fn visit_line_prefixes_before(
        &self,
        line: usize,
        max_prefix: usize,
        visit: impl FnMut(usize, &str),
    ) -> Result<(), ViewError> {
        self.visit_prefixes_until(Some(line), max_prefix, visit)
    }
    fn visit_prefixes_until(
        &self,
        until: Option<usize>,
        max_prefix: usize,
        mut visit: impl FnMut(usize, &str),
    ) -> Result<(), ViewError> {
        let mut prefix = String::new();
        let mut line = 0;
        let mut after_cr = false;
        let mut has_line = false;
        let end = match until {
            Some(line) => {
                if line <= summary(&self.root).breaks {
                    self.break_end(line)?
                } else {
                    summary(&self.root).bytes
                }
            }
            None => summary(&self.root).bytes,
        };
        if end == 0 {
            return Ok(());
        }
        self.walk_range(&self.root, 0, end, &mut |c, a, b| {
            let text = read_content(self.base.as_ref(), c)?;
            for ch in text[a as usize..b as usize].chars() {
                if after_cr && ch == '\n' {
                    after_cr = false;
                    continue;
                }
                after_cr = false;
                if ch == '\r' || ch == '\n' {
                    visit(line, &prefix);
                    prefix.clear();
                    line += 1;
                    has_line = false;
                    after_cr = ch == '\r';
                } else {
                    has_line = true;
                    if prefix.len() + ch.len_utf8() <= max_prefix {
                        prefix.push(ch);
                    }
                }
            }
            Ok(())
        })?;
        if has_line || line == 0 {
            visit(line, &prefix)
        }
        Ok(())
    }
    pub fn apply_batch(&mut self, expected: u64, edits: &[ViewEdit]) -> Result<u64, ViewError> {
        if expected != self.revision {
            return Err(ViewError::StaleRevision {
                expected,
                actual: self.revision,
            });
        }
        if edits.is_empty() {
            return Ok(self.revision);
        }
        let mut ranges = Vec::with_capacity(edits.len());
        for e in edits {
            let a = self.position_byte(e.start_line, e.start_column)?;
            let b = self.position_byte(e.end_line, e.end_column)?;
            if a > b {
                return Err(ViewError::InvalidRange);
            }
            ranges.push((a, b, &e.text));
        }
        ranges.sort_by_key(|r| (r.0, r.1));
        if ranges
            .windows(2)
            .any(|p| p[0].1 > p[1].0 || p[0].0 == p[1].0)
        {
            return Err(ViewError::OverlappingEdits);
        }
        let mut candidate = self.root.clone();
        for (a, b, text) in ranges.into_iter().rev() {
            let (left, rest) = split(self.base.as_ref(), candidate, a)?;
            let (_, right) = split(self.base.as_ref(), rest, b - a)?;
            candidate = join(join(left, self.added(text)?), right);
        }
        self.undo = Some(Arc::new(HistoryNode {
            root: self.root.clone(),
            previous: self.undo.clone(),
        }));
        self.redo = None;
        self.root = candidate;
        self.revision += 1;
        Ok(self.revision)
    }
    fn added(&self, text: &str) -> Result<Root, ViewError> {
        if text.is_empty() {
            return Ok(None);
        }
        let Some(directory) = self.base.delta_directory() else {
            return Ok(added(text));
        };
        let mut guard = self
            .journal
            .lock()
            .map_err(|_| ViewError::Write("journal state lock poisoned".into()))?;
        let journal = if let Some(journal) = guard.as_ref() {
            journal.clone()
        } else {
            let path = directory.join(format!(
                "edits-{}-{}.bin",
                std::process::id(),
                JOURNAL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| ViewError::Write(e.to_string()))?;
            let journal = Arc::new(DeltaJournal {
                file: Mutex::new(Some(file)),
                path,
            });
            *guard = Some(journal.clone());
            journal
        };
        drop(guard);
        let offset = journal.append(text)?;
        let mut root = None;
        let mut start = 0;
        while start < text.len() {
            let mut end = (start + SEGMENT_BYTES).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            if end < text.len()
                && text.as_bytes()[end - 1] == b'\r'
                && text.as_bytes()[end] == b'\n'
            {
                end -= 1;
            }
            root = join(
                root,
                leaf(
                    Content::Journal(
                        journal.clone(),
                        ByteSpan::new(offset + start as u64, (end - start) as u64),
                    ),
                    Summary::text(&text[start..end]),
                ),
            );
            start = end;
        }
        Ok(root)
    }
    pub fn replace_with_snapshot(
        &mut self,
        expected: u64,
        snapshot: FileBaseSnapshot,
    ) -> Result<u64, ViewError> {
        if expected != self.revision {
            return Err(ViewError::StaleRevision {
                expected,
                actual: self.revision,
            });
        }
        let delta = Arc::new(DeltaStore {
            snapshot: Some(snapshot),
        });
        let mut root = None;
        // The session's original BOM is an envelope written separately. A
        // replacement may introduce a BOM where there was none; the snapshot
        // index excludes it, so retain those newly introduced bytes as content.
        if self.prefix.is_none() {
            if let Some(prefix) = delta.snapshot.as_ref().unwrap().prefix() {
                root = leaf(Content::Delta(delta.clone(), prefix), Summary::text("\u{feff}"));
            }
        }
        for segment in delta.snapshot.as_ref().unwrap().sparse_segments().unwrap() {
            root = join(
                root,
                leaf(Content::Delta(delta.clone(), segment.span), segment.summary),
            );
        }
        self.undo = Some(Arc::new(HistoryNode {
            root: self.root.clone(),
            previous: self.undo.clone(),
        }));
        self.redo = None;
        self.root = root;
        self.revision += 1;
        Ok(self.revision)
    }
    pub fn move_history(&mut self, expected: u64, undo: bool) -> Result<u64, ViewError> {
        if expected != self.revision {
            return Err(ViewError::StaleRevision {
                expected,
                actual: self.revision,
            });
        }
        let from = if undo { &mut self.undo } else { &mut self.redo };
        let Some(entry) = from.take() else {
            return Ok(self.revision);
        };
        *from = entry.previous.clone();
        let to = if undo { &mut self.redo } else { &mut self.undo };
        *to = Some(Arc::new(HistoryNode {
            root: self.root.clone(),
            previous: to.clone(),
        }));
        self.root = entry.root.clone();
        self.revision += 1;
        Ok(self.revision)
    }
    pub fn write_range<W: Write>(
        &self,
        from: u64,
        to: u64,
        writer: &mut W,
    ) -> Result<(), ViewError> {
        if from > to || to > summary(&self.root).bytes {
            return Err(ViewError::InvalidRange);
        }
        self.walk_range(&self.root, from, to, &mut |c, a, b| match c {
            Content::Base(s) => self
                .base
                .write_span(ByteSpan::new(s.start + a, b - a), writer)
                .map_err(ViewError::Write),
            Content::Added(s, start, _) => writer
                .write_all(&s.as_bytes()[start + a as usize..start + b as usize])
                .map_err(|e| ViewError::Write(e.to_string())),
            Content::Journal(journal, span) => writer
                .write_all(&journal.read(ByteSpan::new(span.start + a, b - a))?)
                .map_err(|e| ViewError::Write(e.to_string())),
            Content::Delta(store, span) => store
                .snapshot
                .as_ref()
                .ok_or_else(|| ViewError::Write("closed delta".into()))?
                .write_span(ByteSpan::new(span.start + a, b - a), writer)
                .map_err(ViewError::Write),
        })
    }
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<(), ViewError> {
        if let Some(prefix) = self.prefix {
            self.base
                .write_span(prefix, writer)
                .map_err(ViewError::Write)?;
        }
        self.walk_range(
            &self.root,
            0,
            summary(&self.root).bytes,
            &mut |c, a, b| match c {
                Content::Base(s) => self
                    .base
                    .write_span(ByteSpan::new(s.start + a, b - a), writer)
                    .map_err(ViewError::Write),
                Content::Added(s, start, _) => writer
                    .write_all(&s.as_bytes()[start + a as usize..start + b as usize])
                    .map_err(|e| ViewError::Write(e.to_string())),
                Content::Journal(journal, span) => writer
                    .write_all(&journal.read(ByteSpan::new(span.start + a, b - a))?)
                    .map_err(|e| ViewError::Write(e.to_string())),
                Content::Delta(store, span) => store
                    .snapshot
                    .as_ref()
                    .ok_or_else(|| ViewError::Write("closed delta".into()))?
                    .write_span(ByteSpan::new(span.start + a, b - a), writer)
                    .map_err(ViewError::Write),
            },
        )
    }
    pub fn search_literal(
        &self,
        query: &str,
        start: usize,
        limit: usize,
    ) -> Result<Vec<SearchHit>, ViewError> {
        let mut hits = Vec::new();
        for line in start..self.line_count() {
            let text = self.read_line_content(line)?;
            for (a, m) in text.match_indices(query) {
                if hits.len() == limit {
                    return Ok(hits);
                }
                hits.push(SearchHit {
                    line,
                    start_column: text[..a].encode_utf16().count(),
                    end_column: text[..a + m.len()].encode_utf16().count(),
                    text: m.to_string(),
                });
            }
        }
        Ok(hits)
    }
}
