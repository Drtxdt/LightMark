import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";

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
    const { exposeHeadingMarkdown, exposeInlineMarkdown, exposeMarkdownAtCursor, headingPositionAt, markdownMarkRangeAt } = await import(pathToFileURL(headingEditingPath).href);
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
    assert.equal(headingPositionAt(state, 1), 0, "DOM positions inside headings must resolve to the block start");
    const tr = exposeHeadingMarkdown(state, headingPositionAt(state, 1), 1);
    assert.ok(tr);
    assert.equal(tr.doc.firstChild.type.name, "paragraph");
    assert.equal(tr.doc.firstChild.textContent, "## Title");
    assert.equal(tr.selection.from, 4, "caret should sit immediately after the editable marker");

    const strongSchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
      },
      marks: { bold: {} },
    });
    const bold = strongSchema.marks.bold;
    const strongState = EditorState.create({
      schema: strongSchema,
      doc: strongSchema.nodes.doc.create(null, [strongSchema.nodes.paragraph.create(null, strongSchema.text("bold", [bold.create()]))]),
    });
    const boldRange = markdownMarkRangeAt(strongState, 2, "bold");
    assert.deepEqual([boldRange.from, boldRange.to], [1, 5]);
    const inlineTr = exposeInlineMarkdown(strongState, boldRange.from, boldRange.to, bold, "**", "**", "open");
    assert.ok(inlineTr);
    assert.equal(inlineTr.doc.textContent, "**bold**");
    assert.equal(inlineTr.doc.rangeHasMark(1, 9, bold), false);
    assert.equal(inlineTr.selection.from, 3);

    const arrowRightState = strongState.apply(
      strongState.tr.setSelection(TextSelection.create(strongState.doc, 2)),
    );
    const arrowRightTr = exposeMarkdownAtCursor(arrowRightState, "right");
    assert.ok(arrowRightTr, "ArrowRight into formatted text must expose its opening marker");
    assert.equal(arrowRightTr.doc.textContent, "**bold**");
    assert.equal(arrowRightTr.selection.from, 3);

    const arrowLeftState = strongState.apply(
      strongState.tr.setSelection(TextSelection.create(strongState.doc, 4)),
    );
    const arrowLeftTr = exposeMarkdownAtCursor(arrowLeftState, "left");
    assert.ok(arrowLeftTr, "ArrowLeft into formatted text must expose its closing marker");
    assert.equal(arrowLeftTr.doc.textContent, "**bold**");
    assert.equal(arrowLeftTr.selection.from, 7);

    const headingCursorState = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3)),
    );
    const headingCursorTr = exposeMarkdownAtCursor(headingCursorState, "up");
    assert.ok(headingCursorTr, "vertical cursor movement into a heading must expose its marker");
    assert.equal(headingCursorTr.doc.firstChild.textContent, "## Title");
    assert.equal(headingCursorTr.selection.from, 6, "heading caret offset must survive keyboard exposure");
  } finally {
    fs.rmSync(headingEditingPath, { force: true });
  }
} finally {
  fs.rmSync(tempPath, { force: true });
}

console.log("input rule checks passed");
