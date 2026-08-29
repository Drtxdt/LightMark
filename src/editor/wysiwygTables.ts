export type TableAlignment = "left" | "center" | "right";

export function normalizeTableAlign(value: unknown): TableAlignment | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "left" || normalized === "center" || normalized === "right" ? normalized : null;
}

export function parseTableCellAlign(element: HTMLElement) {
  return normalizeTableAlign(element.style.textAlign || element.getAttribute("align") || "");
}

export function renderTableCellAlign(attributes: Record<string, unknown>) {
  const textAlign = normalizeTableAlign(attributes.textAlign);
  return textAlign ? { style: `text-align: ${textAlign};` } : {};
}

export function resizedTableElement(source: HTMLTableElement, targetRows: number, targetColumns: number) {
  const table = source.cloneNode(true) as HTMLTableElement;
  while (table.rows.length > targetRows) table.deleteRow(table.rows.length - 1);
  while (table.rows.length < targetRows) {
    const row = table.insertRow();
    const useHeader = table.rows.length === 1 && source.rows[0]?.cells[0]?.tagName.toLowerCase() === "th";
    for (let column = 0; column < targetColumns; column += 1) {
      const cell = document.createElement(useHeader ? "th" : "td");
      cell.innerHTML = "";
      row.appendChild(cell);
    }
  }
  Array.from(table.rows).forEach((row) => {
    while (row.cells.length > targetColumns) row.deleteCell(row.cells.length - 1);
    while (row.cells.length < targetColumns) {
      const template = row.cells[row.cells.length - 1] || source.rows[0]?.cells[row.cells.length] || source.rows[0]?.cells[0];
      const cell = document.createElement(row.rowIndex === 0 && template?.tagName.toLowerCase() === "th" ? "th" : "td");
      const align = template ? parseTableCellAlign(template as HTMLElement) : null;
      if (align) {
        cell.style.textAlign = align;
        cell.setAttribute("align", align);
      }
      cell.innerHTML = "";
      row.appendChild(cell);
    }
  });
  return table;
}

export function tableResizeWouldDropContent(table: HTMLTableElement, targetRows: number, targetColumns: number) {
  const rows = Array.from(table.rows);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (rowIndex >= targetRows && Array.from(row.cells).some(cellHasContent)) return true;
    for (let columnIndex = targetColumns; columnIndex < row.cells.length; columnIndex += 1) {
      if (cellHasContent(row.cells[columnIndex])) return true;
    }
  }
  return false;
}

export function formatMarkdownTable(table: HTMLTableElement, serializeCell: (cell: HTMLTableCellElement) => string) {
  const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map(serializeCell));
  if (rows.length === 0) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, columns - row.length)).fill("")]);
  const alignments = tableColumnAlignments(table, columns);
  const widths = Array.from({ length: columns }, (_item, index) => Math.max(3, ...normalized.map((row) => row[index]?.length || 0)));
  const renderRow = (row: string[]) => `| ${row.map((cell, index) => cell.padEnd(widths[index], " ")).join(" | ")} |`;
  const divider = widths.map((width, index) => markdownTableDividerForAlign(alignments[index], width));
  return [renderRow(normalized[0]), renderRow(divider), ...normalized.slice(1).map(renderRow)].join("\n");
}

export function tableColumnAlignments(table: HTMLTableElement, columnCount: number) {
  return Array.from({ length: columnCount }, (_item, columnIndex) => {
    for (const row of Array.from(table.rows)) {
      const cell = row.cells[columnIndex];
      const align = cell ? parseTableCellAlign(cell) : null;
      if (align) return align;
    }
    return null;
  });
}

export function markdownTableDividerForAlign(align: TableAlignment | null, width = 3) {
  const dashes = "-".repeat(Math.max(3, width));
  if (align === "left") return `:${dashes}`;
  if (align === "center") return `:${dashes}:`;
  if (align === "right") return `${dashes}:`;
  return dashes;
}

function cellHasContent(cell: HTMLTableCellElement) {
  return Boolean(cell.textContent?.trim() || cell.querySelector("img,video,iframe,math,.math-node,.typora-image-node"));
}
