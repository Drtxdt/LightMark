import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

const sourcePath = path.resolve("src/utils/inputRules.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const tempPath = path.resolve(`scripts/.lightmark-markdown-shortcuts-${Date.now()}.mjs`);
fs.writeFileSync(tempPath, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText, "utf8");

try {
  const { detectMarkdownShortcut } = await import(pathToFileURL(tempPath).href);
  const enter = (text, options = {}) => detectMarkdownShortcut({ text, trigger: "enter", ...options });
  const typed = (text, insertedText, options = {}) =>
    detectMarkdownShortcut({ text, insertedText, trigger: "text", ...options });

  assert.deepEqual(enter("---"), { kind: "horizontal-rule", marker: "-" });
  assert.deepEqual(enter("***"), { kind: "horizontal-rule", marker: "*" });
  assert.deepEqual(enter("___"), { kind: "horizontal-rule", marker: "_" });
  assert.equal(enter("---", { atDocumentStart: true }), null);
  assert.equal(enter("--"), null);

  assert.deepEqual(enter("| 标题 | 数值 |"), { kind: "table", headers: ["标题", "数值"] });
  assert.deepEqual(enter("| `a|b` | c\\|d |"), { kind: "table", headers: ["`a|b`", "c\\|d"] });
  assert.equal(enter("| only |"), null);
  assert.equal(enter("| a |  |"), null);
  assert.equal(enter("| a | b"), null);
  assert.equal(enter("| --- | --- |"), null);

  assert.deepEqual(enter("> 引用"), { kind: "blockquote", depth: 1, text: "引用" });
  assert.deepEqual(enter(">> 嵌套"), { kind: "blockquote", depth: 2, text: "嵌套" });
  assert.equal(enter("1 > 0"), null);

  assert.deepEqual(enter("> [!warning] 内容"), { kind: "alert", alert: "warning", text: "内容" });
  assert.deepEqual(enter("[!TIP]", { insideBlockquote: true }), { kind: "alert", alert: "tip", text: "" });
  assert.deepEqual(enter("> [!UNKNOWN]"), { kind: "blockquote", depth: 1, text: "[!UNKNOWN]" });

  assert.deepEqual(typed("[ ]", " ", { insideListItem: true }), { kind: "task", checked: false, marker: "-" });
  assert.deepEqual(typed("[x]", " ", { insideListItem: true }), { kind: "task", checked: true, marker: "-" });
  assert.deepEqual(typed("1. [X]", " "), { kind: "task", checked: true, marker: "1." });
  assert.equal(typed("[ ]", " "), null);

  assert.deepEqual(typed("正文[^注释", "]"), {
    kind: "footnote-reference",
    id: "注释",
    from: 2,
    to: 7,
  });
  assert.equal(typed("[^definition", "]"), null);
  assert.equal(typed("正文\\[^literal", "]"), null);
  assert.deepEqual(enter("[^注释]: 脚注内容"), { kind: "footnote-definition", id: "注释", text: "脚注内容" });
  assert.deepEqual(enter("[^note]:"), { kind: "footnote-definition", id: "note", text: "" });

  assert.equal(enter("---", { protectedContext: true }), null);
  assert.equal(typed("正文[^注释", "]", { composing: true }), null);

  const wysiwyg = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");
  const sourceEditor = fs.readFileSync(path.resolve("src/components/editor/SourceEditor.vue"), "utf8");
  const largeEditor = fs.readFileSync(path.resolve("src/components/editor/LargeMarkdownEditor.vue"), "utf8");
  const tableSource = fs.readFileSync(path.resolve("src/utils/tableMarkdown.ts"), "utf8");
  assert.match(wysiwyg, /handleWysiwygMarkdownShortcutEnter/);
  assert.match(wysiwyg, /handleWysiwygMarkdownShortcutText/);
  assert.match(wysiwyg, /convertFootnoteDefinitionShortcut/);
  assert.match(wysiwyg, /FootnoteMetadataSync/);
  assert.match(wysiwyg, /footnotes-editor/);
  assert.match(tableSource, /<thead><tr>\$\{firstRow\}<\/tr><\/thead>/);
  assert.doesNotMatch(sourceEditor, /detectMarkdownShortcut/);
  assert.doesNotMatch(largeEditor, /detectMarkdownShortcut/);
} finally {
  fs.rmSync(tempPath, { force: true });
}

console.log("Markdown shortcut checks passed.");
