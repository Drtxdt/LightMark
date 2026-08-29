import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-wysiwyg-find-"));
fs.mkdirSync(path.join(tempDir, "editor"));
fs.mkdirSync(path.join(tempDir, "utils"));

const transpile = (source, destination, rewrites = []) => {
  let output = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  for (const [from, to] of rewrites) output = output.replaceAll(from, to);
  fs.writeFileSync(destination, output);
};

try {
  transpile(path.join(root, "src", "utils", "findReplace.ts"), path.join(tempDir, "utils", "findReplace.mjs"));
  transpile(
    path.join(root, "src", "editor", "wysiwygFind.ts"),
    path.join(tempDir, "editor", "wysiwygFind.mjs"),
    [["../utils/findReplace", "../utils/findReplace.mjs"]],
  );
  const findModule = await import(pathToFileURL(path.join(tempDir, "editor", "wysiwygFind.mjs")).href);
  const { findTextMatches } = await import(pathToFileURL(path.join(tempDir, "utils", "findReplace.mjs")).href);
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*" },
      heading: { group: "block", content: "text*", attrs: { level: { default: 1 } } },
      text: { group: "inline" },
    },
  });
  const paragraph = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
  let state = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, Array.from({ length: 120 }, (_, index) => paragraph(`needle block ${index} needle`))),
    plugins: [findModule.createWysiwygFindPlugin({ active: () => true, currentIndex: () => 0 })],
  });
  const query = { search: "needle", caseSensitive: false, wholeWord: true, regex: false };
  state = state.apply(findModule.setWysiwygFindQuery(state, query));

  const verify = () => {
    const actual = findModule.getWysiwygFindState(state);
    const expected = [];
    state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      for (const match of findTextMatches(node.textContent, query.search, query).matches) {
        expected.push([pos + 1 + match.from, pos + 1 + match.to]);
      }
      return false;
    });
    assert.deepEqual(actual.items.map((item) => [item.docFrom, item.docTo]), expected);
  };

  verify();
  let seed = 0x1f2e3d4c;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const textNodes = [];
    state.doc.descendants((node, pos) => { if (node.isText) textNodes.push({ from: pos, to: pos + node.nodeSize }); });
    const target = textNodes[Math.floor(random() * textNodes.length)];
    const position = target.from + Math.floor(random() * (target.to - target.from + 1));
    const insert = iteration % 11 === 0 ? " needle " : "x";
    state = state.apply(state.tr.insertText(insert, position));
    verify();
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("WYSIWYG incremental find checks passed (300 deterministic transactions)");
