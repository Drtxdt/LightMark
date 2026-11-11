import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmark-large-editor-logic-"));
const modulePath = path.join(tempDir, "largeTextEditing.mjs");

try {
  const source = fs.readFileSync(path.join(root, "src", "editor", "largeTextEditing.ts"), "utf8");
  fs.writeFileSync(modulePath, ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText, "utf8");
  const {
    applyLargeLocalEdit,
    createLargeBlockEdit,
    projectLargeOutline,
  } = await import(pathToFileURL(modulePath).href);

  const baseText = "one\r\ntwo\rthree\nfour";
  const block = { startLine: 4, baseText };
  const singleLine = createLargeBlockEdit(block, "one\ntwo!\nthree\nfour");
  assert.deepEqual(singleLine.edit, {
    startLine: 5,
    startColumn: 3,
    endLine: 5,
    endColumn: 3,
    text: "!",
  }, "a one-character edit uses its exact UTF-16 range");
  assert.equal(singleLine.resultingText, "one\r\ntwo!\rthree\nfour");

  const lines = [
    { line: 4, text: "one", eol: "\r\n" },
    { line: 5, text: "two", eol: "\r" },
    { line: 6, text: "three", eol: "\n" },
    { line: 7, text: "four", eol: "" },
  ];
  const first = applyLargeLocalEdit(lines, singleLine.edit);
  assert.ok(first);
  assert.deepEqual(first.lines, [
    { line: 4, text: "one", eol: "\r\n" },
    { line: 5, text: "two!", eol: "\r" },
    { line: 6, text: "three", eol: "\n" },
    { line: 7, text: "four", eol: "" },
  ], "local projection keeps untouched mixed EOLs and the edited line prefix");

  const secondEdit = createLargeBlockEdit(
    { startLine: 5, baseText: "two!\rthree" },
    "two!\rthree?",
  ).edit;
  const second = applyLargeLocalEdit(first.lines, secondEdit);
  assert.ok(second);
  assert.deepEqual(second.lines, [
    { line: 4, text: "one", eol: "\r\n" },
    { line: 5, text: "two!", eol: "\r" },
    { line: 6, text: "three?", eol: "\n" },
    { line: 7, text: "four", eol: "" },
  ], "a second edit uses the acknowledged local base instead of replacing the row with the delta");

  const emojiEdit = createLargeBlockEdit(
    { startLine: 0, baseText: "emoji 😀" },
    "emoji 😁",
  );
  assert.deepEqual(emojiEdit.edit, {
    startLine: 0,
    startColumn: 6,
    endLine: 0,
    endColumn: 8,
    text: "😁",
  }, "an emoji replacement expands the UTF-16 range to complete code-point boundaries");
  assert.equal(emojiEdit.resultingText, "emoji 😁");

  const emojiDelete = createLargeBlockEdit(
    { startLine: 2, baseText: "A😀B\r\nC\rD" },
    "AB\r\nC\rD",
  );
  assert.deepEqual(emojiDelete.edit, {
    startLine: 2,
    startColumn: 1,
    endLine: 2,
    endColumn: 3,
    text: "",
  }, "deleting an emoji addresses both UTF-16 code units and preserves following mixed EOLs");
  assert.equal(emojiDelete.resultingText, "AB\r\nC\rD");

  const crossLine = applyLargeLocalEdit([
    { line: 1, text: "abcdefghij", eol: "\r\n" },
    { line: 2, text: "xyz", eol: "" },
  ], {
    startLine: 1,
    startColumn: 10,
    endLine: 2,
    endColumn: 1,
    text: "!",
  });
  assert.ok(crossLine, "cross-line coordinates permit a larger start column than end column");
  assert.deepEqual(crossLine.lines, [
    { line: 1, text: "abcdefghij!yz", eol: "" },
  ], "cross-line edits preserve each boundary independently");

  const multiline = applyLargeLocalEdit(first.lines, {
    startLine: 5,
    startColumn: 1,
    endLine: 6,
    endColumn: 5,
    text: "X\nY",
  });
  assert.ok(multiline);
  assert.deepEqual(multiline.lines, [
    { line: 4, text: "one", eol: "\r\n" },
    { line: 5, text: "tX", eol: "\n" },
    { line: 6, text: "Y", eol: "\n" },
    { line: 7, text: "four", eol: "" },
  ], "a multiline replacement preserves both surrounding line boundaries");

  const outline = [
    { id: "large-heading-10", text: "Alpha", level: 2, line: 10 },
    { id: "large-heading-12", text: "Tail", level: 3, line: 12 },
    { id: "large-heading-15", text: "After", level: 2, line: 15 },
  ];
  const titleSuffix = projectLargeOutline(outline, {
    startLine: 10,
    endLine: 12,
  }, "## Alpha!\nbody\n### Tail", 18);
  assert.equal(titleSuffix.lineDelta, 0, "a one-character edit uses the explicit affected line range");
  assert.deepEqual(titleSuffix.outline, [
    { id: "large-heading-10", text: "Alpha!", level: 2, line: 10 },
    { id: "large-heading-12", text: "Tail", level: 3, line: 12 },
    { id: "large-heading-15", text: "After", level: 2, line: 15 },
  ], "editing a heading suffix re-parses the complete affected line range");

  const insertedLine = projectLargeOutline(outline, {
    startLine: 11,
    endLine: 11,
  }, "body\n### Inserted", 18);
  assert.equal(insertedLine.lineDelta, 1, "inserting a line shifts only later outline items");
  assert.deepEqual(insertedLine.outline, [
    { id: "large-heading-10", text: "Alpha", level: 2, line: 10 },
    { id: "large-heading-12", text: "Inserted", level: 3, line: 12 },
    { id: "large-heading-13", text: "Tail", level: 3, line: 13 },
    { id: "large-heading-16", text: "After", level: 2, line: 16 },
  ], "outline and total line coordinates remain correct after an inserted line");
  assert.equal(insertedLine.totalLines, 19);

  const deletedLine = projectLargeOutline(insertedLine.outline, {
    startLine: 11,
    endLine: 12,
  }, "body", insertedLine.totalLines);
  assert.equal(deletedLine.lineDelta, -1, "deleting a line uses the old coordinate range rather than the block size");
  assert.deepEqual(deletedLine.outline, [
    { id: "large-heading-10", text: "Alpha", level: 2, line: 10 },
    { id: "large-heading-12", text: "Tail", level: 3, line: 12 },
    { id: "large-heading-15", text: "After", level: 2, line: 15 },
  ], "deleting a line removes headings in the range and shifts later headings back");
  assert.equal(deletedLine.totalLines, 18);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("large editor text projection checks passed (minimal UTF-16 edits, mixed EOL, consecutive ACKs, outline projection)");
