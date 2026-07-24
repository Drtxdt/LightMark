export interface MarkdownFormatStats {
  changedLines: number;
  trailingWhitespaceRemoved: number;
  blankLinesRemoved: number;
  listIndentationFixed: number;
  tablesFormatted: number;
}

export interface MarkdownFormatResult {
  text: string;
  changed: boolean;
  stats: MarkdownFormatStats;
  /** Maps each original zero-based line to its closest formatted line. */
  lineMap: number[];
}

import {
  delimiterAlignment,
  parseMarkdownTableRow,
  tableCellVisibleWidth,
  type MarkdownTableRow,
} from "./tableMarkdown";

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LIST_RE = /^(\s+)([-+*]|\d+[.)])\s+/;
const HTML_START_RE = /^\s*(?:<!--|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|>|\/))/i;

function splitLines(source: string) {
  return source.split(/\r?\n/);
}

function formatTable(rows: MarkdownTableRow[]) {
  const columnCount = rows[1].cells.length;
  const alignments = rows[1].cells.map((cell) => delimiterAlignment(cell.source));
  if (columnCount === 0 || alignments.some((alignment) => alignment === null)) return null;
  if (rows.some((row) => row.cells.length !== columnCount)) return null;
  const widths = Array.from({ length: columnCount }, (_, column) => {
    const contentWidth = Math.max(...rows.filter((_, row) => row !== 1).map((row) => tableCellVisibleWidth(row.cells[column].source)), 0);
    return Math.max(3, contentWidth, alignments[column] === "center" ? 5 : 4);
  });
  const useLeadingPipe = rows[0].leadingPipe;
  const useTrailingPipe = rows[0].trailingPipe;
  return rows.map((row, rowIndex) => {
    const cells = row.cells.map((tableCell, column) => {
      const cell = tableCell.source;
      const width = widths[column];
      if (rowIndex === 1) {
        const alignment = alignments[column];
        const left = alignment === "left" || alignment === "center" ? ":" : "";
        const right = alignment === "right" || alignment === "center" ? ":" : "";
        return `${left}${"-".repeat(Math.max(3, width - left.length - right.length))}${right}`;
      }
      return cell + " ".repeat(Math.max(0, width - tableCellVisibleWidth(cell)));
    });
    return `${useLeadingPipe ? "| " : ""}${cells.join(" | ")}${useTrailingPipe ? " |" : ""}`;
  });
}

function trailingNormalized(line: string) {
  const match = line.match(/[ \t]+$/);
  if (!match) return line;
  const trailing = match[0];
  // Two spaces are a Markdown hard break. Preserve that intent exactly.
  const replacement = trailing.includes("\t") || trailing.length !== 2 ? "" : "  ";
  return line.slice(0, -trailing.length) + replacement;
}

function trailingBlankLineCount(lines: string[]) {
  let count = 0;
  for (let index = lines.length - 1; index >= 0 && !lines[index].trim(); index -= 1) count += 1;
  return count;
}

