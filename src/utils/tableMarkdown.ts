export type MarkdownTableAlignment = "left" | "center" | "right" | "none";

export interface MarkdownTableCell {
  source: string;
}

export interface MarkdownTableRow {
  cells: MarkdownTableCell[];
  leadingPipe: boolean;
  trailingPipe: boolean;
}

export interface MarkdownTableBlock {
  rows: MarkdownTableRow[];
  alignments: MarkdownTableAlignment[];
}

export function parseMarkdownTableRow(line: string): MarkdownTableRow | null {
  if (!line.includes("|")) return null;
  const trimmed = line.trim();
  const leadingPipe = trimmed.startsWith("|");
  const trailingPipe = hasUnescapedTrailingPipe(trimmed);
  const body = trimmed.slice(leadingPipe ? 1 : 0, trailingPipe ? -1 : undefined);
  const cells: MarkdownTableCell[] = [];
  let current = "";
  let escaped = false;
  let codeDelimiter = 0;
  let htmlCode = false;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (!htmlCode && codeDelimiter === 0) {
      const openCode = body.slice(index).match(/^<code(?:\s[^>]*)?>/i)?.[0];
      if (openCode) {
        current += openCode;
        htmlCode = true;
        index += openCode.length - 1;
        continue;
      }
    }
    if (htmlCode) {
      const closeCode = body.slice(index).match(/^<\/code>/i)?.[0];
      if (closeCode) {
        current += closeCode;
        htmlCode = false;
        index += closeCode.length - 1;
      } else {
        current += character;
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (body[index + run] === "`") run += 1;
      current += "`".repeat(run);
      if (codeDelimiter === 0) codeDelimiter = run;
      else if (codeDelimiter === run) codeDelimiter = 0;
      index += run - 1;
      continue;
    }
    if (character === "|" && codeDelimiter === 0) {
      cells.push({ source: current.trim() });
      current = "";
      continue;
    }
    current += character;
  }
  cells.push({ source: current.trim() });
  return cells.length > 1 ? { cells, leadingPipe, trailingPipe } : null;
}

export function parseMarkdownTableBlock(lines: string[], start: number): MarkdownTableBlock | null {
  const header = parseMarkdownTableRow(lines[start] ?? "");
  const delimiter = parseMarkdownTableRow(lines[start + 1] ?? "");
  if (!header || !delimiter || header.cells.length !== delimiter.cells.length) return null;
  const alignments = delimiter.cells.map((cell) => delimiterAlignment(cell.source));
  if (alignments.some((alignment) => alignment === null)) return null;

  const rows = [header, delimiter];
  for (let index = start + 2; index < lines.length; index += 1) {
    const row = parseMarkdownTableRow(lines[index]);
    if (!row || row.cells.length !== header.cells.length) break;
    rows.push(row);
  }
  return { rows, alignments: alignments as MarkdownTableAlignment[] };
}

export function renderMarkdownTables(
  markdown: string,
  renderInline: (source: string) => string,
) {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let inFence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) inFence = { marker: fence[1][0], length: fence[1].length };
      else if (fence[1][0] === inFence.marker && fence[1].length >= inFence.length) inFence = null;
      output.push(line);
      continue;
    }
    if (!inFence) {
      const table = parseMarkdownTableBlock(lines, index);
      if (table) {
        output.push(tableBlockToHtml(table, renderInline));
        index += table.rows.length - 1;
        continue;
      }
    }
    output.push(line);
  }
  return output.join("\n");
}

export function markdownPipeRowToTableHtml(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const row = parseMarkdownTableRow(text);
  if (!row || row.cells.every((cell) => !cell.source)) return null;
  if (row.cells.every((cell) => delimiterAlignment(cell.source) !== null)) return null;
  const firstRow = row.cells.map((cell) => `<td><p>${escapeTableCellHtml(cell.source)}</p></td>`).join("");
  const emptyRow = row.cells.map(() => "<td><p></p></td>").join("");
  return `<table><tbody><tr>${firstRow}</tr><tr>${emptyRow}</tr></tbody></table>`;
}

export function tableCellVisibleWidth(value: string) {
  return Array.from(value.replace(/\\\|/g, "|")).length;
}

export function escapeMarkdownTableCell(value: string) {
  let output = "";
  let codeDelimiter = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "`") {
      let run = 1;
      while (value[index + run] === "`") run += 1;
      output += "`".repeat(run);
      if (codeDelimiter === 0) codeDelimiter = run;
      else if (codeDelimiter === run) codeDelimiter = 0;
      index += run - 1;
      continue;
    }
    if (character === "|" && codeDelimiter === 0 && value[index - 1] !== "\\") output += "\\";
    output += character;
  }
  return output.replace(/\s+/g, " ").trim();
}

export function delimiterAlignment(cell: string): MarkdownTableAlignment | null {
  const compact = cell.replace(/\s/g, "");
  if (!/^:?-{3,}:?$/.test(compact)) return null;
  if (compact.startsWith(":") && compact.endsWith(":")) return "center";
  if (compact.startsWith(":")) return "left";
  if (compact.endsWith(":")) return "right";
  return "none";
}

function tableBlockToHtml(table: MarkdownTableBlock, renderInline: (source: string) => string) {
  const header = renderRow(table.rows[0], "th", table.alignments, renderInline);
  const body = table.rows.slice(2).map((row) => renderRow(row, "td", table.alignments, renderInline)).join("");
  return `<table><thead>${header}</thead><tbody>${body}</tbody></table>`;
}

function renderRow(
  row: MarkdownTableRow,
  tag: "th" | "td",
  alignments: MarkdownTableAlignment[],
  renderInline: (source: string) => string,
) {
  const cells = row.cells.map((cell, index) => {
    const alignment = alignments[index];
    const style = alignment && alignment !== "none" ? ` style="text-align: ${alignment}"` : "";
    return `<${tag}${style}>${renderInline(cell.source)}</${tag}>`;
  }).join("");
  return `<tr>${cells}</tr>`;
}

function hasUnescapedTrailingPipe(value: string) {
  if (!value.endsWith("|")) return false;
  let backslashes = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

function escapeTableCellHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
