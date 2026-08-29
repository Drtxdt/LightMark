import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";

const sourcePath = path.resolve("src/utils/inputRules.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const tempPath = path.resolve(`scripts/.lightmark-input-rules-${Date.now()}.mjs`);
fs.writeFileSync(tempPath, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText, "utf8");

try {
  const { codeBlockIndentEdits, decidePairAction, listContinuationForLine, isInsideFencedCode, isMarkdownTableLine } = await import(pathToFileURL(tempPath).href);

  assert.deepEqual(decidePairAction({ key: "(", after: "" }), { type: "insert", open: "(", close: ")" });
  assert.deepEqual(decidePairAction({ key: "[", selectedText: "text" }), { type: "wrap", open: "[", close: "]" });
  assert.deepEqual(decidePairAction({ key: ")", after: ")" }), { type: "skip" });
  assert.deepEqual(decidePairAction({ key: "Backspace", before: "{", after: "}" }), { type: "delete" });
  assert.equal(decidePairAction({ key: "'", before: "don" }), null);
  assert.equal(decidePairAction({ key: "`" }), null);
  assert.deepEqual(decidePairAction({ key: "`", selectedText: "code" }), { type: "wrap", open: "`", close: "`" });
  assert.equal(decidePairAction({ key: "(", composing: true }), null);

  assert.deepEqual(listContinuationForLine("- item"), { type: "continue", insert: "\n- " });
  assert.deepEqual(listContinuationForLine("  9. item"), { type: "continue", insert: "\n  10. " });
  assert.deepEqual(listContinuationForLine("3) item"), { type: "continue", insert: "\n4) " });
  assert.deepEqual(listContinuationForLine("- [x] done"), { type: "continue", insert: "\n- [ ] " });
  assert.deepEqual(listContinuationForLine("  * "), { type: "exit", markerLength: 4 });
  assert.equal(listContinuationForLine("plain text"), null);

  assert.equal(isMarkdownTableLine("| a | b |"), true);
  assert.equal(isMarkdownTableLine("not | a table"), false);
  assert.equal(isInsideFencedCode("before\n```ts\nconst x = 1", 25), true);
  assert.equal(isInsideFencedCode("```\ncode\n```\nafter", 20), false);
  assert.deepEqual(codeBlockIndentEdits("alpha\nbeta\ngamma", 1, 11, false), [
    { from: 0, to: 0, insert: "  " },
    { from: 6, to: 6, insert: "  " },
  ]);
  assert.deepEqual(codeBlockIndentEdits("  alpha\n beta\ngamma", 0, 14, true), [
    { from: 0, to: 2, insert: "" },
    { from: 8, to: 9, insert: "" },
  ]);

  const sourceEditor = fs.readFileSync(path.resolve("src/components/editor/SourceEditor.vue"), "utf8");
  const wysiwygEditor = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");
  assert.match(sourceEditor, /keymap\.of\(\[\.\.\.sourceInputKeymap,\s*\.\.\.historyKeymap\]\)/);
  assert.match(sourceEditor, /history\(\)/);
  assert.match(sourceEditor, /handleSourceListEnter/);
  assert.match(sourceEditor, /moveSourceTableCell/);
  assert.match(sourceEditor, /trailing\.startsWith\("\]\]"\)/);
  assert.match(wysiwygEditor, /handleWysiwygPair/);
  assert.match(wysiwygEditor, /handleWysiwygTab/);
  assert.match(wysiwygEditor, /indentWysiwygCodeSelection/);
  assert.doesNotMatch(wysiwygEditor, /insertText\("  ", selection\.from, selection\.to\)/);
  assert.match(wysiwygEditor, /sinkListItem/);
  assert.match(wysiwygEditor, /trailing\.startsWith\("\]\]"\)/);

  const headingEditingSource = fs.readFileSync(path.resolve("src/editor/wysiwygMarkdownEditing.ts"), "utf8");
  const headingEditingPath = path.resolve(`scripts/.lightmark-heading-editing-${Date.now()}.mjs`);
  fs.writeFileSync(headingEditingPath, ts.transpileModule(headingEditingSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText, "utf8");
  try {
    const { exposeHeadingMarkdown } = await import(pathToFileURL(headingEditingPath).href);
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "text*" },
        heading: { group: "block", content: "text*", attrs: { level: { default: 1 } } },
        text: { group: "inline" },
      },
    });
    const doc = schema.nodes.doc.create(null, [schema.nodes.heading.create({ level: 2 }, schema.text("Title"))]);
    const state = EditorState.create({ schema, doc });
    const tr = exposeHeadingMarkdown(state, 0, 1);
    assert.ok(tr);
    assert.equal(tr.doc.firstChild.type.name, "paragraph");
    assert.equal(tr.doc.firstChild.textContent, "## Title");
    assert.equal(tr.selection.from, 4, "caret should sit immediately after the editable marker");
  } finally {
    fs.rmSync(headingEditingPath, { force: true });
  }
} finally {
  fs.rmSync(tempPath, { force: true });
}

console.log("input rule checks passed");
