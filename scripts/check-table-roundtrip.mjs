import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = path.resolve(`scripts/.lightmark-table-check-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
try {
  const tableModule = compileTypeScriptModuleGraph(path.resolve("src/utils/tableMarkdown.ts"), tempDir);
  const markdownModule = compileTypeScriptModuleGraph(path.resolve("src/utils/markdown.ts"), tempDir);
  const { escapeMarkdownTableCell, parseMarkdownTableRow, parseMarkdownTableBlock, renderMarkdownTables } = await import(pathToFileURL(tableModule).href);
  const { renderMarkdown, renderMarkdownForEditor } = await import(pathToFileURL(markdownModule).href);
  const row = String.raw`| a\|b | ` + "`x|y`" + ` | 42 |`;
  const source = `${row}\n| --- | --- | --- |\n| left | middle | right |`;
  const parsed = parseMarkdownTableRow(row);
  assert.deepEqual(parsed.cells.map((cell) => cell.source), [String.raw`a\|b`, "`x|y`", "42"]);
  assert.equal(parseMarkdownTableBlock(source.split("\n"), 0).rows.length, 3);
  assert.match(renderMarkdownTables(source, (value) => value), /<table>/);
  assert.equal(escapeMarkdownTableCell("a|b"), String.raw`a\|b`);
  assert.equal(escapeMarkdownTableCell("`x|y`"), "`x|y`");
  for (const html of [renderMarkdown(source), renderMarkdownForEditor(source)]) {
    assert.equal((html.match(/<tr/g) || []).length, 2, html);
    assert.equal((html.match(/<(?:th|td)(?:\s|>)/g) || []).length, 6);
    assert.match(html, /<code\b[^>]*>x\|y<\/code>/);
    assert.match(html, />42</);
  }
  console.log("table roundtrip checks passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
