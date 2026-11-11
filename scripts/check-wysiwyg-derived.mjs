import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-wysiwyg-derived-"));
const tempPath = path.join(tempDir, "wysiwygDerived.mjs");

try {
  fs.mkdirSync(path.join(tempDir, "utils"));
  fs.writeFileSync(path.join(tempDir, "utils", "outline.mjs"), ts.transpileModule(
    fs.readFileSync(path.join(root, "src", "utils", "outline.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false } },
  ).outputText);
  const source = fs.readFileSync(path.join(root, "src", "editor", "wysiwygDerived.ts"), "utf8");
  fs.writeFileSync(tempPath, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText.replaceAll("../utils/outline", "./utils/outline.mjs"));
  const { createWysiwygDerivedPlugin, getWysiwygDerivedState } = await import(pathToFileURL(tempPath).href);
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*" },
      heading: { group: "block", content: "text*", attrs: { level: { default: 1 } } },
      text: { group: "inline" },
    },
    marks: { bold: {} },
  });
  const paragraph = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
  const heading = (level, text) => schema.nodes.heading.create({ level }, schema.text(text));
  let state = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [heading(1, "Root"), paragraph("alpha beta"), heading(2, "Child"), paragraph("正文 line")]),
    plugins: [createWysiwygDerivedPlugin()],
  });

  let seed = 0x51f15e;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000);
  const verify = () => {
    const actual = getWysiwygDerivedState(state);
    const blocks = [];
    state.doc.forEach((node, pos) => {
      const text = node.textContent;
      blocks.push({ node, pos, words: text.trim() ? text.trim().split(/\s+/).length : 0, chars: text.length, lines: Math.max(1, text.split(/\r?\n/).length) });
    });
    assert.deepEqual(actual.blocks.map((item) => [item.pos, item.node.textContent]), blocks.map((item) => [item.pos, item.node.textContent]));
    assert.equal(actual.words, blocks.reduce((sum, item) => sum + item.words, 0));
    assert.equal(actual.chars, blocks.reduce((sum, item) => sum + item.chars, 0));
    assert.equal(actual.lines, blocks.reduce((sum, item) => sum + item.lines, 0));
    assert.deepEqual(actual.headings.map((item) => [item.pos, item.level, item.text]), blocks.filter((item) => item.node.type.name === "heading").map((item) => [item.pos, item.node.attrs.level, item.node.textContent]));
    assert.deepEqual(actual.outline.map((item) => [item.text, item.level]), blocks.filter((item) => item.node.type.name === "heading").map((item) => [item.node.textContent, item.node.attrs.level]));
    for (let pos = 0; pos <= state.doc.content.size; pos += Math.max(1, Math.floor(state.doc.content.size / 11))) {
      const expected = actual.headings.map((heading, index) => ({ heading, index })).filter(item => item.heading.pos <= pos).at(-1) ?? null;
      const found = actual.headingBefore(pos);
      assert.deepEqual(found && [found.index, found.heading.pos, found.heading.text], expected && [expected.index, expected.heading.pos, expected.heading.text]);
    }
  };

  verify();
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const textPositions = [];
    state.doc.descendants((node, pos) => { if (node.isText) textPositions.push({ from: pos, to: pos + node.nodeSize }); });
    const target = textPositions[Math.floor(random() * textPositions.length)];
    const position = target.from + Math.floor(random() * (target.to - target.from + 1));
    let transaction = state.tr;
    if (random() < 0.35 && position < target.to) transaction = transaction.delete(position, Math.min(target.to, position + 1));
    else transaction = transaction.insertText(iteration % 7 === 0 ? " 字" : "x", position);
    state = state.apply(transaction);
    assert.ok(getWysiwygDerivedState(state).recomputedBlocks <= 3, "single-block edit must not recompute the whole document");
    verify();
  }

  state = state.apply(state.tr.insert(state.doc.content.size, heading(3, "Inserted")));
  verify();
  const first = state.doc.child(0);
  state = state.apply(state.tr.delete(0, first.nodeSize));
  verify();
  const replacement = schema.nodes.doc.create(null, [heading(1, "Replacement"), paragraph("one two three")]);
  state = state.apply(state.tr.replaceWith(0, state.doc.content.size, replacement.content));
  verify();

  // Structural and multi-step changes are indexed in each step's own coordinates.
  state = state.apply(state.tr.split(4));
  verify();
  state = state.apply(state.tr.join(state.doc.child(0).nodeSize));
  verify();
  state = state.apply(state.tr.insertText('head ', 1).insertText(' tail', state.doc.content.size - 1 + 5));
  verify();
  state = state.apply(state.tr.setNodeMarkup(0, schema.nodes.heading, { level: 4 }));
  verify();
  state = state.apply(state.tr.addMark(1, 3, schema.marks.bold.create()));
  verify();
  for (let iteration = 0; iteration < 300; iteration++) {
    const index = Math.floor(random() * state.doc.childCount);
    let pos = 0;
    for (let before = 0; before < index; before++) pos += state.doc.child(before).nodeSize;
    const node = state.doc.child(index);
    let transaction;
    switch (iteration % 5) {
      case 0: transaction = state.tr.insert(pos, paragraph(`inserted ${iteration}`)); break;
      case 1: transaction = state.tr.split(pos + 1 + Math.floor(node.content.size / 2)); break;
      case 2: transaction = index + 1 < state.doc.childCount ? state.tr.join(pos + node.nodeSize) : state.tr.insertText('x', pos + 1); break;
      case 3: transaction = state.tr.setNodeMarkup(pos, schema.nodes.heading, { level: iteration % 6 + 1 }); break;
      default: transaction = state.doc.childCount > 1 ? state.tr.delete(pos, pos + node.nodeSize) : state.tr.insert(pos, paragraph('keep document nonempty'));
    }
    state = state.apply(transaction);
    verify();
  }

  const repeated = paragraph('shared identity');
  state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [repeated, repeated, repeated]), plugins: [createWysiwygDerivedPlugin()] });
  state = state.apply(state.tr.insertText('x', 1));
  verify();

  const largeCount = 50_000;
  state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, Array.from({ length: largeCount }, (_, index) => paragraph(`row ${index}`))), plugins: [createWysiwygDerivedPlugin()] });
  const observations = [];
  for (const at of [1, state.doc.content.size - 1, Math.floor(state.doc.content.size / 2)]) {
    const start = performance.now();
    state = state.apply(state.tr.insertText('x', at));
    const actual = getWysiwygDerivedState(state);
    observations.push({ indexVisits: actual.indexVisits, blockVisits: actual.blockVisits, synchronousModelMs: performance.now() - start });
    assert.ok(actual.blockVisits <= 3, '50k paragraph text edit must read at most three block payloads');
    assert.ok(actual.indexVisits < 320, `50k paragraph index edit visited ${actual.indexVisits} tree nodes`);
    assert.equal(actual.materializedBlocks, 0, 'a content update must not materialize the block array');
    assert.equal(actual.materializedHeadings, 0, 'a content update must not materialize the heading array');
    assert.equal(actual.headingBefore(at), null);
    assert.equal(actual.blocks.length, largeCount);
    verify();
  }
  state = state.apply(state.tr.split(2));
  let actual = getWysiwygDerivedState(state);
  assert.ok(actual.blockVisits <= 4);
  assert.ok(actual.indexVisits < 320);
  verify();
  for (let iteration = 0; iteration < 30; iteration++) {
    const start = performance.now();
    state = state.apply(state.tr.insertText('x', 1));
    const update = getWysiwygDerivedState(state);
    observations.push({ indexVisits: update.indexVisits, blockVisits: update.blockVisits, synchronousModelMs: performance.now() - start });
    assert.ok(update.indexVisits < 320);
    assert.ok(update.blockVisits <= 3);
    assert.equal(update.materializedBlocks, 0);
    assert.equal(update.materializedHeadings, 0);
  }
  // A heading-heavy document must support selection lookup without realizing all headings.
  state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, Array.from({ length: largeCount }, (_, index) => heading(index % 6 + 1, `H ${index}`))), plugins: [createWysiwygDerivedPlugin()] });
  state = state.apply(state.tr.insertText('x', 1));
  actual = getWysiwygDerivedState(state);
  const active = actual.headingBefore(state.doc.content.size - 1);
  assert.equal(active.index, largeCount - 1);
  assert.equal(active.heading.text, `H ${largeCount - 1}`);
  assert.equal(actual.materializedHeadings, 0);
  assert.equal(actual.materializedBlocks, 0);
  assert.ok(actual.indexVisits < 400);
  console.log(`50k derived-index actual access counts (model time is not paint time): ${JSON.stringify(observations)}`);
  const elapsed = observations.map(item => item.synchronousModelMs).sort((left, right) => left - right);
  console.log(`50k derived synchronous-model timing (33 samples; DOM/paint not measured): ${JSON.stringify({ p50: elapsed[Math.ceil(elapsed.length * .5) - 1], p95: elapsed[Math.ceil(elapsed.length * .95) - 1], max: elapsed.at(-1), maxIndexVisits: Math.max(...observations.map(item => item.indexVisits)), maxBlockVisits: Math.max(...observations.map(item => item.blockVisits)) })}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("WYSIWYG derived-state checks passed: 500 text edits, 300 structural edits, repeated identities, and 50k paragraph/heading fixtures.");
