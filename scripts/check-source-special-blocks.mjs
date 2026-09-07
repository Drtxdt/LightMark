import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSchema, Node as TiptapNode } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

// These are real regression assertions for LM012. They exercise the shared
// editor preprocessing pipeline while checking that raw source ranges remain
// stable when prepared blocks change their line count.
const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-source-special-blocks-"));
try {
  const markdownCompiled = compileTypeScriptModuleGraph(path.resolve("src/utils/markdown.ts"), tempDir);
  const preservationCompiled = compileTypeScriptModuleGraph(path.resolve("src/editor/sourcePreservation.ts"), tempDir);
  const markdown = await import(pathToFileURL(markdownCompiled).href);
  const preservation = await import(pathToFileURL(preservationCompiled).href);

  const fixtures = [
    {
      name: "frontmatter plus following paragraph",
      source: "---\ntitle: Audit\n---\n\nabc\n",
    },
    {
      name: "block formula plus following paragraph",
      source: "$$\nx+y\n$$\n\nabc\n",
    },
    {
      name: "mermaid plus following paragraph",
      source: "```mermaid\ngraph TD\n A-->B\n```\n\nabc\n",
    },
  ];

  const failures = [];
  for (const fixture of fixtures) {
    const mapped = markdown.markdownTopLevelSourceBlocks(fixture.source);
    const originalNodes = mapped.blocks.map(() => ({}));
    const changedNodes = originalNodes.slice();
    changedNodes[changedNodes.length - 1] = {};
    const serialized = mapped.blocks.map((block, index) =>
      index === mapped.blocks.length - 1 ? "abcd" : block.source,
    );
    const actual = preservation.combinePreservedSourceBlocks(
      originalNodes,
      mapped.blocks,
      changedNodes,
      serialized,
      mapped.prefix,
      "\n",
    );
    const expected = fixture.source.replace("abc\n", "abcd\n");
    try {
      assert.equal(actual, expected);
    } catch (error) {
      failures.push(`${fixture.name}\n${error.message}`);
    }
  }

  assert.equal(failures.length, 0, `LM012 source-span fixtures failed:\n\n${failures.join("\n\n")}`);

  const lineEndingOf = (source) => source.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const replaceBlock = (source, blockIndex, replacement) => {
    const mapped = markdown.markdownTopLevelSourceBlocks(source);
    const originalNodes = mapped.blocks.map(() => ({}));
    const currentNodes = originalNodes.slice();
    currentNodes[blockIndex] = {};
    const serialized = mapped.blocks.map((block, index) => index === blockIndex ? replacement : block.source);
    return preservation.combinePreservedSourceBlocks(
      originalNodes,
      mapped.blocks,
      currentNodes,
      serialized,
      mapped.prefix,
      lineEndingOf(source),
    );
  };

  const exactFixtures = [
    {
      name: "frontmatter own edit",
      source: "---\ntitle: Audit\n---\n\nabc\n",
      replacement: "---\ntitle: Reviewed\n---",
      expected: "---\ntitle: Reviewed\n---\n\nabc\n",
    },
    {
      name: "block formula own edit",
      source: "$$\nx+y\n$$\n\nabc\n",
      replacement: "$$\nx+z\n$$",
      expected: "$$\nx+z\n$$\n\nabc\n",
    },
    {
      name: "mermaid own edit",
      source: "```mermaid\ngraph TD\n A-->B\n```\n\nabc\n",
      replacement: "```mermaid\ngraph TD\n A-->C\n```",
      expected: "```mermaid\ngraph TD\n A-->C\n```\n\nabc\n",
    },
    {
      name: "frontmatter before and after blocks",
      source: "---\ntitle: Audit\n---\n\nfirst\n\nsecond\n",
      replacement: "updated",
      expected: "---\ntitle: Audit\n---\n\nfirst\n\nupdated\n",
    },
    {
      name: "adjacent special blocks",
      source: "$$\na\n$$\n\n```mermaid\ngraph TD\n A-->B\n```\n\ntext\n",
      replacement: "$$\nb\n$$",
      expected: "$$\nb\n$$\n\n```mermaid\ngraph TD\n A-->B\n```\n\ntext\n",
    },
    {
      name: "CRLF BOM and non BMP text",
      source: "\uFEFF---\r\ntitle: 审核🚀\r\n---\r\n\r\n中文😀\r\n",
      replacement: "---\r\ntitle: 已审🚀\r\n---",
      expected: "\uFEFF---\r\ntitle: 已审🚀\r\n---\r\n\r\n中文😀\r\n",
    },
  ];

  for (const fixture of exactFixtures) {
    const mapped = markdown.markdownTopLevelSourceBlocks(fixture.source);
    assert.ok(mapped.blocks.length >= 2, `${fixture.name}: expected separated source blocks`);
    const index = fixture.name === "frontmatter before and after blocks" ? mapped.blocks.length - 1 : 0;
    assert.equal(replaceBlock(fixture.source, index, fixture.replacement), fixture.expected, fixture.name);
  }

  const deletionSource = "$$\nx\n$$\n\nabc\n\nxyz\n";
  const deletionMapped = markdown.markdownTopLevelSourceBlocks(deletionSource);
  const deletionNodes = deletionMapped.blocks.map(() => ({}));
  const deletionResult = preservation.combinePreservedSourceBlocks(
    deletionNodes,
    deletionMapped.blocks,
    [deletionNodes[1], deletionNodes[2]],
    [deletionMapped.blocks[1].source, deletionMapped.blocks[2].source],
    deletionMapped.prefix,
    "\n",
  );
  assert.equal(deletionResult, "abc\n\nxyz\n", "deleting a special block preserves later raw blocks");

  const missingFootnoteSource = "正文[^missing]\n\n尾部\n";
  const missingFootnoteMapped = markdown.markdownTopLevelSourceBlocks(missingFootnoteSource);
  assert.deepEqual(
    missingFootnoteMapped.blocks.map((block) => [block.source, block.separator]),
    [["正文[^missing]", "\n\n"], ["尾部", "\n"], ["", ""], ["", ""]],
    "missing footnote and trailing paragraph use EOF zero-width blocks",
  );
  assert.equal(missingFootnoteMapped.blocks.at(-2)?.synthetic, undefined, "generated footnote block is not synthetic");
  assert.equal(missingFootnoteMapped.blocks.at(-2)?.generated, "footnotes");
  assert.equal(missingFootnoteMapped.blocks.at(-1)?.synthetic, "trailing-paragraph");

  const FootnotesProbeNode = TiptapNode.create({
    name: "footnotes",
    group: "block",
    atom: true,
    parseHTML: () => [{ tag: "section[data-type=footnotes]" }],
    renderHTML: () => ["section", { "data-type": "footnotes" }],
  });
  const starterKit = StarterKit.configure({
    heading: false,
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    code: false,
    link: false,
  });
  const trailingNode = starterKit.config.addExtensions.call(starterKit).find((extension) => extension.name === "trailingNode");
  assert.ok(trailingNode, "StarterKit keeps the real TrailingNode extension enabled");
  const schema = getSchema([starterKit, FootnotesProbeNode]);
  const trailingPlugins = trailingNode.config.addProseMirrorPlugins.call({
    name: trailingNode.name,
    options: trailingNode.options,
    editor: { schema },
  });
  const paragraph = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
  let pmState = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [paragraph("正文[^missing]"), paragraph("尾部"), schema.nodes.footnotes.create()]),
    plugins: trailingPlugins,
  });
  assert.equal(pmState.doc.childCount, 3, "real PM document starts with the three rendered source blocks");
  pmState = pmState.applyTransaction(pmState.tr.setMeta("source-special-block-probe", true)).state;
  assert.equal(pmState.doc.childCount, missingFootnoteMapped.blocks.length, "StarterKit TrailingNode adds the mapped EOF block");
  assert.equal(pmState.doc.lastChild?.type.name, "paragraph");
  assert.equal(pmState.doc.lastChild?.content.size, 0);

  const initialFootnoteNodes = missingFootnoteMapped.blocks.slice(0, 3).map(() => ({}));
  const initialFootnoteAlignment = preservation.sourceBlocksForNodeCount(missingFootnoteMapped.blocks, initialFootnoteNodes.length);
  assert.ok(initialFootnoteAlignment, "initial PM baseline drops only the explicitly synthetic trailing block");
  assert.equal(initialFootnoteAlignment.blocks.length, 3);
  assert.equal(initialFootnoteAlignment.syntheticTailOmitted, true);
  assert.strictEqual(initialFootnoteAlignment.blocks[2], missingFootnoteMapped.blocks[2], "generated footnote zero-width block remains mapped");
  const firstChangedTail = {};
  const firstTrailingParagraph = {};
  const firstTransactionNodes = [initialFootnoteNodes[0], firstChangedTail, initialFootnoteNodes[2], firstTrailingParagraph];
  const firstSnapshotMarkdown = preservation.combinePreservedSourceBlocks(
    initialFootnoteNodes,
    initialFootnoteAlignment.blocks,
    firstTransactionNodes,
    ["正文[^missing]", "尾部改", "", ""],
    missingFootnoteMapped.prefix,
    "\n",
    initialFootnoteAlignment.syntheticTailOmitted,
  );
  assert.equal(firstSnapshotMarkdown, "正文[^missing]\n\n尾部改\n", "first transaction preserves missing-footnote source ranges");
  const recapturedAlignment = preservation.sourceBlocksForNodeCount(
    markdown.markdownTopLevelSourceBlocks(firstSnapshotMarkdown).blocks,
    firstTransactionNodes.length,
  );
  assert.ok(recapturedAlignment && recapturedAlignment.blocks.length === 4, "snapshot recaptures the complete trailing baseline");
  assert.equal(recapturedAlignment.syntheticTailOmitted, false);
  const secondChangedTail = {};
  const secondSnapshotMarkdown = preservation.combinePreservedSourceBlocks(
    firstTransactionNodes,
    recapturedAlignment.blocks,
    [initialFootnoteNodes[0], secondChangedTail, initialFootnoteNodes[2], firstTrailingParagraph],
    ["正文[^missing]", "尾部再改", "", ""],
    missingFootnoteMapped.prefix,
    "\n",
  );
  assert.equal(secondSnapshotMarkdown, "正文[^missing]\n\n尾部再改\n", "second edit uses the recaptured complete baseline");

  const noTerminalFootnoteSource = "正文[^missing]\n\n尾部";
  const noTerminalFootnoteMapped = markdown.markdownTopLevelSourceBlocks(noTerminalFootnoteSource);
  const noTerminalFootnoteNodes = noTerminalFootnoteMapped.blocks.slice(0, 3).map(() => ({}));
  const noTerminalFootnoteAlignment = preservation.sourceBlocksForNodeCount(
    noTerminalFootnoteMapped.blocks,
    noTerminalFootnoteNodes.length,
  );
  assert.ok(noTerminalFootnoteAlignment);
  assert.equal(noTerminalFootnoteAlignment.syntheticTailOmitted, true);
  const noTerminalFirstChangedTail = {};
  const noTerminalTrailingParagraph = {};
  const noTerminalFirstNodes = [noTerminalFootnoteNodes[0], noTerminalFirstChangedTail, noTerminalFootnoteNodes[2], noTerminalTrailingParagraph];
  assert.equal(
    preservation.combinePreservedSourceBlocks(
      noTerminalFootnoteNodes,
      noTerminalFootnoteAlignment.blocks,
      noTerminalFirstNodes,
      ["正文[^missing]", "尾部改", "", ""],
      noTerminalFootnoteMapped.prefix,
      "\n",
      noTerminalFootnoteAlignment.syntheticTailOmitted,
    ),
    "正文[^missing]\n\n尾部改",
    "missing footnote without terminal newline does not gain a separator",
  );
  const noTerminalRecapturedAlignment = preservation.sourceBlocksForNodeCount(
    markdown.markdownTopLevelSourceBlocks("正文[^missing]\n\n尾部改").blocks,
    noTerminalFirstNodes.length,
  );
  assert.ok(noTerminalRecapturedAlignment && noTerminalRecapturedAlignment.blocks.length === 4);
  assert.equal(noTerminalRecapturedAlignment.syntheticTailOmitted, false);
  assert.equal(
    preservation.combinePreservedSourceBlocks(
      noTerminalFirstNodes,
      noTerminalRecapturedAlignment.blocks,
      [noTerminalFootnoteNodes[0], {}, noTerminalFootnoteNodes[2], noTerminalTrailingParagraph],
      ["正文[^missing]", "尾部再改", "", ""],
      noTerminalFootnoteMapped.prefix,
      "\n",
    ),
    "正文[^missing]\n\n尾部再改",
    "recaptured no-terminal missing-footnote baseline remains exact on the second edit",
  );

  const FrontMatterProbeNode = TiptapNode.create({ name: "frontMatter", group: "block", atom: true });
  const BlockMathProbeNode = TiptapNode.create({ name: "blockMath", group: "block", atom: true });
  const MermaidProbeNode = TiptapNode.create({ name: "mermaid", group: "block", atom: true });
  const specialSchema = getSchema([starterKit, FrontMatterProbeNode, BlockMathProbeNode, MermaidProbeNode]);
  const specialCases = [
    ["---\ntitle: Audit\n---\n\nabc\n", "frontMatter"],
    ["$$\nx+y\n$$\n\nabc\n", "blockMath"],
    ["```mermaid\ngraph TD\n A-->B\n```\n\nabc\n", "mermaid"],
  ];
  for (const [source, specialType] of specialCases) {
    const mapped = markdown.markdownTopLevelSourceBlocks(source);
    const specialState = EditorState.create({
      schema: specialSchema,
      doc: specialSchema.nodes.doc.create(null, [specialSchema.nodes[specialType].create(), specialSchema.nodes.paragraph.create(null, specialSchema.text("abc"))]),
      plugins: [],
    });
    assert.equal(specialState.doc.childCount, mapped.blocks.length, `${specialType} maps to the real PM top-level count`);
  }

  const insertionSource = "$$\nx\n$$\n\nabc\n";
  const insertionMapped = markdown.markdownTopLevelSourceBlocks(insertionSource);
  const insertionNodes = insertionMapped.blocks.map(() => ({}));
  const insertedBefore = {};
  assert.equal(
    preservation.combinePreservedSourceBlocks(
      insertionNodes,
      insertionMapped.blocks,
      [insertedBefore, insertionNodes[0], insertionNodes[1]],
      ["before", insertionMapped.blocks[0].source, insertionMapped.blocks[1].source],
      insertionMapped.prefix,
      "\n",
    ),
    "before\n\n$$\nx\n$$\n\nabc\n",
    "inserting before a special block preserves both source blocks",
  );

  const pipelineFixtures = [
    "[TOC]\n\n# 标题🚀\n\n正文\n\n后段\n",
    "```js\nconst value = `[^not-a-footnote]`;\n```\n\nafter\n",
    "$$\r\nx+\u2728\r\n$$\r\n\r\nafter\r\n",
    "```mermaid\r\ngraph TD\r\n A-->B\r\n```\r\n\r\nafter\r\n",
    "正文[^a]\n\n[^a]: 注释😀\n\n尾部\n",
    "正文[^missing]\n\n尾部\n",
    "正文[^a]\r\n\r\n[^a]: 注释\r\n\r\n尾部\r\n",
    "<section>\n<div>HTML😀</div>\n</section>\n\nafter\n",
    "<section>\r\n<div>HTML😀</div>\r\n</section>\r\n\r\nafter\r\n",
    "before <span>inline</span> and <raw>value</raw>\n\nafter\n",
    "`inline 😀`\n\ntext\n",
    "- [x] 已完成\n\ntext\n",
    "term\n: definition\n\nafter\n",
    "escaped \\$ and $x$\n\nafter\n",
    "\uFEFF中文😀\r\n\r\n尾部\r\n",
  ];
  for (const source of pipelineFixtures) {
    const mapped = markdown.markdownTopLevelSourceBlocks(source);
    const originalNodes = mapped.blocks.map(() => ({}));
    const roundTrip = preservation.combinePreservedSourceBlocks(
      originalNodes,
      mapped.blocks,
      originalNodes,
      mapped.blocks.map((block) => block.source),
      mapped.prefix,
      lineEndingOf(source),
    );
    assert.equal(roundTrip, source, `pipeline no-op round trip: ${JSON.stringify(source)}`);
  }

  const tailMutationFixtures = [
    {
      name: "TOC tail edit",
      source: "[TOC]\n\n# 标题🚀\n\n正文\n\n后段\n",
      replacement: "后改",
      expected: "[TOC]\n\n# 标题🚀\n\n正文\n\n后改\n",
    },
    {
      name: "fence tail edit",
      source: "```js\nconst value = `[^not-a-footnote]`;\n```\n\nafter\n",
      replacement: "later",
      expected: "```js\nconst value = `[^not-a-footnote]`;\n```\n\nlater\n",
    },
    {
      name: "missing footnote tail edit",
      source: "正文[^missing]\n\n尾部\n",
      replacement: "尾改",
      expected: "正文[^missing]\n\n尾改\n",
    },
    {
      name: "HTML tail edit",
      source: "<section>\n<div>HTML😀</div>\n</section>\n\nafter\n",
      replacement: "later",
      expected: "<section>\n<div>HTML😀</div>\n</section>\n\nlater\n",
    },
    {
      name: "CRLF HTML tail edit",
      source: "<section>\r\n<div>HTML😀</div>\r\n</section>\r\n\r\nafter\r\n",
      replacement: "later",
      expected: "<section>\r\n<div>HTML😀</div>\r\n</section>\r\n\r\nlater\r\n",
    },
    {
      name: "inline code tail edit",
      source: "`inline 😀`\n\ntext\n",
      replacement: "changed",
      expected: "`inline 😀`\n\nchanged\n",
    },
    {
      name: "task tail edit",
      source: "- [x] 已完成\n\ntext\n",
      replacement: "changed",
      expected: "- [x] 已完成\n\nchanged\n",
    },
    {
      name: "definition tail edit",
      source: "term\n: definition\n\nafter\n",
      replacement: "later",
      expected: "term\n: definition\n\nlater\n",
    },
    {
      name: "escaped dollar and math tail edit",
      source: "escaped \\$ and $x$\n\nafter\n",
      replacement: "later",
      expected: "escaped \\$ and $x$\n\nlater\n",
    },
    {
      name: "BOM Chinese emoji tail edit",
      source: "\uFEFF中文😀\r\n\r\n尾部\r\n",
      replacement: "尾改",
      expected: "\uFEFF中文😀\r\n\r\n尾改\r\n",
    },
  ];
  for (const fixture of tailMutationFixtures) {
    const mapped = markdown.markdownTopLevelSourceBlocks(fixture.source);
    assert.ok(mapped.blocks.length >= 2, `${fixture.name}: expected a separate tail block`);
    const targetIndex = mapped.blocks.findLastIndex((block) => block.source.length > 0);
    assert.notEqual(targetIndex, -1, `${fixture.name}: expected a non-empty source block`);
    assert.equal(
      replaceBlock(fixture.source, targetIndex, fixture.replacement),
      fixture.expected,
      fixture.name,
    );
  }

  for (const count of [100, 1000, 5000]) {
    const source = Array.from({ length: count }, (_item, index) => `paragraph ${index} $x_${index}$`).join("\n\n") + "\n";
    const samples = [];
    let rawBlocks = 0;
    for (let sample = 0; sample < 3; sample += 1) {
      const started = performance.now();
      const mapped = markdown.markdownTopLevelSourceBlocks(source);
      samples.push(Number((performance.now() - started).toFixed(1)));
      rawBlocks = mapped.blocks.length;
    }
    console.log(`provenance diagnostic atoms=${count} samplesMs=${JSON.stringify(samples)} rawBlocks=${rawBlocks}`);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("source special-block checks passed");
