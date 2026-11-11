import type { LargeOutlineItem, TextEdit } from "../types";

export type LargeEditingBufferBase = {
  startLine: number;
  baseText: string;
};

export type LargeLineRecord = {
  line: number;
  text: string;
  eol: string;
};

export type LargeBlockEditResult = {
  edit: TextEdit;
  resultingText: string;
};

export type LargeOutlineProjection = {
  outline: LargeOutlineItem[];
  totalLines: number;
  lineDelta: number;
};

type TextPart = { text: string; eol: string };

/** Normalize only for comparison and coordinate calculation. */
export function normalizeLargeLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitTextParts(value: string): TextPart[] {
  const parts: TextPart[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\r" && character !== "\n") continue;
    const eol = character === "\r" && value[index + 1] === "\n" ? "\r\n" : character;
    parts.push({ text: value.slice(start, index), eol });
    start = index + eol.length;
    if (eol.length === 2) index += 1;
  }
  parts.push({ text: value.slice(start), eol: "" });
  return parts;
}

function splitOutlineLines(value: string) {
  return splitTextParts(value).map((part) => part.text);
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function adjustDiffToCodePointBoundaries(
  base: string,
  next: string,
  prefix: number,
  suffix: number,
) {
  // The backend coordinates remain UTF-16 code units, but an edit boundary
  // must not land between the two units of a surrogate pair.  This can happen
  // when two emoji share their high surrogate and differ only in the low one.
  while (prefix > 0
    && (isLowSurrogate(base.charCodeAt(prefix)) || isLowSurrogate(next.charCodeAt(prefix)))) {
    prefix -= 1;
  }
  while (suffix > 0) {
    const baseBoundary = base.length - suffix;
    const nextBoundary = next.length - suffix;
    const baseSplitsPair = baseBoundary > 0
      && baseBoundary < base.length
      && isHighSurrogate(base.charCodeAt(baseBoundary - 1))
      && isLowSurrogate(base.charCodeAt(baseBoundary));
    const nextSplitsPair = nextBoundary > 0
      && nextBoundary < next.length
      && isHighSurrogate(next.charCodeAt(nextBoundary - 1))
      && isLowSurrogate(next.charCodeAt(nextBoundary));
    if (!baseSplitsPair && !nextSplitsPair) break;
    suffix -= 1;
  }
  return { prefix, suffix };
}

/** Parse only the headings in a complete affected line range. */
export function parseLargeOutlineItems(markdown: string, startLine: number): LargeOutlineItem[] {
  return splitOutlineLines(markdown)
    .map((line, index) => {
      const match = line.trimStart().match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (!match) return null;
      const text = match[2].trim();
      if (!text) return null;
      const lineNumber = startLine + index;
      return {
        id: `large-heading-${lineNumber}`,
        text,
        level: match[1].length as LargeOutlineItem["level"],
        line: lineNumber,
      };
    })
    .filter((item): item is LargeOutlineItem => Boolean(item));
}

/**
 * Project outline metadata from a backend-acknowledged edit.  The caller
 * supplies the complete new text for the affected line range; `edit.text` is
 * only the changed character range and cannot describe a partially edited
 * heading.  The old range is always the explicit line coordinate range, so a
 * one-character edit cannot accidentally use the whole block as its delta.
 */
export function projectLargeOutline(
  outline: readonly LargeOutlineItem[],
  edit: Pick<TextEdit, "startLine" | "endLine">,
  nextAffectedText: string,
  totalLines: number,
): LargeOutlineProjection {
  const oldLineCount = Math.max(1, edit.endLine - edit.startLine + 1);
  const nextLineCount = Math.max(1, splitOutlineLines(nextAffectedText).length);
  const lineDelta = nextLineCount - oldLineCount;
  const replacementItems = parseLargeOutlineItems(nextAffectedText, edit.startLine);
  const nextOutline = outline
    .filter((item) => item.line < edit.startLine || item.line > edit.endLine)
    .map((item) => item.line > edit.endLine
      ? { ...item, line: item.line + lineDelta, id: `large-heading-${item.line + lineDelta}` }
      : item);
  nextOutline.push(...replacementItems);
  nextOutline.sort((a, b) => a.line - b.line);
  return {
    outline: nextOutline,
    totalLines: Math.max(0, totalLines + lineDelta),
    lineDelta,
  };
}

function normalizedOffsetToRawOffset(value: string, offset: number) {
  const bounded = Math.max(0, Math.min(offset, normalizeLargeLineEndings(value).length));
  let raw = 0;
  let normalized = 0;
  while (raw < value.length && normalized < bounded) {
    if (value[raw] === "\r" && value[raw + 1] === "\n") raw += 2;
    else raw += 1;
    normalized += 1;
  }
  return raw;
}

function offsetPosition(value: string, startLine: number, offset: number) {
  const before = value.slice(0, Math.max(0, Math.min(offset, value.length)));
  const lines = splitTextParts(before);
  const last = lines[lines.length - 1];
  return { line: startLine + lines.length - 1, column: last?.text.length ?? 0 };
}

/**
 * Build the smallest UTF-16 edit for an editing buffer.  EOLs are normalized
 * only while comparing the textarea value; the resulting block keeps every
 * untouched raw EOL byte from the captured base text.
 */
export function createLargeBlockEdit(
  buffer: LargeEditingBufferBase,
  text: string,
): LargeBlockEditResult {
  const baseComparable = normalizeLargeLineEndings(buffer.baseText);
  const nextComparable = normalizeLargeLineEndings(text);
  let prefix = 0;
  while (prefix < baseComparable.length
    && prefix < nextComparable.length
    && baseComparable[prefix] === nextComparable[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < baseComparable.length - prefix
    && suffix < nextComparable.length - prefix
    && baseComparable[baseComparable.length - suffix - 1]
      === nextComparable[nextComparable.length - suffix - 1]) {
    suffix += 1;
  }
  ({ prefix, suffix } = adjustDiffToCodePointBoundaries(
    baseComparable,
    nextComparable,
    prefix,
    suffix,
  ));
  const rawStart = normalizedOffsetToRawOffset(buffer.baseText, prefix);
  const rawEnd = normalizedOffsetToRawOffset(buffer.baseText, baseComparable.length - suffix);
  const start = offsetPosition(buffer.baseText, buffer.startLine, rawStart);
  const end = offsetPosition(buffer.baseText, buffer.startLine, rawEnd);
  const replacement = nextComparable.slice(prefix, nextComparable.length - suffix);
  return {
    edit: {
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      text: replacement,
    },
    resultingText: `${buffer.baseText.slice(0, rawStart)}${replacement}${buffer.baseText.slice(rawEnd)}`,
  };
}

/**
 * Apply an acknowledged edit to the loaded line window.  The backend edit is
 * a UTF-16 range, so preserve the start/end line prefixes and suffixes and
 * shift only lines after the replaced range.  This keeps the local projection
 * usable for the next edit even when the viewport has not reloaded yet.
 */
export function applyLargeLocalEdit(
  lines: readonly LargeLineRecord[],
  edit: TextEdit,
): { lines: LargeLineRecord[]; lineDelta: number } | null {
  const startIndex = lines.findIndex((line) => line.line === edit.startLine);
  const endIndex = lines.findIndex((line) => line.line === edit.endLine);
  if (startIndex < 0 || endIndex < startIndex) return null;
  const startRecord = lines[startIndex];
  const endRecord = lines[endIndex];
  if (edit.startColumn < 0
    || edit.endColumn < 0
    || (edit.startLine === edit.endLine && edit.endColumn < edit.startColumn)
    || edit.startColumn > startRecord.text.length
    || edit.endColumn > endRecord.text.length) return null;

  const replacementText = `${startRecord.text.slice(0, edit.startColumn)}${edit.text}${endRecord.text.slice(edit.endColumn)}`;
  const replacement = splitTextParts(replacementText);
  if (replacement.length > 0 && replacement[replacement.length - 1].eol === "") {
    // The terminator after the range is outside the edit and must survive
    // exactly, including CR-only and mixed-EOL source files.
    replacement[replacement.length - 1].eol = endRecord.eol;
  }
  const oldLineCount = edit.endLine - edit.startLine + 1;
  const lineDelta = replacement.length - oldLineCount;
  const nextLines = replacement.map((part, index) => ({
    line: edit.startLine + index,
    text: part.text,
    eol: part.eol,
  }));
  return {
    lineDelta,
    lines: [
      ...lines.slice(0, startIndex),
      ...nextLines,
      ...lines.slice(endIndex + 1).map((line) => ({ ...line, line: line.line + lineDelta })),
    ],
  };
}
