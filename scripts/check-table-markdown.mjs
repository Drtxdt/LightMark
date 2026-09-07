import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

const sourcePath = path.resolve("src/utils/tableMarkdown.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const timestamp = Date.now();
const tempDir = path.resolve(`scripts/.lightmark-table-check-${timestamp}`);
fs.mkdirSync(tempDir, { recursive: true });
const tempPath = path.join(tempDir, `.lightmark-table-markdown-${timestamp}.mjs`);

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  },
}).outputText;

fs.writeFileSync(tempPath, compiled, "utf8");

try {
  const { markdownPipeRowToTableHtml } = await import(pathToFileURL(tempPath).href);

  assert.equal(
    markdownPipeRowToTableHtml("|xxx|xxx|"),
    "<table><thead><tr><th><p>xxx</p></th><th><p>xxx</p></th></tr></thead><tbody><tr><td><p></p></td><td><p></p></td></tr></tbody></table>",
  );
  assert.equal(markdownPipeRowToTableHtml("normal | text"), null);
  assert.equal(markdownPipeRowToTableHtml("| one | two | three |"), "<table><thead><tr><th><p>one</p></th><th><p>two</p></th><th><p>three</p></th></tr></thead><tbody><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table>");
  assert.equal(markdownPipeRowToTableHtml("| --- | --- |"), null, "a delimiter row is not a data-entry header");
  assert.equal(markdownPipeRowToTableHtml("| | |"), null, "an empty row is not a table insertion");
  assert.equal(
    markdownPipeRowToTableHtml("  | name | `a|b` |  "),
    "<table><thead><tr><th><p>name</p></th><th><p>`a|b`</p></th></tr></thead><tbody><tr><td><p></p></td><td><p></p></td></tr></tbody></table>",
  );
  assert.equal(
    markdownPipeRowToTableHtml("| <b> & \" | value |"),
    `<table><thead><tr><th><p>&lt;b&gt; &amp; &quot;</p></th><th><p>value</p></th></tr></thead><tbody><tr><td><p></p></td><td><p></p></td></tr></tbody></table>`,
  );

  console.log("table markdown checks passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
