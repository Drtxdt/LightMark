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
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("WYSIWYG incremental derived-state checks passed (500 deterministic transactions)");
