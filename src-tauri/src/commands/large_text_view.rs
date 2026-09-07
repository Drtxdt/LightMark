use std::fmt;
use std::io::Write;
use std::sync::{
    atomic::{AtomicUsize, Ordering as AtomicOrdering},
    Arc,
};

/// A byte range in the immutable source document.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteSpan {
    pub start: u64,
    pub len: u64,
}

impl ByteSpan {
    pub const fn new(start: u64, len: u64) -> Self {
        Self { start, len }
    }

    pub(crate) fn end(self) -> u64 {
        self.start.saturating_add(self.len)
    }
}

/// The source byte ranges making up one logical line. The ending is kept as a
/// separate piece so LF, CRLF, CR, and an unterminated final line round-trip.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BaseLine {
    pub content: ByteSpan,
    pub ending: Option<ByteSpan>,
}

/// A read-only base used by the segmented view. Production callers can back
/// this with a file snapshot and its line index; tests use [`MemoryBase`].
pub trait ImmutableBase {
    /// File-level bytes that are preserved in write_to but are outside the
    /// editable line/column coordinate space.
    fn prefix(&self) -> Option<ByteSpan> {
        None
    }

    fn line_spans(&self) -> &[BaseLine];
    fn read_span(&self, span: ByteSpan) -> Result<Vec<u8>, String>;
    fn write_span(&self, span: ByteSpan, writer: &mut dyn Write) -> Result<(), String>;
}

/// A small immutable reader used by the helper tests. It deliberately counts
/// bytes read so callers can prove that a chunk does not materialize the base.
pub struct MemoryBase {
    bytes: Arc<[u8]>,
    prefix: Option<ByteSpan>,
    lines: Vec<BaseLine>,
    bytes_read: Arc<AtomicUsize>,
    max_read_request: Arc<AtomicUsize>,
}

impl MemoryBase {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        let prefix = utf8_bom(&bytes);
        let content_start = prefix.map(|span| span.end() as usize).unwrap_or(0);
        let lines = scan_line_spans(&bytes, content_start);
        Self {
            bytes: Arc::from(bytes),
            prefix,
            lines,
            bytes_read: Arc::new(AtomicUsize::new(0)),
            max_read_request: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn bytes_read(&self) -> usize {
        self.bytes_read.load(AtomicOrdering::Relaxed)
    }

    pub fn max_read_request(&self) -> usize {
        self.max_read_request.load(AtomicOrdering::Relaxed)
    }
}

impl ImmutableBase for MemoryBase {
    fn prefix(&self) -> Option<ByteSpan> {
        self.prefix
    }

    fn line_spans(&self) -> &[BaseLine] {
        &self.lines
    }

    fn read_span(&self, span: ByteSpan) -> Result<Vec<u8>, String> {
        let start =
            usize::try_from(span.start).map_err(|_| "Base span is too large.".to_string())?;
        let end = usize::try_from(span.end()).map_err(|_| "Base span is too large.".to_string())?;
        if end > self.bytes.len() || start > end {
            return Err(format!(
                "Base span {start}..{end} is outside a {}-byte base.",
                self.bytes.len()
            ));
        }
        self.bytes_read
            .fetch_add(end.saturating_sub(start), AtomicOrdering::Relaxed);
        self.max_read_request
            .fetch_max(end.saturating_sub(start), AtomicOrdering::Relaxed);
        Ok(self.bytes[start..end].to_vec())
    }

