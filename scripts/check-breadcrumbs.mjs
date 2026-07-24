import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

const sourcePath = path.resolve("src/utils/outline.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const tempPath = path.resolve(`scripts/.lightmark-breadcrumbs-${Date.now()}.mjs`);
fs.writeFileSync(tempPath, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText, "utf8");

try {
  const { extractOutlineWithLines, resolveHeadingBreadcrumb } = await import(pathToFileURL(tempPath).href);
  const markdown = [
    "---",
    "title: Test",
    "# not a heading",
    "---",
    "# Chapter",
    "intro",
    "### Skipped level",
    "body",
    "```md",
    "## fenced",
    "```",
    "$$",
    "# math",
    "$$",
    "<div>",
    "## html",
    "</div>",
    "## Sibling",
    "text",
    "#### Deep",
    "text",
    "# Chapter",
    "tail",
  ].join("\n");
  const outline = extractOutlineWithLines(markdown);

  assert.deepEqual(outline.map(({ text, level, line }) => ({ text, level, line })), [
    { text: "Chapter", level: 1, line: 4 },
    { text: "Skipped level", level: 3, line: 6 },
    { text: "Sibling", level: 2, line: 17 },
    { text: "Deep", level: 4, line: 19 },
    { text: "Chapter", level: 1, line: 21 },
  ]);
  assert.deepEqual(resolveHeadingBreadcrumb(outline, 3), []);
  assert.deepEqual(resolveHeadingBreadcrumb(outline, 4).map((item) => item.text), ["Chapter"]);
  assert.deepEqual(resolveHeadingBreadcrumb(outline, 8).map((item) => item.text), ["Chapter", "Skipped level"]);
  assert.deepEqual(resolveHeadingBreadcrumb(outline, 18).map((item) => item.text), ["Chapter", "Sibling"]);
  assert.deepEqual(resolveHeadingBreadcrumb(outline, 20).map((item) => item.text), ["Chapter", "Sibling", "Deep"]);
  assert.deepEqual(resolveHeadingBreadcrumb(outline, 22).map((item) => item.text), ["Chapter"]);
  assert.notEqual(outline[0].id, outline[4].id);

  const statusBar = fs.readFileSync(path.resolve("src/components/layout/StatusBar.vue"), "utf8");
  const largeEditor = fs.readFileSync(path.resolve("src/components/editor/LargeMarkdownEditor.vue"), "utf8");
  const editorShell = fs.readFileSync(path.resolve("src/components/editor/EditorShell.vue"), "utf8");
  const appStore = fs.readFileSync(path.resolve("src/stores/appStore.ts"), "utf8");
  assert.match(statusBar, /resolveHeadingBreadcrumb/);
  assert.match(statusBar, /recordNavigationLocation/);
  assert.match(statusBar, /aria-label="当前章节路径"/);
  assert.match(statusBar, /lightmark:jump-heading/);
  assert.match(largeEditor, /updateLargeFileViewportLine/);
  assert.match(editorShell, /:pane-id="paneId"/);
  assert.match(appStore, /paneContextLines\[paneId\]/);
} finally {
  fs.rmSync(tempPath, { force: true });
}

console.log("breadcrumb checks passed");
