import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Link from "@tiptap/extension-link";
import { EditorState } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-source-leaf-"));

try {
  const compiled = compileTypeScriptModuleGraph(path.resolve("src/editor/sourceLeafProvenance.ts"), tempDir);
  const provenance = await import(pathToFileURL(compiled).href);
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
    Link.configure({ openOnClick: false }),
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
  const stateFor = (document) => EditorState.create({ schema, doc: document });
  const emptyParagraphContentPosition = (document) => {
    let result = null;
    document.descendants((node, position) => {
      if (result === null && node.type.name === "paragraph" && node.content.size === 0) result = position + 1;
    });
    return result;
  };

  const errorCode = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof provenance.SourceProvenanceMappingError, error);
      return error.code;
    }
    assert.fail("expected a typed source provenance failure");
  };

  // Plain text: parser-derived leaf offsets patch only the changed source text.
  {
    const source = "abc";
    const state = stateFor(doc(paragraph("abc")));
    const baseline = provenance.mapSourceTextLeaves(source, state.doc);
    assert.deepEqual(baseline.leaves.map(({ text, rawFrom, rawTo, pmFrom, pmTo }) => ({ text, rawFrom, rawTo, pmFrom, pmTo })), [
      { text: "abc", rawFrom: 0, rawTo: 3, pmFrom: 1, pmTo: 4 },
    ]);

    const appended = state.tr.insertText("d", baseline.leaves[0].pmTo);
    const appendPatches = provenance.mapSourceLeafTransaction(baseline, state.doc, appended);
    assert.deepEqual(provenance.applySourceLeafPatches(source, appendPatches), "abcd");
    assert.equal(errorCode(() => provenance.applySourceLeafPatches("abc\n", appendPatches)), "stale-baseline");

    const deleted = state.tr.delete(baseline.leaves[0].pmFrom, baseline.leaves[0].pmFrom + 1);
    const deletePatches = provenance.mapSourceLeafTransaction(baseline, state.doc, deleted);
    assert.equal(provenance.applySourceLeafPatches(source, deletePatches), "bc");

    const replaced = state.tr.insertText("Z", baseline.leaves[0].pmFrom, baseline.leaves[0].pmFrom + 1);
    const replacePatches = provenance.mapSourceLeafTransaction(baseline, state.doc, replaced);
    assert.equal(provenance.applySourceLeafPatches(source, replacePatches), "Zbc");
  }

  // Encoded/marked/linked/code leaves are explicit typed failures in this first slice.
  {
    const source = "[a](a)a";
    const linked = schema.marks.link.create({ href: "a" });
    const linkedParagraph = schema.nodes.paragraph.create(null, [
      schema.text("a", [linked]),
      schema.text("a"),
    ]);
    const state = stateFor(doc(linkedParagraph));
    assert.equal(errorCode(() => provenance.mapSourceTextLeaves(source, state.doc)), "unsupported-inline");
  }
  {
    const encodedCases = [
      ["&amp;", "&"],
      ["\\*", "*"],
      ["`abc`", "abc"],
      ["**abc**", "abc"],
    ];
    for (const [source, text] of encodedCases) {
      const state = stateFor(doc(paragraph(text)));
      assert.equal(errorCode(() => provenance.mapSourceTextLeaves(source, state.doc)), "unsupported-inline", source);
    }
  }

  // Lists: list marker syntax is outside the mapped paragraph leaf.
  {
    const state = stateFor(doc(bulletList("abc")));
    const baseline = provenance.mapSourceTextLeaves("- abc", state.doc);
    const transaction = state.tr.insertText("d", baseline.leaves[0].pmTo);
    assert.equal(
      provenance.applySourceLeafPatches("- abc", provenance.mapSourceLeafTransaction(baseline, state.doc, transaction)),
      "- abcd",
    );
    const replaced = state.tr.insertText("Z", baseline.leaves[0].pmFrom + 1, baseline.leaves[0].pmFrom + 2);
    assert.equal(
      provenance.applySourceLeafPatches("- abc", provenance.mapSourceLeafTransaction(baseline, state.doc, replaced)),
      "- aZc",
    );
    const deleted = state.tr.delete(baseline.leaves[0].pmFrom + 1, baseline.leaves[0].pmFrom + 2);
    assert.equal(
      provenance.applySourceLeafPatches("- abc", provenance.mapSourceLeafTransaction(baseline, state.doc, deleted)),
      "- ac",
    );

    const orderedState = stateFor(doc(orderedList("abc")));
    const orderedBaseline = provenance.mapSourceTextLeaves("3.  abc", orderedState.doc);
    const orderedTransaction = orderedState.tr.insertText("d", orderedBaseline.leaves[0].pmTo);
    assert.equal(
      provenance.applySourceLeafPatches("3.  abc", provenance.mapSourceLeafTransaction(orderedBaseline, orderedState.doc, orderedTransaction)),
      "3.  abcd",
    );
  }

  // Tables: changing one body cell leaves header spacing and the other cell byte-for-byte untouched.
  {
    const source = "|  a  | b |\n| --- | --- |\n| x | y |";
    const state = stateFor(doc(table("a", "b", "x", "y")));
    const baseline = provenance.mapSourceTextLeaves(source, state.doc);
    assert.deepEqual(baseline.leaves.map((leaf) => leaf.text), ["a", "b", "x", "y"]);
    const x = baseline.leaves.find((leaf) => leaf.text === "x");
    assert.ok(x);
    const transaction = state.tr.insertText("z", x.pmTo);
    const patches = provenance.mapSourceLeafTransaction(baseline, state.doc, transaction);
    assert.equal(provenance.applySourceLeafPatches(source, patches), "|  a  | b |\n| --- | --- |\n| xz | y |");
    const replacement = state.tr.insertText("q", x.pmFrom, x.pmTo);
    assert.equal(
      provenance.applySourceLeafPatches(source, provenance.mapSourceLeafTransaction(baseline, state.doc, replacement)),
      "|  a  | b |\n| --- | --- |\n| q | y |",
    );
    const deletion = state.tr.delete(x.pmFrom, x.pmTo);
    assert.equal(
      provenance.applySourceLeafPatches(source, provenance.mapSourceLeafTransaction(baseline, state.doc, deletion)),
      "|  a  | b |\n| --- | --- |\n|  | y |",
    );
  }

  // Empty cells map to a parsed zero-width text slot while preserving the cell's padding.
  {
    const source = "| a | b |\n| --- | --- |\n|  | y |";
    const state = stateFor(doc(table("a", "b", "", "y")));
    const baseline = provenance.mapSourceTextLeaves(source, state.doc);
    const emptyPosition = emptyParagraphContentPosition(state.doc);
    assert.notEqual(emptyPosition, null);
    const emptyLeaf = baseline.leaves.find((leaf) => leaf.emptySlot);
    assert.ok(emptyLeaf);
    assert.equal(emptyLeaf.text, "");
    assert.equal(emptyLeaf.rawText, "  ");
    assert.deepEqual(emptyLeaf.emptySlot.pmPath, [0, 1, 0, 0]);
    assert.equal(emptyLeaf.pmFrom, emptyPosition);
    const insertion = state.tr.insertText("x", emptyPosition);
    const insertionPatches = provenance.mapSourceLeafTransaction(baseline, state.doc, insertion);
    assert.equal(provenance.applySourceLeafPatches(source, insertionPatches), "| a | b |\n| --- | --- |\n| x | y |");

    const filledSource = "| a | b |\n| --- | --- |\n| x | y |";
    const filledState = stateFor(doc(table("a", "b", "x", "y")));
    const filledBaseline = provenance.mapSourceTextLeaves(filledSource, filledState.doc);
    const x = filledBaseline.leaves.find((leaf) => leaf.text === "x");
    assert.ok(x);
    const deletion = filledState.tr.delete(x.pmFrom, x.pmTo);
    const emptySource = provenance.applySourceLeafPatches(filledSource, provenance.mapSourceLeafTransaction(filledBaseline, filledState.doc, deletion));
    const rebuiltState = stateFor(deletion.doc);
    const rebuiltBaseline = provenance.mapSourceTextLeaves(emptySource, rebuiltState.doc);
    const rebuiltPosition = emptyParagraphContentPosition(rebuiltState.doc);
    assert.notEqual(rebuiltPosition, null);
    const reinsertion = rebuiltState.tr.insertText("z", rebuiltPosition);
    const reinsertionPatches = provenance.mapSourceLeafTransaction(rebuiltBaseline, rebuiltState.doc, reinsertion);
    assert.equal(provenance.applySourceLeafPatches(emptySource, reinsertionPatches), "| a | b |\n| --- | --- |\n| z | y |");

    const utfSource = "\uFEFF| a | b |\r\n| --- | --- |\r\n|  |  |";
    const utfState = stateFor(doc(table("a", "b", "", "")));
    const utfBaseline = provenance.mapSourceTextLeaves(utfSource, utfState.doc);
    const utfSlots = utfBaseline.leaves.filter((leaf) => leaf.emptySlot);
    assert.equal(utfSlots.length, 2);
    assert.notEqual(utfSlots[0].emptySlot.pmPath.join("/"), utfSlots[1].emptySlot.pmPath.join("/"));
    const secondSlotInsertion = utfState.tr.insertText("😀", utfSlots[1].pmFrom);
    const secondSlotPatches = provenance.mapSourceLeafTransaction(utfBaseline, utfState.doc, secondSlotInsertion);
    assert.equal(
      provenance.applySourceLeafPatches(utfSource, secondSlotPatches),
      "\uFEFF| a | b |\r\n| --- | --- |\r\n|  | 😀 |",
    );
  }

  // A synthetic top-level empty paragraph has no unique Markdown raw interval; reject it explicitly.
  {
    const emptyParagraphState = stateFor(doc(paragraph("")));
    assert.equal(
      errorCode(() => provenance.mapSourceTextLeaves("", emptyParagraphState.doc)),
      "block-count-mismatch",
    );
  }

  // Regression: repeated text must bind to the parser's content span, never the list marker.
  {
    const source = "3. 3";
    const state = stateFor(doc(orderedList("3")));
    const baseline = provenance.mapSourceTextLeaves(source, state.doc);
    const transaction = state.tr.insertText("x", baseline.leaves[0].pmTo);
    const patches = provenance.mapSourceLeafTransaction(baseline, state.doc, transaction);
    assert.equal(provenance.applySourceLeafPatches(source, patches), "3. 3x", "ordered-list content must not match the marker");
  }

  // Regression: a table body value equal to the delimiter must bind to its cell, not the delimiter row.
  {
    const source = "| a | b |\n| --- | --- |\n| --- | y |";
    const state = stateFor(doc(table("a", "b", "---", "y")));
    const baseline = provenance.mapSourceTextLeaves(source, state.doc);
    const body = baseline.leaves.find((leaf) => leaf.text === "---");
    assert.ok(body);
    const transaction = state.tr.insertText("x", body.pmTo);
    const patches = provenance.mapSourceLeafTransaction(baseline, state.doc, transaction);
    assert.equal(provenance.applySourceLeafPatches(source, patches), "| a | b |\n| --- | --- |\n| ---x | y |", "table content must not match the delimiter");
  }

  // Regression: equal PM structure with different text is a stale baseline, not a valid local edit.
  {
    const baselineState = stateFor(doc(paragraph("abc")));
    const baseline = provenance.mapSourceTextLeaves("abc", baselineState.doc);
    const staleState = stateFor(doc(paragraph("xyz")));
    const transaction = staleState.tr.insertText("q", baseline.leaves[0].pmTo);
    assert.equal(errorCode(() => provenance.mapSourceLeafTransaction(baseline, staleState.doc, transaction)), "stale-baseline");
  }

  // Regression: source text that becomes block or inline syntax must be rejected until a syntax-aware mapper exists.
  {
    for (const replacement of ["$x$", "# x", "- x", "1. x", "---"]) {
      const state = stateFor(doc(paragraph("abc")));
      const baseline = provenance.mapSourceTextLeaves("abc", state.doc);
      const transaction = state.tr.insertText(replacement, baseline.leaves[0].pmFrom, baseline.leaves[0].pmTo);
      assert.equal(
        errorCode(() => provenance.mapSourceLeafTransaction(baseline, state.doc, transaction)),
        "syntax-sensitive-text",
        `syntax-sensitive replacement ${JSON.stringify(replacement)} must fail precisely`,
      );
    }
  }

  // One PM transaction can carry edits to two independently mapped leaves.
  {
    const source = "first\n\nsecond";
    const state = stateFor(doc(paragraph("first"), paragraph("second")));
    const baseline = provenance.mapSourceTextLeaves(source, state.doc);
    const high = baseline.leaves[1];
    const low = baseline.leaves[0];
    let transaction = state.tr.insertText("!", high.pmTo);
    transaction = transaction.insertText("?", low.pmFrom);
    const patches = provenance.mapSourceLeafTransaction(baseline, state.doc, transaction);
    assert.equal(provenance.applySourceLeafPatches(source, patches), "?first\n\nsecond!");
  }

  // UTF-16 offsets include BOM, CRLF and surrogate pairs; source mapping remains byte-range local.
  {
    const source = "\uFEFF- 中文😀\r\n\r\n| 甲 | 😀 |\r\n| --- | --- |\r\n| x | y |";
    const state = stateFor(doc(bulletList("中文😀"), table("甲", "😀", "x", "y")));
    const baseline = provenance.mapSourceTextLeaves(source, state.doc);
    assert.equal(baseline.bom, "\uFEFF");
    assert.deepEqual(baseline.leaves.map((leaf) => leaf.text), ["中文😀", "甲", "😀", "x", "y"]);
    const emoji = baseline.leaves[0];
    let transaction = state.tr.insertText("🚀", emoji.pmTo);
    const body = baseline.leaves[3];
    transaction = transaction.insertText("z", transaction.mapping.map(body.pmTo));
    const patches = provenance.mapSourceLeafTransaction(baseline, state.doc, transaction);
    assert.equal(
      provenance.applySourceLeafPatches(source, patches),
      "\uFEFF- 中文😀🚀\r\n\r\n| 甲 | 😀 |\r\n| --- | --- |\r\n| xz | y |",
    );
  }

  // Marks and structure changes are typed failures for the text-only first slice.
  {
    const state = stateFor(doc(paragraph("abc")));
    const baseline = provenance.mapSourceTextLeaves("abc", state.doc);
    const bold = state.tr.addMark(baseline.leaves[0].pmFrom, baseline.leaves[0].pmTo, schema.marks.bold.create());
    assert.equal(errorCode(() => provenance.mapSourceLeafTransaction(baseline, state.doc, bold)), "marks-changed");

    const split = state.tr.split(2);
    assert.equal(errorCode(() => provenance.mapSourceLeafTransaction(baseline, state.doc, split)), "structure-changed");

    const syntax = state.tr.insertText("*x*", baseline.leaves[0].pmTo);
    assert.equal(errorCode(() => provenance.mapSourceLeafTransaction(baseline, state.doc, syntax)), "syntax-sensitive-text");
  }

  console.log("source leaf provenance checks passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
