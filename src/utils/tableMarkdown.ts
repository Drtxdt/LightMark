function escapeTableCellHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function markdownPipeRowToTableHtml(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) return null;

  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());

  if (cells.length < 2) return null;
  if (cells.every((cell) => cell.length === 0)) return null;

  const firstRow = cells.map((cell) => `<td><p>${escapeTableCellHtml(cell)}</p></td>`).join("");
  const emptyRow = cells.map(() => "<td><p></p></td>").join("");
  return `<table><tbody><tr>${firstRow}</tr><tr>${emptyRow}</tr></tbody></table>`;
}
