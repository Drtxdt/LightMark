import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { Text } from "@codemirror/state";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-source-outline-"));
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
  transpile(path.join(root, "src", "utils", "outline.ts"), path.join(tempDir, "utils", "outline.mjs"));
  transpile(
    path.join(root, "src", "editor", "sourceOutlineIndex.ts"),
    path.join(tempDir, "editor", "sourceOutlineIndex.mjs"),
    [["../utils/outline", "../utils/outline.mjs"]],
  );
  const { buildSourceOutlineIndex, sourceContextAtLine, updateSourceOutlineIndex } = await import(pathToFileURL(path.join(tempDir, "editor", "sourceOutlineIndex.mjs")).href);
  const toText = (value) => Text.of(value.split("\n"));
  const unit = [
    "# Root", "paragraph", "```ts", "# protected", "```", "$$", "## math protected", "$$",
    "## Child", "body", "<div>", "### html protected", "</div>", "### Visible", "tail",
  ].join("\n");
  let markdown = Array.from({ length: 80 }, (_, index) => `${unit}\n## Group ${index}\ntext`).join("\n");
  let doc = toText(markdown);
  let index = buildSourceOutlineIndex(doc);
  assert.equal(sourceContextAtLine(index, doc, 4).fence, true, "fenced context must be resolved from checkpoints");
  assert.equal(sourceContextAtLine(index, doc, 6).fence, false, "closing fence must clear fenced context");
  assert.equal(sourceContextAtLine(index, doc, 8).mathBlock, false, "closing math delimiter must clear math context");
  let seed = 0xc0ffee;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000);

  for (let iteration = 0; iteration < 300; iteration += 1) {
    const from = Math.floor(random() * (markdown.length + 1));
    const remove = random() < 0.35 ? Math.min(markdown.length - from, Math.floor(random() * 5)) : 0;
    const insert = iteration % 23 === 0 ? `\n${1 + iteration % 6 === 1 ? "#" : "##"} inserted-${iteration}\n` : (iteration % 7 === 0 ? "\n" : "x");
    const nextMarkdown = `${markdown.slice(0, from)}${insert}${markdown.slice(from + remove)}`;
    const nextDoc = toText(nextMarkdown);
    index = updateSourceOutlineIndex(index, doc, nextDoc, from, from, from + insert.length);
    const oracle = buildSourceOutlineIndex(nextDoc);
    assert.deepEqual(index.rawItems, oracle.rawItems, `raw outline mismatch after transaction ${iteration}`);
    assert.deepEqual(index.items, oracle.items, `structured outline mismatch after transaction ${iteration}`);
    markdown = nextMarkdown;
    doc = nextDoc;
  }

  // A newline changes checkpoint positions without changing parser state.
  // Count actual line reads, rather than accepting a small recompute counter.
  const large = Text.of(Array.from({ length: 50_000 }, (_, i) => i % 100 === 0 ? `# Heading ${i}` : 'ordinary text'));
  const initial = buildSourceOutlineIndex(large);
  for (const insert of ['x', '\n', '\n\n']) {
    const at = large.line(3).from;
    const next = large.replace(at, at, Text.of(insert.split('\n')));
    let reads = 0;
    const counted = new Proxy(next, { get(target, key) {
      if (key === 'line') return (...args) => { reads++; return target.line(...args); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const actual = updateSourceOutlineIndex(initial, large, counted, at, at, at + insert.length);
    assert.deepEqual(actual.items, buildSourceOutlineIndex(next).items);
    assert.ok(reads <= 520, `head edit ${JSON.stringify(insert)} read ${reads} lines`);
  }
  const deletionAt = large.line(3).to;
  const deleted = large.replace(deletionAt, deletionAt + 1, Text.empty);
  const afterDeletion = updateSourceOutlineIndex(initial, large, deleted, deletionAt, deletionAt, deletionAt);
  assert.deepEqual(afterDeletion.items, buildSourceOutlineIndex(deleted).items);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("CodeMirror checkpoint outline checks passed (300 deterministic transactions)");
