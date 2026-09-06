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
    const {
      exposeHeadingMarkdown,
      exposeInlineMarkdown,
      exposeMarkdownAtCursor,
      headingPositionAt,
      markdownMarkRangeAt,
      reconcileExposedHeading,
      removeExposedMarkdownFormatting,
    } = await import(pathToFileURL(headingEditingPath).href);
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
    assert.equal(tr.doc.firstChild.type.name, "heading", "revealing source must keep heading rendering active");
    assert.equal(tr.doc.firstChild.textContent, "## Title");
    assert.equal(tr.selection.from, 4, "caret should sit immediately after the editable marker");
    assert.equal(tr.getMeta("lightmarkMarkdownPresentation"), true);
    assert.equal(tr.getMeta("addToHistory"), false, "source reveal must not create an undo step");

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
    assert.equal(inlineTr.doc.rangeHasMark(3, 7, bold), true, "formatted content must remain rendered while markers are visible");
    assert.equal(inlineTr.doc.rangeHasMark(1, 3, bold), false, "opening marker must remain unformatted");
    assert.equal(inlineTr.doc.rangeHasMark(7, 9, bold), false, "closing marker must remain unformatted");
    assert.equal(inlineTr.selection.from, 3);
    assert.equal(inlineTr.getMeta("lightmarkMarkdownPresentation"), true);
    assert.equal(inlineTr.getMeta("addToHistory"), false);
    const exposedBold = inlineTr.getMeta("lightmarkExposeMarkdown");
    const expandedBoldState = strongState.apply(inlineTr);
    const removeBoldTr = removeExposedMarkdownFormatting(expandedBoldState, exposedBold, "open");
    assert.ok(removeBoldTr);
    assert.equal(removeBoldTr.doc.textContent, "bold", "deleting either delimiter removes the complete delimiter pair");
    assert.equal(removeBoldTr.doc.rangeHasMark(1, 5, bold), false, "deleting a delimiter removes only its semantic format");

    const symmetricSchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
      },
      marks: {
        bold: {}, italic: {}, code: {}, strike: {}, highlight: {}, superscript: {}, subscript: {},
        link: { attrs: { href: { default: "https://example.test" } } },
      },
    });
    const syntaxCases = [
      ["bold", "**", "**"], ["italic", "*", "*"], ["code", "`", "`"],
      ["strike", "~~", "~~"], ["highlight", "==", "=="],
      ["superscript", "^", "^"], ["subscript", "~", "~"],
      ["link", "[", "](https://example.test)"],
    ];
    for (const [markName, open, close] of syntaxCases) {
      const markType = symmetricSchema.marks[markName];
      const syntaxState = EditorState.create({
        schema: symmetricSchema,
        doc: symmetricSchema.nodes.doc.create(null, [symmetricSchema.nodes.paragraph.create(null, symmetricSchema.text("text", [markType.create()]))]),
      });
      const syntaxTr = exposeInlineMarkdown(syntaxState, 1, 5, markType, open, close, "open");
      const syntaxExposure = syntaxTr.getMeta("lightmarkExposeMarkdown");
      const removed = removeExposedMarkdownFormatting(syntaxState.apply(syntaxTr), syntaxExposure, "close");
      assert.equal(removed.doc.textContent, "text", `${markName} must remove its complete delimiter pair`);
      assert.equal(removed.doc.rangeHasMark(1, 5, markType), false, `${markName} formatting must be removed`);
    }

    const italic = symmetricSchema.marks.italic;
    const nestedBold = symmetricSchema.marks.bold;
    const nestedState = EditorState.create({
      schema: symmetricSchema,
      doc: symmetricSchema.nodes.doc.create(null, [
        symmetricSchema.nodes.paragraph.create(null, symmetricSchema.text("nested", [nestedBold.create(), italic.create()])),
      ]),
    });
    const nestedExpose = exposeInlineMarkdown(nestedState, 1, 7, nestedBold, "**", "**", "open");
    const nestedRemove = removeExposedMarkdownFormatting(
      nestedState.apply(nestedExpose),
      nestedExpose.getMeta("lightmarkExposeMarkdown"),
      "open",
    );
    assert.equal(nestedRemove.doc.rangeHasMark(1, 7, nestedBold), false);
    assert.equal(nestedRemove.doc.rangeHasMark(1, 7, italic), true, "removing one nested delimiter must preserve the other mark");

    const removeHeadingTr = removeExposedMarkdownFormatting(state.apply(tr), tr.getMeta("lightmarkExposeMarkdown"), "open");
    assert.ok(removeHeadingTr);
    assert.equal(removeHeadingTr.doc.firstChild.type.name, "paragraph");
    assert.equal(removeHeadingTr.doc.firstChild.textContent, "Title", "deleting the heading marker keeps only its body");

    const arrowRightState = strongState.apply(
      strongState.tr.setSelection(TextSelection.create(strongState.doc, 2)),
    );
    const arrowRightTr = exposeMarkdownAtCursor(arrowRightState, "right");
    assert.ok(arrowRightTr, "ArrowRight into formatted text must expose its opening marker");
    assert.equal(arrowRightTr.doc.textContent, "**bold**");
    assert.equal(arrowRightTr.doc.rangeHasMark(3, 7, bold), true);
    assert.equal(arrowRightTr.selection.from, 4, "source reveal must preserve the caret's content offset");

    const arrowLeftState = strongState.apply(
      strongState.tr.setSelection(TextSelection.create(strongState.doc, 4)),
    );
    const arrowLeftTr = exposeMarkdownAtCursor(arrowLeftState, "left");
    assert.ok(arrowLeftTr, "ArrowLeft into formatted text must expose its closing marker");
    assert.equal(arrowLeftTr.doc.textContent, "**bold**");
    assert.equal(arrowLeftTr.doc.rangeHasMark(3, 7, bold), true);
    assert.equal(arrowLeftTr.selection.from, 6, "source reveal must preserve the caret's content offset");

    const boundaryRightState = strongState.apply(strongState.tr.setSelection(TextSelection.create(strongState.doc, 1)));
    const boundaryRightTr = exposeMarkdownAtCursor(boundaryRightState, "right");
    assert.ok(boundaryRightTr, "the first ArrowRight at the opening boundary must reveal syntax immediately");
    assert.equal(boundaryRightTr.selection.from, 3);

    const boundaryLeftState = strongState.apply(strongState.tr.setSelection(TextSelection.create(strongState.doc, 5)));
    const boundaryLeftTr = exposeMarkdownAtCursor(boundaryLeftState, "left");
    assert.ok(boundaryLeftTr, "the first ArrowLeft at the closing boundary must reveal syntax immediately");
    assert.equal(boundaryLeftTr.selection.from, 7);

    const headingCursorState = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3)),
    );
    const headingCursorTr = exposeMarkdownAtCursor(headingCursorState, "up");
    assert.ok(headingCursorTr, "vertical cursor movement into a heading must expose its marker");
    assert.equal(headingCursorTr.doc.firstChild.textContent, "## Title");
    assert.equal(headingCursorTr.selection.from, 6, "heading caret offset must survive keyboard exposure");

    const exposedHeading = tr.getMeta("lightmarkExposeMarkdown");
    const expandedHeadingState = state.apply(tr);
    let invalidInputTr = expandedHeadingState.tr.insertText("x", 1);
    invalidInputTr = invalidInputTr.setSelection(TextSelection.create(invalidInputTr.doc, 2));
    const invalidHeadingState = expandedHeadingState.apply(invalidInputTr);
    const demoteTr = reconcileExposedHeading(invalidHeadingState, exposedHeading);
    assert.ok(demoteTr);
    const demotedState = invalidHeadingState.apply(demoteTr);
    assert.equal(demotedState.doc.firstChild.type.name, "paragraph");
    assert.equal(demotedState.doc.firstChild.textContent, "x## Title");
    const invalidExposure = demoteTr.getMeta("lightmarkExposeMarkdown");
    let recoveredInputTr = demotedState.tr.delete(1, 2);
    recoveredInputTr = recoveredInputTr.setSelection(TextSelection.create(recoveredInputTr.doc, 1));
    const recoveredInputState = demotedState.apply(recoveredInputTr);
    const recoverTr = reconcileExposedHeading(recoveredInputState, invalidExposure);
    assert.ok(recoverTr, "removing the invalid prefix must immediately recover the heading");
    assert.equal(recoverTr.doc.firstChild.type.name, "heading");
    assert.equal(recoverTr.doc.firstChild.attrs.level, 2);
    assert.equal(recoverTr.doc.firstChild.textContent, "Title");
  } finally {
    fs.rmSync(headingEditingPath, { force: true });
  }
} finally {
  fs.rmSync(tempPath, { force: true });
}

console.log("input rule checks passed");
