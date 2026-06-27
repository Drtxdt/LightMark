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
    "<table><tbody><tr><td><p>xxx</p></td><td><p>xxx</p></td></tr><tr><td><p></p></td><td><p></p></td></tr></tbody></table>",
  );
  assert.equal(markdownPipeRowToTableHtml("normal | text"), null);
  assert.equal(markdownPipeRowToTableHtml("| one | two | three |"), "<table><tbody><tr><td><p>one</p></td><td><p>two</p></td><td><p>three</p></td></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table>");

  console.log("table markdown checks passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
