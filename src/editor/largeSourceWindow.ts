import type { TextEdit } from "../types";

export interface LargePosition { line: number; column: number }
export interface LargeRange { start: LargePosition; end: LargePosition }
export const LARGE_WINDOW_BYTES = 256 * 1024;
export const LARGE_CACHE_BYTES = 32 * 1024 * 1024;
export const LARGE_PREVIEW_BYTES = 1024 * 1024;
export const LARGE_COPY_BYTES = 16 * 1024 * 1024;
export const LARGE_EDIT_BYTES = 500 * 1024 * 1024;

export function compareLargePosition(a: LargePosition, b: LargePosition) {
  return a.line - b.line || a.column - b.column;
}
export function orderedLargeRange(a: LargePosition, b: LargePosition): LargeRange {
  return compareLargePosition(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a };
}

/** Coordinates use UTF-16 columns; CRLF is one logical line boundary. */
export function advanceLargePosition(start: LargePosition, text: string): LargePosition {
  let line = start.line;
  let column = start.column;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 13 || character === 10) {
      if (character === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      line += 1;
      column = 0;
    } else column += 1;
  }
  return { line, column };
}

/** CM offsets refer to LF-normalized bounded text, never the entire file. */
export function windowOffsetPosition(text: string, start: LargePosition, offset: number): LargePosition {
  return advanceLargePosition(start, text.slice(0, Math.max(0, offset)));
}
export function windowPositionOffset(text: string, start: LargePosition, target: LargePosition): number | null {
  let position = { ...start };
  for (let index = 0; index <= text.length; index += 1) {
    if (compareLargePosition(position, target) === 0) return index;
    if (index === text.length || compareLargePosition(position, target) > 0) return null;
    if (text[index] === "\n") position = { line: position.line + 1, column: 0 };
    else position.column += 1;
  }
  return null;
}

/** User-entered UTF-16 columns must not put an editing caret inside a surrogate pair. */
export function safeLargeWindowOffset(text: string, offset: number) {
  const bounded = Math.max(0, Math.min(text.length, offset));
  return bounded > 0 && /[\uDC00-\uDFFF]/.test(text[bounded] ?? '') && /[\uD800-\uDBFF]/.test(text[bounded - 1])
    ? bounded - 1 : bounded;
}

export function replacementForWindow(before: string, after: string, start: LargePosition, eol = "\n"): TextEdit | null {
  if (before === after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  // Do not split a surrogate pair at the edge of the patch.
  if (prefix > 0 && /[\uDC00-\uDFFF]/.test(before[prefix] ?? "")) prefix -= 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(before[before.length - suffix] ?? "")) suffix -= 1;
  const from = windowOffsetPosition(before, start, prefix);
  const to = windowOffsetPosition(before, start, before.length - suffix);
  return {
    startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column,
    text: after.slice(prefix, after.length - suffix).replace(/\n/g, eol),
  };
}

/** Exact raw patch preserves mixed endings inside a multi-change editing batch. */
export function replacementForRawWindow(before: string, after: string, start: LargePosition): TextEdit | null {
  if (before === after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  if (prefix > 0 && (/[\uDC00-\uDFFF]/.test(before[prefix] ?? "") || before[prefix - 1] === "\r" && before[prefix] === "\n")) prefix -= 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (suffix > 0 && (/[\uDC00-\uDFFF]/.test(before[before.length - suffix] ?? "")
    || before[before.length - suffix - 1] === "\r" && before[before.length - suffix] === "\n")) suffix -= 1;
  const from = advanceLargePosition(start, before.slice(0, prefix));
  const to = advanceLargePosition(start, before.slice(0, before.length - suffix));
  return { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column, text: after.slice(prefix, after.length - suffix) };
}

/** A fixed-size DOM track maps to logical lines without browser height overflow. */
export const LARGE_SCROLL_TRACK = 1_000_000;
export function lineToTrack(line: number, totalLines: number) {
  return Math.max(0, Math.min(1, line / Math.max(1, totalLines - 1))) * LARGE_SCROLL_TRACK;
}
export function trackToLine(offset: number, totalLines: number) {
  return Math.round(Math.max(0, Math.min(1, offset / LARGE_SCROLL_TRACK)) * Math.max(0, totalLines - 1));
}

/** LRU is charged by actual UTF-16 allocation, with no unbounded entry metadata. */
export class LargeWindowCache<T extends { text: string }> {
  private entries = new Map<string, T>();
  private used = 0;
  constructor(readonly budget = LARGE_CACHE_BYTES) {}
  get sizeBytes() { return this.used; }
  get(key: string) {
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: T) {
    const old = this.entries.get(key);
    if (old) { this.used -= old.text.length * 2 + key.length * 2 + 128; this.entries.delete(key); }
    const cost = value.text.length * 2 + key.length * 2 + 128;
    if (cost > this.budget) return;
    this.entries.set(key, value); this.used += cost;
    while (this.used > this.budget) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest)!;
      this.used -= evicted.text.length * 2 + oldest.length * 2 + 128;
      this.entries.delete(oldest);
    }
  }
  clear() { this.entries.clear(); this.used = 0; }
}