export function formatMarkdown(source: string): MarkdownFormatResult {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalEol = source.endsWith("\n");
  const input = splitLines(source);
  if (hadFinalEol) input.pop();
  const output: string[] = [];
  const lineMap: number[] = [];
  const stats: MarkdownFormatStats = {
    changedLines: 0,
    trailingWhitespaceRemoved: 0,
    blankLinesRemoved: 0,
    listIndentationFixed: 0,
    tablesFormatted: 0,
  };
  let fence: { marker: string; length: number } | null = null;
  let frontMatter = input[0]?.trim() === "---";
  let needsFrontMatterGap = false;
  let mathBlock = false;
  let htmlBlock = false;

  const emit = (line: string, originalIndex: number) => {
    lineMap[originalIndex] = output.length;
    output.push(line);
  };

  for (let index = 0; index < input.length; index += 1) {
    const original = input[index];
    if (needsFrontMatterGap) {
      if (original.trim()) output.push("");
      needsFrontMatterGap = false;
    }
    if (frontMatter) {
      emit(original, index);
      if (index > 0 && /^(---|\.\.\.)\s*$/.test(original)) {
        frontMatter = false;
        needsFrontMatterGap = true;
      }
      continue;
    }
    if (fence) {
      emit(original, index);
      const close = original.match(/^\s*(`+|~+)\s*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
      continue;
    }
    const fenceMatch = original.match(FENCE_RE);
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      emit(original, index);
      continue;
    }
    if (mathBlock) {
      emit(original, index);
      if (/^\s*\$\$\s*$/.test(original)) mathBlock = false;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(original)) {
      mathBlock = true;
      emit(original, index);
      continue;
    }
    if (htmlBlock) {
      emit(original, index);
      if (!original.trim() || /-->\s*$/.test(original)) htmlBlock = false;
      continue;
    }
    if (HTML_START_RE.test(original)) {
      htmlBlock = !(!original.trim() || /-->\s*$/.test(original) || /<\/[^>]+>\s*$/.test(original));
      emit(original, index);
      continue;
    }

    const header = parseMarkdownTableRow(original);
    const delimiter = index + 1 < input.length ? parseMarkdownTableRow(input[index + 1]) : null;
    if (header && delimiter && delimiter.cells.every((cell) => delimiterAlignment(cell.source) !== null)) {
      const parsedRows = [header, delimiter];
      let end = index + 2;
      while (end < input.length) {
        const row = parseMarkdownTableRow(input[end]);
        if (!row || row.cells.length !== delimiter.cells.length) break;
        parsedRows.push(row);
        end += 1;
      }
      const formatted = formatTable(parsedRows);
      if (formatted) {
        formatted.forEach((line, offset) => emit(line, index + offset));
        if (formatted.some((line, offset) => line !== input[index + offset])) stats.tablesFormatted += 1;
        index = end - 1;
        continue;
      }
    }

    if (!original.trim()) {
      const consecutive = trailingBlankLineCount(output);
      if (consecutive >= 2) {
        lineMap[index] = Math.max(0, output.length - 1);
        stats.blankLinesRemoved += 1;
        continue;
      }
      emit("", index);
      continue;
    }

    let line = trailingNormalized(original);
    if (line !== original) stats.trailingWhitespaceRemoved += 1;
    const list = line.match(LIST_RE);
    if (list && list[1].includes("\t")) {
      const indent = list[1].replace(/\t/g, "  ");
      line = indent + line.slice(list[1].length);
      stats.listIndentationFixed += 1;
    }
    emit(line, index);
  }

  const text = output.join(eol) + (hadFinalEol ? eol : "");
  const changed = text !== source;
  if (changed) {
    const before = splitLines(source);
    const after = splitLines(text);
    const count = Math.max(before.length, after.length);
    for (let index = 0; index < count; index += 1) if (before[index] !== after[index]) stats.changedLines += 1;
  }
  return { text, changed, stats, lineMap };
}

export function mapMarkdownOffset(source: string, result: MarkdownFormatResult, offset: number) {
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, safeOffset);
  const line = (before.match(/\n/g) ?? []).length;
  const column = safeOffset - (before.lastIndexOf("\n") + 1);
  const targetLines = splitLines(result.text);
  const targetLine = Math.max(0, Math.min(result.lineMap[line] ?? targetLines.length - 1, targetLines.length - 1));
  let targetOffset = 0;
  for (let index = 0; index < targetLine; index += 1) targetOffset += targetLines[index].length + (result.text.includes("\r\n") ? 2 : 1);
  return targetOffset + Math.min(column, targetLines[targetLine]?.length ?? 0);
}

export function buildMarkdownFormatDiff(source: string, formatted: string, limit = 18) {
  const before = splitLines(source);
  const after = splitLines(formatted);
  const changes: string[] = [];
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (before[index] === after[index]) continue;
    const line = index + 1;
    if (before[index] !== undefined) changes.push(`− ${line}: ${before[index] || "（空行）"}`);
    if (after[index] !== undefined) changes.push(`+ ${line}: ${after[index] || "（空行）"}`);
  }
  if (changes.length <= limit) return changes;
  const head = Math.ceil(limit / 2);
  const tail = Math.floor(limit / 2);
  return [...changes.slice(0, head), `… 另有 ${changes.length - limit} 条变更`, ...changes.slice(-tail)];
}
