import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

const sourcePath = path.resolve("src/utils/markdownFormat.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const tempPath = path.resolve(`scripts/.lightmark-markdown-format-${Date.now()}.mjs`);
fs.writeFileSync(tempPath, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText, "utf8");

try {
  const { formatMarkdown, mapMarkdownOffset } = await import(pathToFileURL(tempPath).href);

  const fixture = [
    "---",
    "aliases: [格式化, formatter]  ",
    "quoted: 'leave me'",
    "---",
    "",
    "- parent   ",
    "\t* [x] nested",
    "9) ordered",
    "",
    "| name| value | note |",
    "|:---|---:|:---:|",
    "| a\\|b | `x|y` | [[Wiki]] |",
    "",
    "```mermaid",
    "graph TD; A --> B   ",
    "```",
    "",
    "$$",
    "x  + y   ",
    "$$",
    "",
    "<div>",
    "  raw html   ",
    "</div>",
    "",
    "footnote[^1]  ",
    "",
    "[^1]: note   ",
    "",
    "",
    "",
  ].join("\n");
  const result = formatMarkdown(fixture);
  assert.equal(result.changed, true);
  assert.match(result.text, /\n  \* \[x\] nested\n9\) ordered/);
  assert.match(result.text, /\| a\\\|b\s+\| `x\|y`\s+\| \[\[Wiki\]\]\s+\|/);
  assert.match(result.text, /```mermaid\ngraph TD; A --> B   \n```/);
  assert.match(result.text, /\$\$\nx  \+ y   \n\$\$/);
  assert.match(result.text, /<div>\n  raw html   \n<\/div>/);
  assert.match(result.text, /aliases: \[格式化, formatter\]  /);
  assert.match(result.text, /footnote\[\^1\]  /);
  assert.doesNotMatch(result.text, /\n\n\n\n/);
  assert.deepEqual(formatMarkdown(result.text), { ...formatMarkdown(result.text), changed: false });

  const crlf = "# Heading  \r\n\r\n\r\n\r\nText \r\n";
  const crlfResult = formatMarkdown(crlf);
  assert.equal(crlfResult.text.includes("\r\n"), true);
  assert.equal(crlfResult.text.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(formatMarkdown("").text, "");
  assert.equal(formatMarkdown("plain\n").changed, false);
  assert.equal(formatMarkdown("---\ntitle: Test\n---\nBody").text, "---\ntitle: Test\n---\n\nBody");

  const mapped = formatMarkdown("one\n\n\n\nlast");
  assert.equal(mapMarkdownOffset("one\n\n\n\nlast", mapped, "one\n\n\n\nlast".indexOf("last")), mapped.text.indexOf("last"));

  const appStore = fs.readFileSync(path.resolve("src/stores/appStore.ts"), "utf8");
  const toolbar = fs.readFileSync(path.resolve("src/components/layout/Toolbar.vue"), "utf8");
  const palette = fs.readFileSync(path.resolve("src/components/command/CommandPalette.vue"), "utf8");
  const sourceEditor = fs.readFileSync(path.resolve("src/components/editor/SourceEditor.vue"), "utf8");
  const wysiwygEditor = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");
  assert.match(appStore, /formatCurrentMarkdown/);
  assert.match(appStore, /lightmark:apply-markdown-format/);
  assert.match(toolbar, /格式化当前 Markdown/);
  assert.match(palette, /格式化当前 Markdown/);
  assert.match(sourceEditor, /handleApplyMarkdownFormat/);
  assert.match(wysiwygEditor, /ProseMirrorDOMParser/);
} finally {
  fs.rmSync(tempPath, { force: true });
}

console.log("markdown format checks passed");
