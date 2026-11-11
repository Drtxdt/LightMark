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

  const imageMarkdown = '![封面](cover.svg)';
  const imageBlock = { type: { name: 'image' }, content: { size: 0 } };
  const caret = { type: { name: 'paragraph' }, content: { size: 0 } };
  const typed = { type: { name: 'paragraph' }, content: { size: 2 } };
  for (const ending of ['', '\n', '\r\n', '\n\n\n']) {
    const raw = imageMarkdown + ending;
    const eol = ending.includes('\r') ? '\r\n' : '\n';
    const source = markdownTools.markdownTopLevelSourceBlocks(raw);
    const nodes = [imageBlock, caret];
    const aligned = sourceTools.sourceBlocksForNodes(source.blocks, nodes, source.prefix);
    for (const exactPatch of [undefined, () => '尾注']) {
      const snapshot = (current, content) => sourceTools.combinePreservedSourceBlocks(
        nodes, aligned.blocks, current, [imageMarkdown, content], aligned.prefix, eol, aligned.syntheticTailOmitted, exactPatch,
      );
      assert.equal(snapshot(nodes, ''), raw);
      const expectedGap = ending === '\n\n\n' ? ending : eol.repeat(2);
      assert.equal(snapshot([imageBlock, typed], '尾注'), imageMarkdown + expectedGap + '尾注');
    }
  }

  const mappedSource = "\uFEFF#  Keep heading\r\n\r\nParagraph  \r\n\r\n-  keep list marker\r\n";
  const mapped = markdownTools.markdownTopLevelSourceBlocks(mappedSource);
  assert.equal(mapped.prefix, "\uFEFF");
  assert.equal(mapped.blocks.length, 4);
  const headingNode = {};
  const paragraphNode = {};
  const listNode = {};
  const trailingParagraphNode = {};
  const changedParagraphNode = {};
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [headingNode, paragraphNode, listNode, trailingParagraphNode],
      mapped.blocks,
      [headingNode, changedParagraphNode, listNode, trailingParagraphNode],
      ["# Keep heading", "Changed", "- keep list marker", ""],
      mapped.prefix,
      "\r\n",
    ),
    "\uFEFF#  Keep heading\r\n\r\nChanged\r\n\r\n-  keep list marker\r\n",
  );
  const insertedNode = {};
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [headingNode, paragraphNode, listNode, trailingParagraphNode],
      mapped.blocks,
      [headingNode, insertedNode, paragraphNode, listNode, trailingParagraphNode],
      ["# Keep heading", "Inserted", "Paragraph", "- keep list marker", ""],
      mapped.prefix,
      "\r\n",
    ),
    "\uFEFF#  Keep heading\r\n\r\nInserted\r\n\r\nParagraph  \r\n\r\n-  keep list marker\r\n",
  );

  const noTerminalNewline = "abc";
  const noTerminalNewlineMapped = markdownTools.markdownTopLevelSourceBlocks(noTerminalNewline);
  const noTerminalNewlineOriginalNode = {};
  const noTerminalNewlineChangedNode = {};
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [noTerminalNewlineOriginalNode],
      noTerminalNewlineMapped.blocks,
      [noTerminalNewlineChangedNode],
      ["abcd"],
      noTerminalNewlineMapped.prefix,
      "\n",
    ),
    "abcd",
  );
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [noTerminalNewlineOriginalNode],
      noTerminalNewlineMapped.blocks,
      [noTerminalNewlineOriginalNode, {}],
      ["abc", "new block"],
      noTerminalNewlineMapped.prefix,
      "\n",
    ),
    "abc\n\nnew block",
  );

  const combineWithFreshFinalBlock = (source, serialized) => {
    const mappedSource = markdownTools.markdownTopLevelSourceBlocks(source);
    const originalNodes = mappedSource.blocks.map(() => ({}));
    const currentNodes = originalNodes.slice();
    const targetIndex = mappedSource.blocks.findLastIndex((block) => block.source.length > 0);
    if (targetIndex >= 0) currentNodes[targetIndex] = {};
    const serializedBlocks = mappedSource.blocks.map((block, index) => index === targetIndex ? serialized[0] : block.source);
    return sourceTools.combinePreservedSourceBlocks(
      originalNodes,
      mappedSource.blocks,
      currentNodes,
      serializedBlocks,
      mappedSource.prefix,
      source.match(/\r\n|\r|\n/)?.[0] ?? "\n",
    );
  };

  assert.equal(combineWithFreshFinalBlock("abc\n", ["abcd"]), "abcd\n");
  assert.equal(combineWithFreshFinalBlock("abc\r\n", ["abcd"]), "abcd\r\n");
  assert.equal(combineWithFreshFinalBlock("\uFEFFabc", ["abcd"]), "\uFEFFabcd");
  assert.equal(combineWithFreshFinalBlock("- one", ["- two"]), "- two");
  assert.equal(
    combineWithFreshFinalBlock("| a |\n| --- |\n| b |", ["| a |\n| --- |\n| c |"]),
    "| a |\n| --- |\n| c |",
  );

  const emptyMapped = markdownTools.markdownTopLevelSourceBlocks("");
  const emptyNode = {};
  const changedEmptyNode = {};
  assert.equal(
    sourceTools.combinePreservedSourceBlocks([emptyNode], emptyMapped.blocks, [changedEmptyNode], ["new block"], emptyMapped.prefix, "\n"),
    "new block",
  );

  const multiLine = "first line\nsecond line";
  const multiLineMapped = markdownTools.markdownTopLevelSourceBlocks(multiLine);
  assert.equal(multiLineMapped.blocks.length, 1);
  assert.equal(multiLineMapped.blocks[0].source, multiLine);
  assert.equal(combineWithFreshFinalBlock(multiLine, ["first line\nupdated line"]), "first line\nupdated line");

  const multiBlock = "first\n\nsecond";
  const multiBlockMapped = markdownTools.markdownTopLevelSourceBlocks(multiBlock);
  const firstNode = {};
  const secondNode = {};
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [firstNode, secondNode],
      multiBlockMapped.blocks,
      [firstNode, {}],
      ["first", "updated"],
      multiBlockMapped.prefix,
      "\n",
    ),
    "first\n\nupdated",
  );
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [firstNode, secondNode],
      multiBlockMapped.blocks,
      [firstNode],
      ["first"],
      multiBlockMapped.prefix,
      "\n",
    ),
    "first\n\n",
  );
  assert.equal(
    sourceTools.combinePreservedSourceBlocks(
      [firstNode, secondNode],
      multiBlockMapped.blocks,
      [firstNode, secondNode, {}],
      ["first", "second", "new block"],
      multiBlockMapped.prefix,
      "\n",
    ),
    "first\n\nsecond\n\nnew block",
  );

  {
    const before = [{}, {}], after = [{}, {}];
    const pieces = [{ source: 'first\r\n', separator: '\n' }, { source: '[^qa]: pending footnote\n', separator: '' }];
    const exact = sourceTools.combinePreservedSourceBlocks(before, pieces, after, ['first', '[^qa]: pending footnote'], '', '\n', false, source => source);
    assert.equal(exact, 'first\r\n\n[^qa]: pending footnote\n', 'exact pieces already own their terminal EOL and mixed separators');
    const changed = sourceTools.combinePreservedSourceBlocks(before, pieces, after, ['updated', '[^qa]: pending footnote'], '', '\n', false, (source, node) => node === before[1] ? source : null);
    assert.equal(changed.endsWith('[^qa]: pending footnote\n'), true, 'compatibility fallback cannot duplicate an exact tail newline');
  }
  {
    const before = {}, edited = {}, trailing = { type: { name: 'paragraph' }, content: { size: 0 } };
    const source = '~~~text\noriginal\n~~~';
    let patches = 0;
    const actual = sourceTools.combinePreservedSourceBlocks([before], [{ source, separator: '\r\n' }], [edited, trailing], ['```plaintext\nupdated\n```', ''], '', '\n', true,
      (raw, old, next) => { assert.equal(old, before); assert.equal(next, edited); patches++; return raw.replace('original', 'updated'); });
    assert.equal(actual, '~~~text\nupdated\n~~~\r\n');
    assert.equal(patches, 1, 'a generated empty tail cannot bypass the real block patch');
    const meaningful = { type: { name: 'paragraph' }, content: { size: 7 } };
    const withText = sourceTools.combinePreservedSourceBlocks([before], [{ source, separator: '' }], [edited, meaningful], ['```plaintext\nupdated\n```', 'new text'], '', '\n', true, () => null);
    assert.ok(withText.endsWith('new text'), 'a real appended paragraph is retained');
  }
  const snapshotSource = fs.readFileSync(path.resolve("src/editor/wysiwygSnapshot.ts"), "utf8");
  const wysiwygSource = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");
  assert.match(snapshotSource, /if \(!this\.source\.dirty\(\)\)/);
  assert.match(snapshotSource, /markdown: previousMarkdown/);
  assert.match(wysiwygSource, /已阻止静默覆盖/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("source preservation checks passed");
