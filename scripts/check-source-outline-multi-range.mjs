import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { Text, ChangeSet } from '@codemirror/state';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-source-multi-'));
try {
  fs.mkdirSync(path.join(temp, 'editor')); fs.mkdirSync(path.join(temp, 'utils'));
  function compile(source, destination, rewrites) {
    let value = ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    for (const [before, after] of rewrites) value = value.replaceAll(before, after);
    fs.writeFileSync(destination, value);
  }
  compile('src/utils/outline.ts', path.join(temp, 'utils/outline.mjs'), []);
  compile('src/editor/sourceOutlineIndex.ts', path.join(temp, 'editor/sourceOutlineIndex.mjs'), [['../utils/outline', '../utils/outline.mjs']]);
  compile('src/editor/sourceOutlineChanges.ts', path.join(temp, 'editor/sourceOutlineChanges.mjs'), [['./sourceOutlineIndex', './sourceOutlineIndex.mjs']]);
  const { buildSourceOutlineIndex, updateSourceOutlineIndex } = await import(pathToFileURL(path.join(temp, 'editor/sourceOutlineIndex.mjs')));
  const { updateSourceOutlineChanges, sourceOutlineChangeDiagnostics } = await import(pathToFileURL(path.join(temp, 'editor/sourceOutlineChanges.mjs')));
  const large = Text.of(Array.from({ length: 50_000 }, (_, i) => i % 100 === 0 ? `# Heading ${i}` : `plain line ${i}`));
  const baseline = buildSourceOutlineIndex(large);
  const farChanges = ChangeSet.of([{ from: 1, insert: '\n' }, { from: large.length - 1, insert: 'Z' }], large.length);
  const farNext = farChanges.apply(large);
  let oldReads = 0;
  const oldObserved = new Proxy(farNext, { get(target, key) {
    if (key === 'line') return number => { oldReads++; return target.line(number); };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const aggregated = updateSourceOutlineIndex(baseline, large, oldObserved, 1, 1, farNext.length - 1);
  assert.deepEqual(aggregated.items, buildSourceOutlineIndex(farNext).items);
  assert.ok(oldReads > 49_000, `production min..max baseline unexpectedly read ${oldReads} lines`);
  console.log(JSON.stringify({ productionAggregatedActualLineReads: oldReads }));
  for (const edits of [
    [{ from: 1, insert: '\n' }, { from: large.length - 1, insert: 'Z' }],
    [{ from: large.line(3).to, to: large.line(4).from, insert: '' }, { from: large.line(49_990).from, insert: '\n\n' }],
    [{ from: 1, insert: 'x' }, { from: large.line(25_000).from, insert: '\n# middle\n' }, { from: large.length - 1, insert: 'Z' }],
  ]) {
    const changes = ChangeSet.of(edits, large.length);
    const next = changes.apply(large);
    const result = updateSourceOutlineChanges(baseline, large, changes, next);
    assert.deepEqual(sourceOutlineChangeDiagnostics(next), { lineReads: result.lineReads, changedRanges: edits.length }, 'counter belongs to the published CM root');
    assert.deepEqual(result.index.rawItems, buildSourceOutlineIndex(next).rawItems);
    assert.deepEqual(result.index.items, buildSourceOutlineIndex(next).items);
    assert.ok(result.lineReads < 1040, `distant changes read ${result.lineReads} actual lines`);
    console.log(JSON.stringify({ edits: edits.length, actualLineReads: result.lineReads, totalLines: next.lines }));
  }
  let doc = Text.of(Array.from({ length: 1000 }, (_, i) => i % 13 === 0 ? '# title' : i % 17 === 0 ? '```' : 'text').join('\n').split('\n'));
  let index = buildSourceOutlineIndex(doc), seed = 0x614ced;
  const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32;
  for (let i = 0; i < 150; i++) {
    const points = [Math.floor(random() * doc.length / 3), Math.floor(doc.length * (0.66 + random() * 0.33))];
    const edits = points.map((from, j) => ({ from, to: Math.min(doc.length, from + (i % 4 === 0 ? 1 : 0)), insert: i % 7 === 0 ? '\n```\n' : i % 5 === 0 ? '\n# new\n' : j ? 'z' : '\n' }));
    const changes = ChangeSet.of(edits, doc.length), next = changes.apply(doc);
    const result = updateSourceOutlineChanges(index, doc, changes);
    assert.deepEqual(result.index.rawItems, buildSourceOutlineIndex(next).rawItems, `random multi-range ${i}`);
    index = result.index; doc = next;
  }
  console.log('Production Source multi-range outline: 50k distant ranges and 150 mixed parser-state updates equal full rebuild with bounded actual line reads.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