    fn write_span(&self, span: ByteSpan, writer: &mut dyn Write) -> Result<(), String> {
        let start =
            usize::try_from(span.start).map_err(|_| "Base span is too large.".to_string())?;
        let end = usize::try_from(span.end()).map_err(|_| "Base span is too large.".to_string())?;
        if end > self.bytes.len() || start > end {
            return Err(format!(
                "Base span {start}..{end} is outside a {}-byte base.",
                self.bytes.len()
            ));
        }
        for chunk in self.bytes[start..end].chunks(4096) {
            self.bytes_read
                .fetch_add(chunk.len(), AtomicOrdering::Relaxed);
            self.max_read_request
                .fetch_max(chunk.len(), AtomicOrdering::Relaxed);
            writer.write_all(chunk).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ViewError {
    StaleRevision {
        expected: u64,
        actual: u64,
    },
    InvalidLine {
        line: usize,
    },
    InvalidRange,
    InvalidColumn {
        line: usize,
        column: usize,
        max: usize,
    },
    InvalidUtf16Boundary {
        line: usize,
        column: usize,
    },
    OverlappingEdits,
    BaseRead(String),
    InvalidUtf8,
    InvalidPieceBoundary {
        start: usize,
        end: usize,
    },
    Write(String),
}

impl fmt::Display for ViewError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StaleRevision { expected, actual } => {
                write!(
                    formatter,
                    "stale view revision: expected {expected}, actual {actual}"
                )
            }
            Self::InvalidLine { line } => write!(formatter, "invalid line {line}"),
            Self::InvalidRange => write!(formatter, "invalid text range"),
            Self::InvalidColumn { line, column, max } => {
                write!(
                    formatter,
                    "invalid column {column} on line {line}; maximum is {max}"
                )
            }
            Self::InvalidUtf16Boundary { line, column } => write!(
                formatter,
                "column {column} on line {line} splits a UTF-16 surrogate pair"
            ),
            Self::OverlappingEdits => write!(formatter, "batch contains overlapping edits"),
            Self::BaseRead(error) => write!(formatter, "failed to read immutable base: {error}"),
            Self::InvalidUtf8 => write!(formatter, "text view contains invalid UTF-8"),
            Self::InvalidPieceBoundary { start, end } => {
                write!(formatter, "invalid inserted piece boundary {start}..{end}")
            }
            Self::Write(error) => write!(formatter, "failed to write text view: {error}"),
        }
    }
}

impl std::error::Error for ViewError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewEdit {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub text: String,
}

impl ViewEdit {
    pub fn new(
        start_line: usize,
        start_column: usize,
        end_line: usize,
        end_column: usize,
        text: impl Into<String>,
    ) -> Self {
        Self {
            start_line,
            start_column,
            end_line,
            end_column,
            text: text.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderedChunk {
    pub revision: u64,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchHit {
    pub line: usize,
    pub start_column: usize,
    pub end_column: usize,
    pub text: String,
}

#[derive(Clone)]
enum Piece {
    Original(ByteSpan),
    Inserted {
        text: Arc<str>,
        start: usize,
        end: usize,
    },
}

impl Piece {
    fn is_empty(&self) -> bool {
        match self {
            Self::Original(span) => span.len == 0,
            Self::Inserted { start, end, .. } => start == end,
        }
    }
}

#[derive(Clone)]
struct LogicalLine {
    content: Vec<Piece>,
    ending: Option<Piece>,
}

/// A line-aware piece view over an immutable base. Edits only add shared
/// inserted slices and split existing pieces; no full-document String is kept.
pub struct SegmentedTextView<B: ImmutableBase + ?Sized> {
    base: Arc<B>,
    prefix: Option<Piece>,
    lines: Vec<LogicalLine>,
    revision: u64,
}

impl<B: ImmutableBase + ?Sized> Clone for SegmentedTextView<B> {
    fn clone(&self) -> Self {
        Self {
            base: Arc::clone(&self.base),
            prefix: self.prefix.clone(),
            lines: self.lines.clone(),
            revision: self.revision,
        }
    }
}

impl<B: ImmutableBase + ?Sized> SegmentedTextView<B> {
    pub fn new(base: Arc<B>) -> Self {
        let prefix = base.prefix().and_then(piece_from_span);
        let lines = base
            .line_spans()
            .iter()
            .map(|line| LogicalLine {
                content: piece_from_span(line.content).into_iter().collect(),
                ending: line.ending.and_then(piece_from_span),
            })
            .collect();
        Self {
            base,
            prefix,
            lines,
            revision: 0,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Rebase a freshly created view while retaining the document-level
    /// revision owned by the session. The new base must contain exactly the
    /// visible bytes represented by this view; callers perform that check
    /// before publishing the rebase.
    pub fn with_revision(mut self, revision: u64) -> Self {
        self.revision = revision;
        self
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// Return the virtual position immediately after a terminal line ending.
    /// It is not counted as an extra display line, but accepts an insertion or
    /// an edit ending at EOF.
    pub fn eof_position(&self) -> Option<(usize, usize)> {
        self.lines
            .last()
            .filter(|line| line.ending.is_some())
            .map(|_| (self.lines.len(), 0))
    }

    /// Apply all edits against one visible revision. Validation happens before
    /// mutation; reverse positional order keeps all coordinates in that batch
    /// anchored to the same view.
    pub fn apply_batch(
        &mut self,
        expected_revision: u64,
        edits: &[ViewEdit],
    ) -> Result<u64, ViewError> {
        if expected_revision != self.revision {
            return Err(ViewError::StaleRevision {
                expected: expected_revision,
                actual: self.revision,
            });
        }
        if edits.is_empty() {
            return Ok(self.revision);
        }

        for edit in edits {
            self.validate_edit(edit)?;
        }
        let mut ordered = edits.to_vec();
        ordered.sort_by(|left, right| {
            position(left.start_line, left.start_column)
                .cmp(&position(right.start_line, right.start_column))
                .then_with(|| {
                    position(left.end_line, left.end_column)
                        .cmp(&position(right.end_line, right.end_column))
                })
        });
        if ordered
            .windows(2)
            .any(|pair| ranges_overlap(&pair[0], &pair[1]))
        {
            return Err(ViewError::OverlappingEdits);
        }

        ordered.sort_by(|left, right| {
            let left_is_eof = left.start_line == self.lines.len();
            let right_is_eof = right.start_line == self.lines.len();
            right_is_eof
                .cmp(&left_is_eof)
                .then_with(|| {
                    position(right.start_line, right.start_column)
                        .cmp(&position(left.start_line, left.start_column))
                })
                .then_with(|| {
                    position(right.end_line, right.end_column)
                        .cmp(&position(left.end_line, left.end_column))
                })
        });
        // This staged candidate copies line/piece metadata and Arc handles,
        // never base bytes. Its cost is O(total visible metadata) per batch;
        // the eventual command integration must replace this with a persistent
        // tree before claiming local input-time complexity.
        let mut candidate = self.clone();
        for edit in ordered {
            candidate.apply_one(&edit)?;
        }
        self.lines = candidate.lines;
        self.revision = self.revision.saturating_add(1);
        Ok(self.revision)
    }

    pub fn read_chunk(
        &self,
        start_line: usize,
        line_count: usize,
    ) -> Result<RenderedChunk, ViewError> {
        let start = start_line.min(self.lines.len());
        let end = start.saturating_add(line_count).min(self.lines.len());
        let mut text = String::new();
        for line in start..end {
            self.append_line_text(&self.lines[line], &mut text)?;
        }
        Ok(RenderedChunk {
            revision: self.revision,
            start_line: start,
            end_line: end,
            total_lines: self.lines.len(),
            text,
        })
    }

    /// Read one logical line without its line ending. The returned text is
    /// always from the current visible revision, so command callers never
    /// fall back to the mutable source path while edits are pending.
    pub fn read_line_content(&self, line: usize) -> Result<String, ViewError> {
        self.render_content_line(line)
    }

    pub fn search_literal(
        &self,
        query: &str,
        start_line: usize,
        limit: usize,
    ) -> Result<Vec<SearchHit>, ViewError> {
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut hits = Vec::new();
        for line_index in start_line.min(self.lines.len())..self.lines.len() {
            let line = self.render_content_line(line_index)?;
            for (start, matched) in line.match_indices(query) {
                if hits.len() >= limit {
                    return Ok(hits);
                }
                let end = start + matched.len();
                hits.push(SearchHit {
                    line: line_index,
                    start_column: line[..start].encode_utf16().count(),
                    end_column: line[..end].encode_utf16().count(),
                    text: matched.to_string(),
                });
            }
        }
        Ok(hits)
    }

    /// Stream the current logical view to a writer. This is the common source
    /// for future save/export adapters; it never creates a full document copy.
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<(), ViewError> {
        if let Some(prefix) = &self.prefix {
            self.write_piece(prefix, writer)?;
        }
        for line in &self.lines {
            self.write_pieces(&line.content, writer)?;
            if let Some(ending) = &line.ending {
                self.write_piece(ending, writer)?;
            }
        }
        Ok(())
    }

    fn validate_edit(&self, edit: &ViewEdit) -> Result<(), ViewError> {
        if edit.start_line > edit.end_line {
            return Err(ViewError::InvalidRange);
        }
        let start_eof = self.is_eof_endpoint(edit.start_line, edit.start_column);
        let end_eof = self.is_eof_endpoint(edit.end_line, edit.end_column);
        if edit.start_line == self.lines.len() {
            return if start_eof && end_eof {
                Ok(())
            } else {
                Err(ViewError::InvalidRange)
            };
        }
        if edit.end_line == self.lines.len() && !end_eof {
            return Err(ViewError::InvalidRange);
        }
        let start_len = self.line_utf16_len(edit.start_line)?;
        if edit.start_column > start_len {
            return Err(ViewError::InvalidColumn {
                line: edit.start_line,
                column: edit.start_column,
                max: start_len,
            });
        }
        if end_eof {
            self.split_content_at(
                &self.lines[edit.start_line].content,
                edit.start_line,
                edit.start_column,
            )?;
            return Ok(());
        }
        let end_len = self.line_utf16_len(edit.end_line)?;
        if edit.end_column > end_len {
            return Err(ViewError::InvalidColumn {
                line: edit.end_line,
                column: edit.end_column,
                max: end_len,
            });
        }
        if edit.start_line == edit.end_line && edit.start_column > edit.end_column {
            return Err(ViewError::InvalidRange);
        }
        self.split_content_at(
            &self.lines[edit.start_line].content,
            edit.start_line,
            edit.start_column,
        )?;
        self.split_content_at(
            &self.lines[edit.end_line].content,
            edit.end_line,
            edit.end_column,
        )?;
        Ok(())
    }

    fn is_eof_endpoint(&self, line: usize, column: usize) -> bool {
        line == self.lines.len() && column == 0 && self.eof_position().is_some()
    }

    fn line_utf16_len(&self, line: usize) -> Result<usize, ViewError> {
        let line_ref = self
            .lines
            .get(line)
            .ok_or(ViewError::InvalidLine { line })?;
        let mut length: usize = 0;
        for piece in &line_ref.content {
            length = length.saturating_add(self.piece_text(piece)?.encode_utf16().count());
        }
        Ok(length)
    }

    fn apply_one(&mut self, edit: &ViewEdit) -> Result<(), ViewError> {
        if edit.start_line == self.lines.len() && edit.end_line == self.lines.len() {
            if !edit.text.is_empty() {
                let mut replacement = parse_inserted_lines(&edit.text);
                drop_unterminated_empty_tail(&mut replacement, false);
                self.lines.extend(replacement);
            }
            return Ok(());
        }
        let start_line = self.lines[edit.start_line].clone();
        let (prefix, _) =
            self.split_content_at(&start_line.content, edit.start_line, edit.start_column)?;
        let end_is_eof = edit.end_line == self.lines.len();
        let (suffix, final_ending, end_line_index) = if end_is_eof {
            (Vec::new(), None, self.lines.len().saturating_sub(1))
        } else {
            let end_line = self.lines[edit.end_line].clone();
            let (_, suffix) =
                self.split_content_at(&end_line.content, edit.end_line, edit.end_column)?;
            (suffix, end_line.ending, edit.end_line)
        };
        let mut replacement = parse_inserted_lines(&edit.text);
        drop_unterminated_empty_tail(
            &mut replacement,
            !suffix.is_empty() || final_ending.is_some(),
        );
        let mut next = Vec::with_capacity(replacement.len());

        if replacement.len() == 1 {
            let replacement_line = &replacement[0];
            let mut content = Vec::new();
            append_pieces(&mut content, prefix);
            append_pieces(&mut content, replacement_line.content.clone());
            append_pieces(&mut content, suffix);
            next.push(LogicalLine {
                content,
                ending: final_ending,
            });
        } else {
            for (index, replacement_line) in replacement.iter().enumerate() {
                let is_first = index == 0;
                let is_last = index + 1 == replacement.len();
                let mut content = Vec::new();
                if is_first {
                    append_pieces(&mut content, prefix.clone());
                }
                append_pieces(&mut content, replacement_line.content.clone());
                if is_last {
                    append_pieces(&mut content, suffix.clone());
                }
                let ending = if is_last {
                    final_ending.clone()
                } else {
                    replacement_line.ending.clone()
                };
                next.push(LogicalLine { content, ending });
            }
        }

        self.lines.splice(edit.start_line..=end_line_index, next);
        Ok(())
    }

    fn split_content_at(
        &self,
        pieces: &[Piece],
        line: usize,
        column: usize,
    ) -> Result<(Vec<Piece>, Vec<Piece>), ViewError> {
        let mut left = Vec::new();
        let mut right = Vec::new();
        let mut remaining = column;
        let mut boundary = false;

        for piece in pieces {
            if boundary {
                append_piece(&mut right, piece.clone());
                continue;
            }
            let length = self.piece_text(piece)?.encode_utf16().count();
            if remaining == 0 {
                boundary = true;
                append_piece(&mut right, piece.clone());
            } else if remaining >= length {
                remaining -= length;
                append_piece(&mut left, piece.clone());
                if remaining == 0 {
                    boundary = true;
                }
            } else {
                let (piece_left, piece_right) =
                    split_piece_at(piece, remaining, line, column, &self.base)?;
                append_piece(&mut left, piece_left);
                append_piece(&mut right, piece_right);
                remaining = 0;
                boundary = true;
            }
        }

        if remaining != 0 {
            return Err(ViewError::InvalidColumn {
                line,
                column,
                max: column.saturating_sub(remaining),
            });
        }
        Ok((left, right))
    }

    fn append_line_text(&self, line: &LogicalLine, target: &mut String) -> Result<(), ViewError> {
        for piece in &line.content {
            target.push_str(&self.piece_text(piece)?);
        }
        if let Some(ending) = &line.ending {
            target.push_str(&self.piece_text(ending)?);
        }
        Ok(())
    }

    fn write_pieces<W: Write>(&self, pieces: &[Piece], writer: &mut W) -> Result<(), ViewError> {
        for piece in pieces {
            self.write_piece(piece, writer)?;
        }
        Ok(())
    }

    fn write_piece<W: Write>(&self, piece: &Piece, writer: &mut W) -> Result<(), ViewError> {
        match piece {
            Piece::Original(span) => self
                .base
                .write_span(*span, writer)
                .map_err(ViewError::BaseRead),
            Piece::Inserted { text, start, end } => {
                let bytes =
                    text.as_bytes()
                        .get(*start..*end)
                        .ok_or(ViewError::InvalidPieceBoundary {
                            start: *start,
                            end: *end,
                        })?;
                writer
                    .write_all(bytes)
                    .map_err(|error| ViewError::Write(error.to_string()))
            }
        }
    }

    fn piece_text(&self, piece: &Piece) -> Result<String, ViewError> {
        match piece {
            Piece::Original(span) => {
                String::from_utf8(self.base.read_span(*span).map_err(ViewError::BaseRead)?)
                    .map_err(|_| ViewError::InvalidUtf8)
            }
            Piece::Inserted { text, start, end } => text
                .get(*start..*end)
                .ok_or(ViewError::InvalidPieceBoundary {
                    start: *start,
                    end: *end,
                })
                .map(str::to_string),
        }
    }

    fn render_content_line(&self, line: usize) -> Result<String, ViewError> {
        let line_ref = self
            .lines
            .get(line)
            .ok_or(ViewError::InvalidLine { line })?;
        let mut text = String::new();
        for piece in &line_ref.content {
            text.push_str(&self.piece_text(piece)?);
        }
        Ok(text)
    }
}

fn position(line: usize, column: usize) -> (usize, usize) {
    (line, column)
}

fn ranges_overlap(left: &ViewEdit, right: &ViewEdit) -> bool {
    let left_start = position(left.start_line, left.start_column);
    let left_end = position(left.end_line, left.end_column);
    let right_start = position(right.start_line, right.start_column);
    let right_end = position(right.end_line, right.end_column);
    if left_start == left_end && right_start == right_end {
        return left_start == right_start;
    }
    if left_start == left_end {
        return right_start < left_start && left_start < right_end;
    }
    if right_start == right_end {
        return left_start < right_start && right_start < left_end;
    }
    left_start < right_end && right_start < left_end
}

fn piece_from_span(span: ByteSpan) -> Option<Piece> {
    (span.len > 0).then_some(Piece::Original(span))
}

fn append_piece(target: &mut Vec<Piece>, piece: Piece) {
    if piece.is_empty() {
        return;
    }
    if let Some(previous) = target.last_mut() {
        match (previous, &piece) {
            (Piece::Original(left), Piece::Original(right)) if left.end() == right.start => {
                left.len = left.len.saturating_add(right.len);
                return;
            }
            (
                Piece::Inserted {
                    text: left_text,
                    start: _,
                    end: left_end,
                },
                Piece::Inserted {
                    text: right_text,
                    start: right_start,
                    end: right_end,
                },
            ) if Arc::ptr_eq(left_text, right_text) && *left_end == *right_start => {
                *left_end = *right_end;
                return;
            }
            _ => {}
        }
    }
    target.push(piece);
}

fn append_pieces(target: &mut Vec<Piece>, pieces: Vec<Piece>) {
    for piece in pieces {
        append_piece(target, piece);
    }
}

fn split_piece_at<B: ImmutableBase + ?Sized>(
    piece: &Piece,
    utf16_column: usize,
    line: usize,
    column: usize,
    base: &Arc<B>,
) -> Result<(Piece, Piece), ViewError> {
    let text = match piece {
        Piece::Original(span) => {
            String::from_utf8(base.read_span(*span).map_err(ViewError::BaseRead)?)
                .map_err(|_| ViewError::InvalidUtf8)?
        }
        Piece::Inserted { text, start, end } => text
            .get(*start..*end)
            .ok_or(ViewError::InvalidPieceBoundary {
                start: *start,
                end: *end,
            })?
            .to_string(),
    };
    let mut utf16 = 0;
    for (index, character) in text.char_indices() {
        if utf16 == utf16_column {
            return Ok((
                slice_piece(piece, 0, index),
                slice_piece(piece, index, text.len()),
            ));
        }
        let width = character.len_utf16();
        if utf16_column < utf16.saturating_add(width) {
            return Err(ViewError::InvalidUtf16Boundary { line, column });
        }
        utf16 = utf16.saturating_add(width);
    }
    if utf16_column == utf16 {
        return Ok((
            slice_piece(piece, 0, text.len()),
            slice_piece(piece, text.len(), text.len()),
        ));
    }
    Err(ViewError::InvalidUtf16Boundary { line, column })
}

fn slice_piece(piece: &Piece, start: usize, end: usize) -> Piece {
    match piece {
        Piece::Original(span) => Piece::Original(ByteSpan::new(
            span.start.saturating_add(start as u64),
            end.saturating_sub(start) as u64,
        )),
        Piece::Inserted {
            text,
            start: piece_start,
            ..
        } => Piece::Inserted {
            text: Arc::clone(text),
            start: piece_start.saturating_add(start),
            end: piece_start.saturating_add(end),
        },
    }
}

fn parse_inserted_lines(text: &str) -> Vec<LogicalLine> {
    let text: Arc<str> = Arc::from(text.to_string());
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut content_start = 0;
    let mut cursor = 0;
    while cursor < bytes.len() {
        let ending_len = if bytes[cursor] == b'\r' {
            if bytes.get(cursor + 1) == Some(&b'\n') {
                2
            } else {
                1
            }
        } else if bytes[cursor] == b'\n' {
            1
        } else {
            cursor += 1;
            continue;
        };
        let source = Piece::Inserted {
            text: Arc::clone(&text),
            start: 0,
            end: text.len(),
        };
        let content_piece = slice_piece(&source, content_start, cursor);
        let ending = slice_piece(&source, cursor, cursor + ending_len);
        let content = if content_piece.is_empty() {
            Vec::new()
        } else {
            vec![content_piece]
        };
        lines.push(LogicalLine {
            content,
            ending: Some(ending),
        });
        cursor += ending_len;
        content_start = cursor;
    }
    let final_content = slice_piece(
        &Piece::Inserted {
            text: Arc::clone(&text),
            start: 0,
            end: text.len(),
        },
        content_start,
        text.len(),
    );
    lines.push(LogicalLine {
        content: final_content
            .is_empty()
            .then(Vec::new)
            .unwrap_or_else(|| vec![final_content]),
        ending: None,
    });
    lines
}

fn drop_unterminated_empty_tail(lines: &mut Vec<LogicalLine>, preserve: bool) {
    if !preserve
        && lines.len() > 1
        && lines
            .last()
            .is_some_and(|line| line.content.is_empty() && line.ending.is_none())
    {
        lines.pop();
    }
}

fn scan_line_spans(bytes: &[u8], content_start: usize) -> Vec<BaseLine> {
    let mut lines = Vec::new();
    let mut content_start = content_start;
    let mut cursor = content_start;
    while cursor < bytes.len() {
        let ending_len = if bytes[cursor] == b'\r' {
            if bytes.get(cursor + 1) == Some(&b'\n') {
                2
            } else {
                1
            }
        } else if bytes[cursor] == b'\n' {
            1
        } else {
            cursor += 1;
            continue;
        };
        lines.push(BaseLine {
            content: ByteSpan::new(content_start as u64, (cursor - content_start) as u64),
            ending: Some(ByteSpan::new(cursor as u64, ending_len as u64)),
        });
        cursor += ending_len as usize;
        content_start = cursor;
    }
    if lines.is_empty() || content_start < bytes.len() {
        lines.push(BaseLine {
            content: ByteSpan::new(content_start as u64, (bytes.len() - content_start) as u64),
            ending: None,
        });
    }
    lines
}

fn utf8_bom(bytes: &[u8]) -> Option<ByteSpan> {
    (bytes.starts_with(b"\xEF\xBB\xBF")).then_some(ByteSpan::new(0, 3))
}

#[cfg(test)]
mod tests {
    use super::{ByteSpan, ImmutableBase, MemoryBase, SegmentedTextView, ViewEdit, ViewError};
    use std::io::Write;
    use std::sync::Arc;

    #[test]
    fn read_chunk_preserves_eol_bom_eof_and_only_reads_requested_lines() {
        let bytes = b"\xEF\xBB\xBFone\r\ntwo\rthree\nfour".to_vec();
        let base = Arc::new(MemoryBase::from_bytes(bytes.clone()));
        let view = SegmentedTextView::new(Arc::clone(&base));

        assert_eq!(base.prefix(), Some(ByteSpan::new(0, 3)));
        assert_eq!(base.line_spans()[0].content, ByteSpan::new(3, 3));
        assert_eq!(view.line_count(), 4);
        let chunk = view.read_chunk(1, 2).unwrap();
        assert_eq!(chunk.text, "two\rthree\n");
        assert_eq!(chunk.total_lines, 4);
        assert!(base.bytes_read() < bytes.len());
        assert_eq!(base.bytes_read(), "two\rthree\n".len());

        let mut output = Vec::new();
        view.write_to(&mut output).unwrap();
        assert_eq!(output, bytes);
    }

    #[test]
    fn bom_prefix_is_not_an_editable_column_and_survives_all_line_operations() {
        let bom = b"\xEF\xBB\xBF";
        let empty_base = Arc::new(MemoryBase::from_bytes(bom.to_vec()));
        let mut empty_view = SegmentedTextView::new(Arc::clone(&empty_base));
        assert_eq!(empty_view.line_count(), 1);
        assert_eq!(empty_view.read_chunk(0, 1).unwrap().text, "");
        empty_view
            .apply_batch(0, &[ViewEdit::new(0, 0, 0, 0, "首")])
            .unwrap();
        assert_eq!(empty_view.read_chunk(0, 1).unwrap().text, "首");
        let mut output = Vec::new();
        empty_view.write_to(&mut output).unwrap();
        assert_eq!(output, b"\xEF\xBB\xBF\xe9\xa6\x96");

        let line_base = Arc::new(MemoryBase::from_bytes(b"\xEF\xBB\xBFa\n".to_vec()));
        let mut line_view = SegmentedTextView::new(line_base);
        line_view
            .apply_batch(0, &[ViewEdit::new(0, 0, 0, 1, "x")])
            .unwrap();
        assert_eq!(line_view.read_chunk(0, 1).unwrap().text, "x\n");
        line_view
            .apply_batch(1, &[ViewEdit::new(0, 0, 1, 0, "")])
            .unwrap();
        let mut output = Vec::new();
        line_view.write_to(&mut output).unwrap();
        assert_eq!(output, bom);
        line_view
            .apply_batch(2, &[ViewEdit::new(0, 0, 0, 0, "first")])
            .unwrap();
        let mut output = Vec::new();
        line_view.write_to(&mut output).unwrap();
        assert_eq!(output, b"\xEF\xBB\xBFfirst");

        let eof_base = Arc::new(MemoryBase::from_bytes(b"\xEF\xBB\xBFa\n".to_vec()));
        let mut eof_view = SegmentedTextView::new(eof_base);
        assert_eq!(eof_view.eof_position(), Some((1, 0)));
        eof_view
            .apply_batch(0, &[ViewEdit::new(1, 0, 1, 0, "tail")])
            .unwrap();
        assert_eq!(eof_view.read_chunk(0, 2).unwrap().text, "a\ntail");
        let mut output = Vec::new();
        eof_view.write_to(&mut output).unwrap();
        assert_eq!(output, b"\xEF\xBB\xBFa\ntail");
    }

    #[test]
    fn long_base_chunk_reads_only_the_requested_window() {
        let mut bytes = Vec::new();
        for line in 0..20_000 {
            bytes.extend_from_slice(format!("{line:08}\n").as_bytes());
        }
        let total_bytes = bytes.len();
        let base = Arc::new(MemoryBase::from_bytes(bytes));
        let view = SegmentedTextView::new(Arc::clone(&base));
        let chunk = view.read_chunk(10_000, 2).unwrap();
        assert_eq!(chunk.text, "00010000\n00010001\n");
        assert_eq!(chunk.total_lines, 20_000);
        assert!(base.bytes_read() < total_bytes / 100);
    }

    #[test]
    fn insertion_then_visible_edit_uses_new_logical_rows() {
        let base = Arc::new(MemoryBase::from_bytes(b"one\ntwo\nthree\n".to_vec()));
        let mut view = SegmentedTextView::new(base);
        let revision = view
            .apply_batch(0, &[ViewEdit::new(1, 0, 1, 3, "inserted-a\ninserted-b")])
            .unwrap();
        assert_eq!(revision, 1);
        assert_eq!(view.line_count(), 4);
        let revision = view
            .apply_batch(1, &[ViewEdit::new(2, 0, 2, 10, "changed-b")])
            .unwrap();
        assert_eq!(revision, 2);
        assert_eq!(
            view.read_chunk(0, 10).unwrap().text,
            "one\ninserted-a\nchanged-b\nthree\n"
        );

        let mut output = Vec::new();
        view.write_to(&mut output).unwrap();
        assert_eq!(output, b"one\ninserted-a\nchanged-b\nthree\n");
    }

    #[test]
    fn deletion_then_visible_edit_uses_shifted_row() {
        let base = Arc::new(MemoryBase::from_bytes(
            b"keep\ndelete-me\nedit-me\n".to_vec(),
        ));
        let mut view = SegmentedTextView::new(base);
        let revision = view
            .apply_batch(0, &[ViewEdit::new(1, 0, 2, 0, "")])
            .unwrap();
        assert_eq!(revision, 1);
        assert_eq!(view.line_count(), 2);
        view.apply_batch(1, &[ViewEdit::new(1, 0, 1, 7, "edited")])
            .unwrap();
        assert_eq!(view.read_chunk(0, 10).unwrap().text, "keep\nedited\n");
    }

    #[test]
    fn terminal_eof_endpoint_supports_append_and_full_line_deletion() {
        let base = Arc::new(MemoryBase::from_bytes(b"a\n".to_vec()));
        let mut view = SegmentedTextView::new(base);
        assert_eq!(view.eof_position(), Some((1, 0)));
        view.apply_batch(0, &[ViewEdit::new(1, 0, 1, 0, "tail")])
            .unwrap();
        assert_eq!(view.line_count(), 2);
        assert_eq!(view.read_chunk(0, 10).unwrap().text, "a\ntail");

        let base = Arc::new(MemoryBase::from_bytes(b"a\n".to_vec()));
        let mut view = SegmentedTextView::new(base);
        view.apply_batch(0, &[ViewEdit::new(1, 0, 1, 0, "tail\n")])
            .unwrap();
        assert_eq!(view.line_count(), 2);
        assert_eq!(view.eof_position(), Some((2, 0)));
        assert_eq!(view.read_chunk(0, 10).unwrap().text, "a\ntail\n");
        view.apply_batch(1, &[ViewEdit::new(2, 0, 2, 0, "more\r\n")])
            .unwrap();
        assert_eq!(view.line_count(), 3);
        assert_eq!(view.eof_position(), Some((3, 0)));
        assert_eq!(view.read_chunk(0, 10).unwrap().text, "a\ntail\nmore\r\n");

        let base = Arc::new(MemoryBase::from_bytes(b"a\nb\n".to_vec()));
        let mut view = SegmentedTextView::new(base);
        view.apply_batch(0, &[ViewEdit::new(1, 0, 2, 0, "")])
            .unwrap();
        assert_eq!(view.read_chunk(0, 10).unwrap().text, "a\n");
        view.apply_batch(1, &[ViewEdit::new(0, 0, 1, 0, "")])
            .unwrap();
        assert_eq!(view.read_chunk(0, 10).unwrap().text, "");
        assert_eq!(view.line_count(), 1);
        assert_eq!(view.eof_position(), None);
        view.apply_batch(2, &[ViewEdit::new(0, 0, 0, 0, "new")])
            .unwrap();
        assert_eq!(view.read_chunk(0, 10).unwrap().text, "new");
    }

    #[test]
    fn eof_insert_and_delete_in_one_batch_share_the_original_endpoint() {
        let base = Arc::new(MemoryBase::from_bytes(b"a\nb\n".to_vec()));
        let mut view = SegmentedTextView::new(base);
        view.apply_batch(
            0,
            &[
                ViewEdit::new(1, 0, 2, 0, ""),
                ViewEdit::new(2, 0, 2, 0, "tail\nmore"),
            ],
        )
        .unwrap();
        assert_eq!(view.read_chunk(0, 10).unwrap().text, "a\ntail\nmore");
    }

    #[test]
    fn eof_endpoint_is_not_available_for_an_unterminated_line() {
        let base = Arc::new(MemoryBase::from_bytes(b"a".to_vec()));
        let mut view = SegmentedTextView::new(base);
        assert_eq!(view.eof_position(), None);
        assert_eq!(
            view.apply_batch(0, &[ViewEdit::new(1, 0, 1, 0, "tail")])
                .unwrap_err(),
            ViewError::InvalidRange
        );
    }

    #[test]
    fn batch_rejects_overlap_and_stale_revision_without_dropping_old_edits() {
        let base = Arc::new(MemoryBase::from_bytes(b"abcdef\n".to_vec()));
        let mut view = SegmentedTextView::new(base);
        let error = view
            .apply_batch(
                0,
                &[
                    ViewEdit::new(0, 0, 0, 2, "AB"),
                    ViewEdit::new(0, 1, 0, 3, "BC"),
                ],
            )
            .unwrap_err();
        assert_eq!(error, ViewError::OverlappingEdits);
        assert_eq!(view.read_chunk(0, 1).unwrap().text, "abcdef\n");

        let revision = view
            .apply_batch(
                0,
                &[
                    ViewEdit::new(0, 0, 0, 1, "A"),
                    ViewEdit::new(0, 3, 0, 4, "D"),
                ],
            )
            .unwrap();
        assert_eq!(revision, 1);
        let stale = view
            .apply_batch(0, &[ViewEdit::new(0, 1, 0, 2, "x")])
            .unwrap_err();
        assert_eq!(
            stale,
            ViewError::StaleRevision {
                expected: 0,
                actual: 1
            }
        );
        assert_eq!(view.read_chunk(0, 1).unwrap().text, "AbcDef\n");
    }

    #[test]
    fn invalid_batch_is_atomic_when_a_later_edit_has_an_invalid_utf16_boundary() {
        let base = Arc::new(MemoryBase::from_bytes(
            "😀abc\nstable\n".as_bytes().to_vec(),
        ));
        let mut view = SegmentedTextView::new(base);
        let error = view
            .apply_batch(
                0,
                &[
                    // Reverse application would commit this line before the
                    // invalid edit on the earlier line is discovered.
                    ViewEdit::new(1, 0, 1, 6, "changed"),
                    ViewEdit::new(0, 1, 0, 2, "bad"),
                ],
            )
            .unwrap_err();
        assert_eq!(
            error,
            ViewError::InvalidUtf16Boundary { line: 0, column: 1 }
        );
        assert_eq!(view.revision(), 0);
        assert_eq!(view.read_chunk(0, 2).unwrap().text, "😀abc\nstable\n");
    }

    #[test]
    fn utf16_columns_reject_surrogate_splits_and_preserve_emoji() {
        let base = Arc::new(MemoryBase::from_bytes("😀abc\n".as_bytes().to_vec()));
        let mut view = SegmentedTextView::new(base);
        view.apply_batch(0, &[ViewEdit::new(0, 3, 0, 4, "X")])
            .unwrap();
        assert_eq!(view.read_chunk(0, 1).unwrap().text, "😀aXc\n");

        let error = view
            .apply_batch(1, &[ViewEdit::new(0, 1, 0, 2, "bad")])
            .unwrap_err();
        assert_eq!(
            error,
            ViewError::InvalidUtf16Boundary { line: 0, column: 1 }
        );

        let error = view
            .apply_batch(1, &[ViewEdit::new(0, 0, 0, 99, "bad")])
            .unwrap_err();
        assert_eq!(
            error,
            ViewError::InvalidColumn {
                line: 0,
                column: 99,
                max: 5,
            }
        );
    }

    #[test]
    fn search_reads_current_view_instead_of_immutable_base() {
        let base = Arc::new(MemoryBase::from_bytes(b"one\ntwo\n".to_vec()));
        let mut view = SegmentedTextView::new(base);
        view.apply_batch(0, &[ViewEdit::new(1, 0, 1, 3, "changed")])
            .unwrap();
        let hits = view.search_literal("changed", 0, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 1);
        assert_eq!((hits[0].start_column, hits[0].end_column), (0, 7));
        assert!(view.search_literal("two", 0, 10).unwrap().is_empty());
        assert!(view.search_literal("\n", 0, 10).unwrap().is_empty());
    }

    #[test]
    fn write_to_streams_inserted_segments_without_a_full_document_copy() {
        let base = Arc::new(MemoryBase::from_bytes(b"a\nb\nc\n".to_vec()));
        let mut view = SegmentedTextView::new(Arc::clone(&base));
        view.apply_batch(0, &[ViewEdit::new(1, 0, 1, 1, "long\ninsert")])
            .unwrap();
        let mut output = Vec::new();
        view.write_to(&mut output).unwrap();
        assert_eq!(output, b"a\nlong\ninsert\nc\n");
        assert!(base.bytes_read() < 64);

        let mut sink = Vec::new();
        sink.write_all(&output).unwrap();
        assert_eq!(sink, b"a\nlong\ninsert\nc\n");
    }

    #[test]
    fn write_to_streams_a_long_original_line_in_bounded_chunks() {
        let mut bytes = vec![b'x'; 100_000];
        bytes.push(b'\n');
        let base = Arc::new(MemoryBase::from_bytes(bytes.clone()));
        let view = SegmentedTextView::new(Arc::clone(&base));
        let mut output = Vec::new();
        view.write_to(&mut output).unwrap();
        assert_eq!(output, bytes);
        assert_eq!(base.bytes_read(), bytes.len());
        assert!(base.max_read_request() <= 4096);
    }

    #[test]
    fn raw_single_edit_clone_samples_cover_100_1000_and_100000_lines() {
        for line_count in [100_usize, 1_000, 100_000] {
            let mut samples = Vec::with_capacity(10);
            for _ in 0..10 {
                let bytes = vec![b'x'; line_count * 2 - 1]
                    .into_iter()
                    .enumerate()
                    .map(|(index, byte)| if index % 2 == 1 { b'\n' } else { byte })
                    .collect::<Vec<_>>();
                let base = Arc::new(MemoryBase::from_bytes(bytes));
                let mut view = SegmentedTextView::new(base);
                let started = std::time::Instant::now();
                view.apply_batch(
                    0,
                    &[ViewEdit::new(line_count / 2, 0, line_count / 2, 1, "y")],
                )
                .unwrap();
                samples.push(started.elapsed().as_micros());
                assert_eq!(view.line_count(), line_count);
            }
            let mut sorted = samples.clone();
            sorted.sort_unstable();
            let median = (sorted[4] + sorted[5]) / 2;
            println!(
                "wp04c_raw_clone_samples lines={line_count} samples={samples:?} median_us={median}"
            );
        }
    }

    #[test]
    fn deterministic_differential_oracle_covers_mixed_eol_utf16_and_eof_batches() {
        let initial = "\u{FEFF}甲😀a\r\n乙b\r丙\n末".to_string();
        let visible_initial = initial.trim_start_matches('\u{FEFF}').to_string();
        let base = Arc::new(MemoryBase::from_bytes(initial.as_bytes().to_vec()));
        let mut view = SegmentedTextView::new(base);
        let mut oracle = visible_initial;
        assert_eq!(view.read_chunk(0, 20).unwrap().text, oracle);
        let mut seed = 0xD1FF_EA5E_2026_0907_u64;

        // Invalid boundaries and overlap must leave the same document and
        // revision before the random walk starts.
        let before = oracle.clone();
        let before_revision = view.revision();
        let (emoji_line, split_column) = first_surrogate_split(&oracle).unwrap();
        assert!(matches!(
            view.apply_batch(
                before_revision,
                &[ViewEdit::new(
                    emoji_line,
                    split_column,
                    emoji_line,
                    split_column + 1,
                    "bad"
                )]
            ),
            Err(ViewError::InvalidUtf16Boundary { .. })
        ));
        assert_eq!(view.revision(), before_revision);
        assert_eq!(view.read_chunk(0, 20).unwrap().text, before);
        assert_eq!(
            view.apply_batch(
                before_revision,
                &[
                    ViewEdit::new(0, 0, 0, 0, "x"),
                    ViewEdit::new(0, 0, 0, 0, "y"),
                ]
            ),
            Err(ViewError::OverlappingEdits)
        );
        assert_eq!(view.revision(), before_revision);
        assert_eq!(view.read_chunk(0, 20).unwrap().text, before);

        for step in 0..256 {
            let edits = if step % 9 == 0 {
                non_overlapping_insert_batch(&oracle)
                    .unwrap_or_else(|| vec![random_oracle_edit(&mut seed, &oracle)])
            } else {
                vec![random_oracle_edit(&mut seed, &oracle)]
            };
            let mut next_oracle = oracle.clone();
            apply_oracle_batch(&mut next_oracle, &edits);
            let next_revision = view.revision().saturating_add(1);
            assert_eq!(view.apply_batch(view.revision(), &edits), Ok(next_revision));
            oracle = next_oracle;

            let lines = oracle_lines(&oracle);
            assert_eq!(view.line_count(), lines.len(), "line count at step {step}");
            assert_eq!(
                view.read_chunk(0, lines.len() + 1).unwrap().text,
                oracle,
                "full text at step {step}"
            );
            let mut streamed = Vec::new();
            view.write_to(&mut streamed).unwrap();
            let expected_stream = format!("\u{FEFF}{oracle}");
            assert_eq!(
                streamed,
                expected_stream.as_bytes(),
                "streamed text at step {step}"
            );
            assert_eq!(
                view.eof_position(),
                oracle_eof_position(&lines),
                "EOF position at step {step}"
            );

            let start = (next_random(&mut seed) as usize) % (lines.len() + 1);
            let count = (next_random(&mut seed) as usize) % 4;
            let actual = view.read_chunk(start, count).unwrap().text;
            assert_eq!(
                actual,
                oracle_chunk(&oracle, &lines, start, count),
                "chunk at step {step}"
            );
        }
    }

    #[derive(Clone, Copy)]
    struct OracleLine {
        content_start: usize,
        content_end: usize,
        end: usize,
        has_ending: bool,
    }

    fn oracle_lines(value: &str) -> Vec<OracleLine> {
        let bytes = value.as_bytes();
        let mut lines = Vec::new();
        let mut content_start = 0;
        let mut cursor = 0;
        while cursor < bytes.len() {
            let ending_len = if bytes[cursor] == b'\r' {
                if bytes.get(cursor + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                }
            } else if bytes[cursor] == b'\n' {
                1
            } else {
                cursor += 1;
                continue;
            };
            lines.push(OracleLine {
                content_start,
                content_end: cursor,
                end: cursor + ending_len,
                has_ending: true,
            });
            cursor += ending_len;
            content_start = cursor;
        }
        if lines.is_empty() || content_start < bytes.len() {
            lines.push(OracleLine {
                content_start,
                content_end: bytes.len(),
                end: bytes.len(),
                has_ending: false,
            });
        }
        lines
    }

    fn oracle_utf16_boundaries(value: &str) -> Vec<usize> {
        let mut boundaries = vec![0];
        let mut column = 0;
        for character in value.chars() {
            column += character.len_utf16();
            boundaries.push(column);
        }
        boundaries
    }

    fn oracle_position_to_byte(value: &str, line: usize, column: usize) -> usize {
        let lines = oracle_lines(value);
        if line == lines.len() && column == 0 && lines.last().is_some_and(|item| item.has_ending) {
            return value.len();
        }
        let item = lines.get(line).expect("oracle line must exist");
        let content = &value[item.content_start..item.content_end];
        let boundaries = oracle_utf16_boundaries(content);
        let byte_offset = boundaries
            .iter()
            .position(|boundary| *boundary == column)
            .map(|index| {
                content
                    .char_indices()
                    .nth(index)
                    .map(|(byte, _)| byte)
                    .unwrap_or(content.len())
            })
            .expect("oracle position must be a UTF-16 boundary");
        item.content_start + byte_offset
    }

    fn apply_oracle_batch(value: &mut String, edits: &[ViewEdit]) {
        let mut ranges = edits
            .iter()
            .map(|edit| {
                let start = oracle_position_to_byte(value, edit.start_line, edit.start_column);
                let end = oracle_position_to_byte(value, edit.end_line, edit.end_column);
                (start, end, start == end, edit.text.as_str())
            })
            .collect::<Vec<_>>();
        ranges.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.2.cmp(&left.2)));
        for (start, end, _, text) in ranges {
            value.replace_range(start..end, text);
        }
    }

    fn oracle_chunk(value: &str, lines: &[OracleLine], start: usize, count: usize) -> String {
        let start = start.min(lines.len());
        let end = start.saturating_add(count).min(lines.len());
        if start == end {
            return String::new();
        }
        value[lines[start].content_start..lines[end - 1].end].to_string()
    }

    fn oracle_eof_position(lines: &[OracleLine]) -> Option<(usize, usize)> {
        lines
            .last()
            .filter(|item| item.has_ending)
            .map(|_| (lines.len(), 0))
    }

    fn first_surrogate_split(value: &str) -> Option<(usize, usize)> {
        for (line, item) in oracle_lines(value).iter().enumerate() {
            let content = &value[item.content_start..item.content_end];
            if let Some(byte) = content.find('😀') {
                return Some((line, content[..byte].encode_utf16().count() + 1));
            }
        }
        None
    }

    fn next_random(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *seed
    }

    fn random_oracle_edit(seed: &mut u64, value: &str) -> ViewEdit {
        const REPLACEMENTS: [&str; 6] = ["", "x", "甲", "😀", "u\nv", "tail\r\n末"];
        let lines = oracle_lines(value);
        let has_eof = lines.last().is_some_and(|item| item.has_ending);
        if has_eof && next_random(seed) % 7 == 0 {
            let replacement = REPLACEMENTS[(next_random(seed) as usize) % REPLACEMENTS.len()];
            return ViewEdit::new(lines.len(), 0, lines.len(), 0, replacement);
        }
        let start_line = (next_random(seed) as usize) % lines.len();
        let start_content = &value[lines[start_line].content_start..lines[start_line].content_end];
        let start_boundaries = oracle_utf16_boundaries(start_content);
        let start_column = start_boundaries[(next_random(seed) as usize) % start_boundaries.len()];
        let endpoint_allowed = has_eof && next_random(seed) % 5 == 0;
        let end_line = if endpoint_allowed {
            lines.len()
        } else {
            start_line + (next_random(seed) as usize) % (lines.len() - start_line)
        };
        let end_column = if end_line == lines.len() {
            0
        } else {
            let end_content = &value[lines[end_line].content_start..lines[end_line].content_end];
            let end_boundaries = oracle_utf16_boundaries(end_content);
            let minimum = if end_line == start_line {
                start_boundaries
                    .iter()
                    .position(|boundary| *boundary >= start_column)
                    .unwrap_or(0)
            } else {
                0
            };
            end_boundaries
                [minimum + (next_random(seed) as usize) % (end_boundaries.len() - minimum)]
        };
        let replacement = REPLACEMENTS[(next_random(seed) as usize) % REPLACEMENTS.len()];
        ViewEdit::new(start_line, start_column, end_line, end_column, replacement)
    }

    fn non_overlapping_insert_batch(value: &str) -> Option<Vec<ViewEdit>> {
        let lines = oracle_lines(value);
        let first = (0, 0);
        let last_content = &value[lines.last()?.content_start..lines.last()?.content_end];
        let last_column = oracle_utf16_boundaries(last_content)
            .last()
            .copied()
            .unwrap_or(0);
        let second = if lines.len() > 1 {
            (lines.len() - 1, last_column)
        } else if last_column > 0 {
            (0, last_column)
        } else if lines.last()?.has_ending {
            (lines.len(), 0)
        } else {
            return None;
        };
        (first != second).then_some(vec![
            ViewEdit::new(first.0, first.1, first.0, first.1, "甲"),
            ViewEdit::new(second.0, second.1, second.0, second.1, "😀"),
        ])
    }
}
