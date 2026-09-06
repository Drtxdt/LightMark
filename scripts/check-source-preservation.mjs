import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-source-preservation-"));
try {
  const compiled = compileTypeScriptModuleGraph(path.resolve("src/editor/sourcePreservation.ts"), tempDir);
  const sourceTools = await import(pathToFileURL(compiled).href);
  const markdownCompiled = compileTypeScriptModuleGraph(path.resolve("src/utils/markdown.ts"), tempDir);
  const markdownTools = await import(pathToFileURL(markdownCompiled).href);
  const original = "\uFEFF#  Title\r\n\r\n-  untouched  \r\n\r\nText $x$\r\n";
  const start = original.lastIndexOf("$x$") + 1;
  const patch = sourceTools.sourcePatch(original, { from: start, to: start + 1 }, "x+1");
  const updated = sourceTools.applySourcePatches(original, [patch], 7, 7);
  assert.equal(updated, "\uFEFF#  Title\r\n\r\n-  untouched  \r\n\r\nText $x+1$\r\n");
  assert.deepEqual(sourceTools.inspectSourceEnvelope(original), {
    bom: "\uFEFF",
    lineEnding: "\r\n",
    terminalNewlines: "\r\n",
  });
  assert.throws(() => sourceTools.applySourcePatches(original, [patch], 7, 8), { name: "StaleSourceVersionError" });
  const conflicting = `${original.slice(0, start)}y${original.slice(start + 1)}`;
  assert.throws(() => sourceTools.applySourcePatches(conflicting, [patch], 7, 7), { name: "SourcePatchConflictError" });
  assert.throws(() => sourceTools.applySourcePatches(original, [patch, { from: start, to: start + 2, insert: "y" }]), { name: "SourcePatchConflictError" });
  const bookmark = sourceTools.mapBookmarkThroughPatches({ documentId: "doc", version: 7, from: start + 2, to: start + 2 }, [patch], 8);
  assert.equal(bookmark.from, start + 4);
  assert.equal(bookmark.version, 8);

  const mappedSource = "\uFEFF#  Keep heading\r\n\r\nParagraph  \r\n\r\n-  keep list marker\r\n";
  const mapped = markdownTools.markdownTopLevelSourceBlocks(mappedSource);
  assert.equal(mapped.prefix, "\uFEFF");
  assert.equal(mapped.blocks.length, 3);
  const headingNode = {};
  const paragraphNode = {};
  const listNode = {};
  const changedParagraphNode = {};
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [headingNode, paragraphNode, listNode],
      mapped.blocks,
      [headingNode, changedParagraphNode, listNode],
      ["# Keep heading", "Changed", "- keep list marker"],
      mapped.prefix,
      "\r\n",
    ),
    "\uFEFF#  Keep heading\r\n\r\nChanged\r\n\r\n-  keep list marker\r\n",
  );
  const insertedNode = {};
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [headingNode, paragraphNode, listNode],
      mapped.blocks,
      [headingNode, insertedNode, paragraphNode, listNode],
      ["# Keep heading", "Inserted", "Paragraph", "- keep list marker"],
      mapped.prefix,
      "\r\n",
    ),
    "\uFEFF#  Keep heading\r\n\r\nInserted\r\n\r\nParagraph  \r\n\r\n-  keep list marker\r\n",
  );

  const snapshotSource = fs.readFileSync(path.resolve("src/editor/wysiwygSnapshot.ts"), "utf8");
  const wysiwygSource = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");
  assert.match(snapshotSource, /if \(!this\.source\.dirty\(\)\)/);
  assert.match(snapshotSource, /markdown: previousMarkdown/);
  assert.match(wysiwygSource, /已阻止静默覆盖/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("source preservation checks passed");
