import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { CellSelection } from "@tiptap/pm/tables";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-recovery-"));

try {
  const codecPath = compileTypeScriptModuleGraph(path.resolve("src/editor/recoveryCodec.ts"), tempDir);
  const mathPath = compileTypeScriptModuleGraph(path.resolve("src/extensions/MathNodes.ts"), tempDir);
  const codec = await import(pathToFileURL(codecPath).href);
  const { InlineMath, BlockMath } = await import(pathToFileURL(mathPath).href);

  const schema = getSchema([
    StarterKit.configure({
      blockquote: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      link: false,
      strike: false,
    }),
    Table,
    TableRow,
    TableCell,
    TableHeader,
    InlineMath,
    BlockMath,
  ]);

  const paragraph = (text = "") => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
  const table = schema.nodes.table.create(null, [
    schema.nodes.tableRow.create(null, [
      schema.nodes.tableHeader.create(null, paragraph("a")),
      schema.nodes.tableHeader.create(null, paragraph("b")),
    ]),
    schema.nodes.tableRow.create(null, [
      schema.nodes.tableCell.create(null, paragraph("x")),
      schema.nodes.tableCell.create(null, paragraph("y")),
    ]),
  ]);
  const inlineMath = schema.nodes.inlineMath.create({
    tex: "x+y",
    delimiter: "inline-dollar",
    raw: "$x+y$",
    originalTex: "x+y",
    displayMode: false,
    editing: true,
  });
  const blockMath = schema.nodes.blockMath.create({
    tex: "z",
    delimiter: "display-dollar",
    raw: "$$\nz\n$$",
    originalTex: "z",
    displayMode: true,
    editing: false,
  });
  const document = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [schema.text("前😀 "), inlineMath, schema.text(" 后")]),
    blockMath,
    table,
  ]);

  const positions = {};
  document.descendants((node, position) => {
    if (node.type.name === "inlineMath" && positions.inlineMath === undefined) positions.inlineMath = position;
    if (node.type.name === "blockMath" && positions.blockMath === undefined) positions.blockMath = position;
    if ((node.type.name === "tableHeader" || node.type.name === "tableCell") && positions.firstCell === undefined) positions.firstCell = position;
    if (node.type.name === "tableCell" && positions.secondCell === undefined) positions.secondCell = position;
  });
  assert.equal(typeof positions.inlineMath, "number");
  assert.equal(typeof positions.blockMath, "number");
  assert.equal(typeof positions.firstCell, "number");
  assert.equal(typeof positions.secondCell, "number");

  const changedInlineMath = schema.nodes.inlineMath.create({
    tex: "incoming",
    delimiter: "inline-dollar",
    raw: "$incoming$",
    originalTex: "incoming",
    displayMode: false,
    editing: false,
  });
  const changedDocument = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [schema.text("前😀 "), changedInlineMath, schema.text(" 后")]),
    blockMath,
    table,
  ]);
  const deletedDocument = schema.nodes.doc.create(null, [
    paragraph("前😀  后"),
    blockMath,
    table,
  ]);

  const sourceText = "\uFEFF中文😀\r\n第二\n第三\r混合";
  const sourceBytes = new TextEncoder().encode(sourceText);
  const pendingMath = {
    version: 7,
    entries: [{
      id: "inline-edit-1",
      binding: {
        status: "linked",
        position: positions.inlineMath,
        kind: "inline",
      },
      accepted: {
        tex: "x+y",
        delimiter: "inline-dollar",
        raw: "$x+y$",
        originalTex: "x+y",
        displayMode: false,
      },
      local: {
        tex: "x+y+1",
        delimiter: "inline-dollar",
        raw: "$x+y$",
        originalTex: "x+y",
        displayMode: false,
      },
      state: "composing",
    }],
  };
  const captureFor = (doc, selection, pending = pendingMath) => ({
    sourceBytes,
    doc,
    selection,
    scroll: { scrollTop: 123.5, scrollRatio: 0.4 },
    pendingMath: pending,
    origin: { path: "C:\\notes\\恢复😀.md", kind: "normal" },
  });

  const conflictedPendingMath = {
    version: 7,
    entries: [{
      id: "inline-conflict-1",
      binding: {
        status: "conflicted",
        position: positions.inlineMath,
        kind: "inline",
        reason: "incoming-document-node-changed",
      },
      accepted: {
        tex: "x+y",
        delimiter: "inline-dollar",
        raw: "$x+y$",
        originalTex: "x+y",
        displayMode: false,
      },
      local: {
        tex: "x+y+1",
        delimiter: "inline-dollar",
        raw: "$x+y$",
        originalTex: "x+y",
        displayMode: false,
      },
      state: "conflict",
    }],
  };
  const orphanedPendingMath = {
    version: 8,
    entries: [{
      id: "inline-orphan-1",
      binding: {
        status: "orphaned",
        position: null,
        kind: "inline",
        reason: "node-view-destroyed-after-delete",
      },
      accepted: {
        tex: "x+y",
        delimiter: "inline-dollar",
        raw: "$x+y$",
        originalTex: "x+y",
        displayMode: false,
      },
      local: {
        tex: "x+y+1",
        delimiter: "inline-dollar",
        raw: "$x+y$",
        originalTex: "x+y",
        displayMode: false,
      },
      state: "editing",
    }],
  };
  const orphanedHintPendingMath = {
    version: orphanedPendingMath.version,
    entries: orphanedPendingMath.entries.map((entry) => ({
      ...entry,
      binding: {
        ...entry.binding,
        position: positions.inlineMath,
      },
    })),
  };
  const assertUnlinkedRoundTrip = (doc, pending, label) => {
    const selection = new AllSelection(doc);
    const encoded = codec.encodeRecoveryBundle(captureFor(doc, selection, pending));
    const decoded = codec.decodeRecoveryBundle(encoded, schema);
    assert.deepEqual(decoded.doc.toJSON(), doc.toJSON(), `${label}: document`);
    assert.deepEqual(decoded.pendingMath, pending, `${label}: pending payload`);
  };
  assertUnlinkedRoundTrip(changedDocument, conflictedPendingMath, "conflicted math");
  assertUnlinkedRoundTrip(deletedDocument, orphanedPendingMath, "orphaned math");
  assertUnlinkedRoundTrip(deletedDocument, orphanedHintPendingMath, "orphaned math with stale position hint");
  const capture = (selection) => captureFor(document, selection);
  const assertRoundTrip = (selection, label) => {
    const encoded = codec.encodeRecoveryBundle(capture(selection));
    const decoded = codec.decodeRecoveryBundle(encoded, schema);
    assert.deepEqual([...decoded.sourceBytes], [...sourceBytes], `${label}: source bytes`);
    assert.equal(decoded.sourceText, sourceText, `${label}: source text`);
    assert.deepEqual(decoded.doc.toJSON(), document.toJSON(), `${label}: document`);
    assert.deepEqual(decoded.selection.toJSON(), selection.toJSON(), `${label}: selection`);
    assert.deepEqual(decoded.pendingMath, pendingMath, `${label}: pending math`);
    assert.deepEqual(decoded.scroll, capture(selection).scroll, `${label}: scroll`);
    assert.deepEqual(decoded.origin, capture(selection).origin, `${label}: origin`);
    return encoded;
  };

  const paragraphStart = 1;
  const textSelection = TextSelection.create(document, paragraphStart + 1, paragraphStart + 3);
  const reverseTextSelection = TextSelection.create(document, paragraphStart + 3, paragraphStart + 1);
  const nodeSelection = NodeSelection.create(document, positions.blockMath);
  const cellSelection = CellSelection.create(document, positions.firstCell, positions.secondCell);
  assertRoundTrip(textSelection, "text");
  assertRoundTrip(reverseTextSelection, "reverse text");
  assertRoundTrip(nodeSelection, "node");
  assertRoundTrip(new AllSelection(document), "all");
  assertRoundTrip(cellSelection, "cell");

  const emptyDocument = schema.nodes.doc.create(null, [paragraph()]);
  const emptyCapture = {
    sourceBytes: new Uint8Array(0),
    doc: emptyDocument,
    selection: new AllSelection(emptyDocument),
    scroll: { scrollTop: 0, scrollRatio: 0 },
    pendingMath: { version: 0, entries: [] },
    origin: { path: null, kind: "untitled" },
  };
  const emptyDecoded = codec.decodeRecoveryBundle(codec.encodeRecoveryBundle(emptyCapture), schema);
  assert.deepEqual([...emptyDecoded.sourceBytes], []);
  assert.equal(emptyDecoded.sourceText, "");

  const encoded = codec.encodeRecoveryBundle(capture(reverseTextSelection));
  const parse = () => JSON.parse(encoded);
  const errorCode = (fn, expected, label) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof codec.RecoveryValidationError, `${label}: typed error`);
      assert.equal(error.code, expected, `${label}: error code`);
      return;
    }
    assert.fail(`${label}: expected ${expected}`);
  };
  const decodeObject = (mutate) => {
    const value = parse();
    mutate(value);
    return codec.decodeRecoveryBundle(value, schema);
  };

  errorCode(() => codec.decodeRecoveryBundle("{", schema), "invalid-json", "malformed JSON");
  errorCode(() => decodeObject((value) => { value.format = "other"; }), "invalid-format", "format");
  errorCode(() => decodeObject((value) => { value.schemaVersion = 1; }), "unsupported-version", "old schema version");
  errorCode(() => decodeObject((value) => { value.schemaVersion = 999; }), "unsupported-version", "version");
  errorCode(() => decodeObject((value) => { value.source.byteLength += 1; }), "invalid-source", "source length");
  errorCode(() => decodeObject((value) => { value.source.bytesBase64 = "////"; value.source.byteLength = 3; }), "invalid-source", "invalid UTF-8");
  errorCode(() => decodeObject((value) => { value.source.bytesBase64 = "AB=="; value.source.byteLength = 1; }), "invalid-source", "non-canonical padding bits");
  errorCode(() => decodeObject((value) => { value.document.json.content[0].attrs = { unknown: true }; }), "invalid-document", "unknown document attrs");
  errorCode(() => decodeObject((value) => {
    const block = JSON.parse(JSON.stringify(value.document.json.content[1]));
    value.document.json.content[0].content = [block];
  }), "invalid-document", "document content check");
  errorCode(() => decodeObject((value) => { value.document.json.content[1].attrs.displayMode = "no"; }), "invalid-document", "unvalidated block math attrs");
  errorCode(() => decodeObject((value) => { value.selection.json = { type: "text", anchor: positions.blockMath, head: positions.blockMath }; }), "invalid-selection", "text endpoint in block node");
  errorCode(() => decodeObject((value) => { value.selection.json = { type: "node", anchor: 2 }; }), "invalid-selection", "node non-boundary");
  errorCode(() => decodeObject((value) => { value.selection.json = { type: "cell", anchor: positions.blockMath, head: positions.firstCell }; }), "invalid-selection", "cell non-boundary");
  errorCode(() => decodeObject((value) => { value.selection.json = { type: "text", anchor: 0, head: 0 }; }), "invalid-selection", "text endpoint outside inline content");
  errorCode(() => decodeObject((value) => { value.scroll.scrollRatio = 2; }), "invalid-scroll", "scroll ratio");
  errorCode(() => decodeObject((value) => { value.origin.path = "bad\u0000path"; }), "invalid-origin", "origin path");
  errorCode(() => decodeObject((value) => { value.pendingMath.entries[0].accepted.tex = "wrong"; }), "invalid-pending-math", "pending accepted attrs");
  errorCode(() => decodeObject((value) => { value.pendingMath.entries[0].binding.position = positions.blockMath; }), "invalid-pending-math", "pending node kind");
  errorCode(() => decodeObject((value) => { value.pendingMath.entries[0].local = { ...value.pendingMath.entries[0].local, delimiter: "unknown" }; }), "invalid-pending-math", "pending delimiter");
  errorCode(() => decodeObject((value) => { value.pendingMath.entries[0].binding = { status: "linked", position: positions.inlineMath, kind: "inline", reason: "unexpected" }; }), "invalid-json", "linked binding unknown field");

  errorCode(() => decodeObject((value) => { value.document.json.content[0].type = "unknown"; }), "invalid-document", "failed restore");

  const secondTableDocument = schema.nodes.doc.create(null, [table, table]);
  const tableCellPositions = [];
  secondTableDocument.descendants((node, position) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") tableCellPositions.push(position);
  });
  assert.ok(tableCellPositions.length >= 4);
  const twoTableBundle = codec.encodeRecoveryBundle(captureFor(
    secondTableDocument,
    new AllSelection(secondTableDocument),
    { version: 0, entries: [] },
  ));
  errorCode(() => {
    const value = JSON.parse(twoTableBundle);
    value.selection.json = { type: "cell", anchor: tableCellPositions[0], head: tableCellPositions.at(-1) };
    codec.decodeRecoveryBundle(value, schema);
  }, "invalid-selection", "cell endpoints across tables");

  console.log("check-recovery-codec: passed (StarterKit + Table + MathNodes subset schema)");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
