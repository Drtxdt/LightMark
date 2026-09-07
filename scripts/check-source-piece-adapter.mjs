import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { EditorState } from "@tiptap/pm/state";
import { history, redo, undo } from "@tiptap/pm/history";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-source-piece-adapter-"));

try {
  const compiled = compileTypeScriptModuleGraph(path.resolve("src/editor/sourcePieceAdapter.ts"), tempDir);
  const adapter = await import(pathToFileURL(compiled).href);
  const pieceEngine = await import(pathToFileURL(path.join(tempDir, "editor/sourcePieceState.mjs")).href);
  const schema = getSchema([
    StarterKit.configure({
      blockquote: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      link: false,
      strike: false,
      history: false,
    }),
    Table,
    TableRow,
    TableCell,
    TableHeader,
  ]);

  const paragraph = (text = "") => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
  const bulletList = (text) => schema.nodes.bulletList.create(null, schema.nodes.listItem.create(null, paragraph(text)));
  const orderedList = (text) => schema.nodes.orderedList.create({ order: 3 }, schema.nodes.listItem.create(null, paragraph(text)));
  const table = (headerLeft, headerRight, bodyLeft, bodyRight) => schema.nodes.table.create(null, [
    schema.nodes.tableRow.create(null, [
      schema.nodes.tableHeader.create(null, paragraph(headerLeft)),
      schema.nodes.tableHeader.create(null, paragraph(headerRight)),
    ]),
    schema.nodes.tableRow.create(null, [
      schema.nodes.tableCell.create(null, paragraph(bodyLeft)),
      schema.nodes.tableCell.create(null, paragraph(bodyRight)),
    ]),
  ]);
  const doc = (...nodes) => schema.nodes.doc.create(null, nodes);
  const stateFor = (document, withHistory = false) => EditorState.create({
    schema,
    doc: document,
    plugins: withHistory ? [history()] : [],
  });
  const sourceOf = (state) => adapter.materializeSourcePieceAdapter(state).source;
  const errorCode = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof adapter.SourcePieceAdapterError, error);
      return error.code;
    }
    assert.fail("expected a typed source piece adapter failure");
  };
  const apply = (adapterState, editorState, transaction) => {
    const nextAdapter = adapter.applySourcePieceAdapterTransaction(adapterState, transaction);
    const nextEditor = editorState.apply(transaction);
    assert.equal(nextAdapter.doc, nextEditor.doc);
    return { adapterState: nextAdapter, editorState: nextEditor };
  };

  // A baseline is parsed once. Consecutive transactions use the current piece
  // coordinates and remain provisional until the explicit checkpoint.
  {
    const source = "abc\n\nxyz";
    let editorState = stateFor(doc(paragraph("abc"), paragraph("xyz")));
    let pieceState = adapter.createSourcePieceAdapter(source, editorState.doc, "adapter-plain");
    const firstLeaf = adapter.getSourcePieceAdapterLeaf(pieceState, 0);
    const secondLeaf = adapter.getSourcePieceAdapterLeaf(pieceState, 1);
    const firstRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    const secondRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 1);
    assert.ok(firstLeaf && secondLeaf && firstRange && secondRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("d", firstRange.to)));
    const currentFirst = adapter.getSourcePieceAdapterLeaf(pieceState, 0);
    const currentSecondRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 1);
    assert.ok(currentFirst && currentSecondRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("e", currentSecondRange.to)));
    assert.equal(sourceOf(pieceState), "abcd\n\nxyze");
    assert.equal(pieceState.validation.status, "provisional");
    assert.equal(pieceState.validation.validatedRevision, 0);
    const checkpoint = adapter.checkpointSourcePieceAdapter(pieceState);
    pieceState = checkpoint.state;
    assert.equal(checkpoint.materialization.source, "abcd\n\nxyze");
    assert.equal(pieceState.validation.status, "validated");
    assert.equal(pieceState.validation.validatedRevision, pieceState.source.revision);
    assert.equal(adapter.getSourcePieceAdapterLeaf(pieceState, 1)?.text, "xyze");
    assert.equal(secondLeaf.text, "xyz");
  }

  // Prefix whitespace belongs to the first block even without a BOM; no-op
  // materialization must cover every original code unit.
  for (const source of ["\n\nabc", "\r\n\r\nabc", "\uFEFF\n\nabc", "  \n\nabc"]) {
    const editorState = stateFor(doc(paragraph("abc")));
    const pieceState = adapter.createSourcePieceAdapter(source, editorState.doc, `adapter-prefix-${source.length}`);
    assert.equal(sourceOf(pieceState), source);
  }
  assert.throws(() => adapter.createSourcePieceAdapter("\n\r\n", stateFor(doc()).doc, "adapter-whitespace"));

  // Two adjacent top-level blocks in one PM transaction map to one atomic
  // piece batch; the untouched separators remain byte-for-byte unchanged.
  {
    const source = "left\r\n\r\nright\n";
    let editorState = stateFor(doc(paragraph("left"), paragraph("right")));
    let pieceState = adapter.createSourcePieceAdapter(source, editorState.doc, "adapter-multi");
    const left = adapter.getSourcePieceAdapterLeaf(pieceState, 0);
    const right = adapter.getSourcePieceAdapterLeaf(pieceState, 1);
    const leftRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    const rightRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 1);
    assert.ok(left && right && leftRange && rightRange);
    let transaction = editorState.tr.insertText("!", rightRange.to);
    transaction = transaction.insertText("?", leftRange.to);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, transaction));
    assert.equal(sourceOf(pieceState), "left?\r\n\r\nright!\n");
    assert.equal(pieceState.source.operationCost.blocksTouched, 2);
  }

  // BOM, mixed line endings and an astral character stay in the piece source;
  // PM and raw coordinates remain UTF-16 code-unit offsets.
  {
    const source = "\uFEFFA😀\r\n\r\nB\n";
    let editorState = stateFor(doc(paragraph("A😀"), paragraph("B")));
    let pieceState = adapter.createSourcePieceAdapter(source, editorState.doc, "adapter-utf16");
    const firstRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    assert.ok(firstRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("中", firstRange.to)));
    assert.equal(sourceOf(pieceState), "\uFEFFA😀中\r\n\r\nB\n");
  }

  // Ordered marker content is taken from the parser-backed leaf, not the first
  // matching source substring.
  {
    const source = "3. 3";
    let editorState = stateFor(doc(orderedList("3")));
    let pieceState = adapter.createSourcePieceAdapter(source, editorState.doc, "adapter-list");
    const leaf = adapter.getSourcePieceAdapterLeaf(pieceState, 0);
    const leafRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    assert.ok(leaf && leafRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("x", leafRange.to)));
    assert.equal(sourceOf(pieceState), "3. 3x");
    const currentRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    assert.ok(currentRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText(
      "- x",
      currentRange.from,
      currentRange.to,
    )));
    assert.equal(sourceOf(pieceState), "3. - x");
    const syntaxCheckpoint = adapter.tryCheckpointSourcePieceAdapter(pieceState);
    assert.equal(syntaxCheckpoint.ok, false);
    assert.equal(syntaxCheckpoint.error.code, "checkpoint-validation-failed");
  }

  // Table metadata stays local to the body cell; header padding and delimiter
  // bytes are not reconstructed by a serializer.
  {
    const source = "|  a  | b |\n| --- | --- |\n| x | y |";
    let editorState = stateFor(doc(table("a", "b", "x", "y")));
    let pieceState = adapter.createSourcePieceAdapter(source, editorState.doc, "adapter-table");
    const body = [0, 1, 2, 3].map((index) => adapter.getSourcePieceAdapterLeaf(pieceState, index));
    const bodyRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 2);
    const otherBodyRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 3);
    assert.ok(body[2] && body[3] && bodyRange && otherBodyRange);
    let transaction = editorState.tr.insertText("!", otherBodyRange.to);
    transaction = transaction.insertText("z", bodyRange.to);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, transaction));
    assert.equal(sourceOf(pieceState), "|  a  | b |\n| --- | --- |\n| xz | y! |");
    const laterBodyRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 3);
    assert.ok(laterBodyRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("?", laterBodyRange.to)));
    assert.equal(sourceOf(pieceState), "|  a  | b |\n| --- | --- |\n| xz | y!? |");
    ({ state: pieceState } = adapter.checkpointSourcePieceAdapter(pieceState));
    assert.equal(pieceState.validation.validatedRevision, pieceState.source.revision);
    const postCheckpointRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 2);
    assert.ok(postCheckpointRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("q", postCheckpointRange.to)));
    assert.equal(sourceOf(pieceState), "|  a  | b |\n| --- | --- |\n| xzq | y!? |");
  }

  // Empty slot insertion and delete -> validated checkpoint -> reinsert use
  // the parser's unique cell slot and retain its padding.
  {
    const emptySource = "| a | b |\n| --- | --- |\n|  | y |";
    let editorState = stateFor(doc(table("a", "b", "", "y")));
    let pieceState = adapter.createSourcePieceAdapter(emptySource, editorState.doc, "adapter-empty");
    const empty = adapter.getSourcePieceAdapterLeaf(pieceState, 2);
    const emptyRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 2);
    assert.ok(empty?.emptySlot && emptyRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("x", emptyRange.from)));
    assert.equal(sourceOf(pieceState), "| a | b |\n| --- | --- |\n| x | y |");

    const filledSource = "| a | b |\n| --- | --- |\n| x | y |";
    editorState = stateFor(doc(table("a", "b", "x", "y")));
    pieceState = adapter.createSourcePieceAdapter(filledSource, editorState.doc, "adapter-empty-rebuild");
    const x = adapter.getSourcePieceAdapterLeaf(pieceState, 2);
    const xRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 2);
    assert.ok(x && xRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.delete(xRange.from, xRange.to)));
    assert.equal(sourceOf(pieceState), "| a | b |\n| --- | --- |\n|  | y |");
    const collapsedRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 2);
    assert.ok(collapsedRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("z", collapsedRange.from)));
    assert.equal(sourceOf(pieceState), "| a | b |\n| --- | --- |\n| z | y |");

    // Rebuild a fresh baseline after deletion so the parser can prove the
    // newly empty slot and retain its padding on the next insertion.
    editorState = stateFor(doc(table("a", "b", "x", "y")));
    pieceState = adapter.createSourcePieceAdapter(filledSource, editorState.doc, "adapter-empty-rebuild");
    const rebuiltX = adapter.getSourcePieceAdapterLeaf(pieceState, 2);
    const rebuiltXRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 2);
    assert.ok(rebuiltX && rebuiltXRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.delete(rebuiltXRange.from, rebuiltXRange.to)));
    assert.equal(sourceOf(pieceState), "| a | b |\n| --- | --- |\n|  | y |");
    ({ state: pieceState } = adapter.checkpointSourcePieceAdapter(pieceState));
    const rebuiltEmpty = adapter.getSourcePieceAdapterLeaf(pieceState, 2);
    const rebuiltEmptyRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 2);
    assert.ok(rebuiltEmpty?.emptySlot && rebuiltEmptyRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("z", rebuiltEmptyRange.from)));
    assert.equal(sourceOf(pieceState), "| a | b |\n| --- | --- |\n| z | y |");
  }

  // Real PM history undo/redo transactions are ordinary adapter inputs; the
  // piece transition event is therefore replayable at each current revision.
  {
    let editorState = stateFor(doc(paragraph("abc")), true);
    let pieceState = adapter.createSourcePieceAdapter("abc", editorState.doc, "adapter-history");
    const leaf = adapter.getSourcePieceAdapterLeaf(pieceState, 0);
    const leafRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    assert.ok(leaf && leafRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("d", leafRange.to)));
    assert.equal(sourceOf(pieceState), "abcd");
    const editRevision = pieceState.source.revision;
    let undoTransaction = null;
    assert.equal(undo(editorState, (transaction) => { undoTransaction = transaction; }), true);
    assert.ok(undoTransaction);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, undoTransaction));
    assert.equal(sourceOf(pieceState), "abc");
    assert.equal(pieceState.source.revision, editRevision + 1);
    assert.equal(pieceState.source.transition.kind, "apply");
    assert.equal(pieceState.source.transition.delta.beforeRevision, pieceState.source.revision - 1);
    let redoTransaction = null;
    assert.equal(redo(editorState, (transaction) => { redoTransaction = transaction; }), true);
    assert.ok(redoTransaction);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, redoTransaction));
    assert.equal(sourceOf(pieceState), "abcd");
    assert.equal(pieceState.source.transition.delta.beforeRevision, pieceState.source.revision - 1);
  }

  // A syntax-sensitive candidate is provisional on input; checkpoint parser
  // validation rejects it without replacing the prior validated baseline.
  {
    let editorState = stateFor(doc(paragraph("abc")));
    let pieceState = adapter.createSourcePieceAdapter("abc", editorState.doc, "adapter-failure");
    const leaf = adapter.getSourcePieceAdapterLeaf(pieceState, 0);
    const leafRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    assert.ok(leaf && leafRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText("d", leafRange.to)));
    const currentLeaf = adapter.getSourcePieceAdapterLeaf(pieceState, 0);
    const currentRange = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    assert.ok(currentLeaf && currentRange);
    ({ adapterState: pieceState, editorState } = apply(pieceState, editorState, editorState.tr.insertText(
      "&amp;",
      currentRange.from,
      currentRange.to,
    )));
    assert.equal(sourceOf(pieceState), "&amp;");
    const failedCheckpoint = adapter.tryCheckpointSourcePieceAdapter(pieceState);
    assert.equal(failedCheckpoint.ok, false);
    assert.equal(failedCheckpoint.error.code, "checkpoint-validation-failed");
    assert.equal(pieceState.baseline.rawSource, "abc");
    assert.equal(pieceState.validation.status, "provisional");
  }

  // Checkpoint validation is also atomic if a dirty piece is corrupted by an
  // external caller: the old validated baseline and current good adapter stay
  // available instead of being replaced by an unverified source.
  {
    let editorState = stateFor(doc(paragraph("abcd")));
    const pieceState = adapter.createSourcePieceAdapter("abcd", editorState.doc, "adapter-checkpoint-failure");
    const divergentSource = pieceEngine.applySourcePiecePatchBatch(pieceState.source, {
      documentId: pieceState.documentId,
      beforeRevision: pieceState.source.revision,
      patches: [{ blockId: "source-block:0", pieceFrom: 0, pieceTo: 4, expected: "abcd", insert: "&amp;" }],
    });
    const corrupted = Object.freeze({ ...pieceState, source: divergentSource });
    const checkpointResult = adapter.tryCheckpointSourcePieceAdapter(corrupted);
    assert.equal(checkpointResult.ok, false);
    assert.equal(checkpointResult.error.code, "checkpoint-validation-failed");
    assert.equal(pieceState.baseline.rawSource, "abcd");
    assert.equal(sourceOf(pieceState), "abcd");
    assert.equal(pieceState.validation.status, "validated");
  }

  // A structure change is typed unsupported and cannot silently fall back to
  // full-document Turndown.
  {
    let editorState = stateFor(doc(paragraph("abc")));
    const pieceState = adapter.createSourcePieceAdapter("abc", editorState.doc, "adapter-structure");
    const transaction = editorState.tr.split(2);
    assert.equal(errorCode(() => adapter.applySourcePieceAdapterTransaction(pieceState, transaction)), "structure-changed");
    assert.equal(sourceOf(pieceState), "abc");
  }

  // Mark changes have a local leaf span but are outside the exact plain-text
  // slice; they fail before changing the piece state.
  {
    const editorState = stateFor(doc(paragraph("abc")));
    const pieceState = adapter.createSourcePieceAdapter("abc", editorState.doc, "adapter-marks");
    const range = adapter.getSourcePieceAdapterLeafRange(pieceState, 0);
    assert.ok(range);
    const transaction = editorState.tr.addMark(range.from, range.to, schema.marks.bold.create());
    assert.equal(errorCode(() => adapter.applySourcePieceAdapterTransaction(pieceState, transaction)), "marks-changed");
    assert.equal(sourceOf(pieceState), "abc");
  }

  console.log(JSON.stringify({
    cases: "baseline/continuous/multiblock/list/table/empty/history/failure/structure",
    sourcePieceAdapter: "passed",
  }));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
