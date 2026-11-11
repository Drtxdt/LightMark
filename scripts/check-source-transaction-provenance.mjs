import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-source-transaction-'));
const load = file => import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve(file), temp)).href);
try {
  const provenance = await load('src/editor/sourceTransactionProvenance.ts');
  const { createMarkdownPositionMap, pmPositionToSource } = await load('src/editor/markdownPositionMap.ts');
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' }, text: { group: 'inline' },
    inlineMath: { inline: true, group: 'inline', atom: true, attrs: { tex: {} } },
  }, marks: { bold: {}, link: { attrs: { href: {} } } } });
  const paragraph = schema.nodes.paragraph.create(null, [schema.text('alpha', [schema.marks.bold.create()]), schema.text(' '),
    schema.nodes.inlineMath.create({ tex: 'x' }), schema.text(' '), schema.text('link', [schema.marks.link.create({ href: 'same.png' })]), schema.text(' omega')]);
  let state = EditorState.create({ doc: schema.nodes.doc.create(null, paragraph) });
  const original = '__alpha__  $x$   [link](same.png "title")   omega\r\n';
  const initial = state.doc.firstChild;
  const transaction = change => {
    const tr = change(state.tr); provenance.recordSourceTransactionProvenance(state.doc, tr.doc, tr); state = state.apply(tr); return tr;
  };
  const initialCost = provenance.sourceProvenanceDiagnostics();
  transaction(tr => tr.insertText('X', 3));
  transaction(tr => tr.insertText('Y', state.doc.content.size - 2));
  const snapshot = provenance.sourceProvenanceDiagnostics();
  assert.equal(snapshot.materializations, initialCost.materializations, 'input records immutable model edges without materializing source');
  assert.equal(snapshot.blocks - initialCost.blocks, 2);
  let replays = 0;
  const preserveOneTextChange = (source, before, after) => {
    replays++;
    const from = before.content.findDiffStart(after.content), end = before.content.findDiffEnd(after.content);
    if (from == null) return source;
    const to = Math.max(from, end.a), afterTo = Math.max(from, end.b);
    const map = createMarkdownPositionMap(source, schema.nodes.doc.create(null, before));
    const rawFrom = pmPositionToSource(map, from + 1), rawTo = to === from ? rawFrom : pmPositionToSource(map, to + 1, -1);
    const inserted = after.content.cut(from, afterTo).textBetween(0, afterTo - from);
    return source.slice(0, rawFrom) + inserted + source.slice(rawTo);
  };
  const exact = provenance.preserveSourceTransactionProvenance(original, initial, state.doc.firstChild, preserveOneTextChange);
  assert.equal(exact, original.replace('alpha', 'alXpha').replace('omega', 'omegYa'));
  assert.equal(replays, 2, 'distant edits are replayed separately across the unchanged math/link syntax');
  assert.equal(provenance.sourceProvenanceDiagnostics().piecePatches - initialCost.piecePatches, 2);
  provenance.checkpointSourceTransactionNode(state.doc.firstChild, exact);
  assert.equal(provenance.preserveSourceTransactionProvenance(original, initial, state.doc.firstChild, () => assert.fail('checkpoint must retain its exact raw block')), exact);

  // One command can contain multiple distant steps; replay keeps the intermediate roots.
  const beforeCommand = state.doc.firstChild;
  transaction(tr => tr.insertText('😀', 3).insertText('Z', tr.doc.content.size - 2));
  const commanded = provenance.preserveSourceTransactionProvenance(exact, beforeCommand, state.doc.firstChild, preserveOneTextChange);
  assert.ok(commanded.includes('😀'));
  assert.ok(commanded.includes('[link](same.png "title")'));
  assert.ok(commanded.endsWith('gYZa\r\n'));

  // Unknown ancestry is a typed safe miss, never a model diff guessing identity.
  const unrelated = schema.nodes.paragraph.create(null, schema.text('unrelated'));
  assert.equal(provenance.preserveSourceTransactionProvenance(original, initial, unrelated, () => assert.fail('no proven edge')), null);
  const beforeUndo = state.doc;
  const undo = state.tr.replaceWith(0, state.doc.content.size, paragraph);
  provenance.recordSourceTransactionProvenance(beforeUndo, undo.doc, undo);
  assert.equal(provenance.preserveSourceTransactionProvenance(original, initial, undo.doc.firstChild, () => assert.fail('same original root')), original, 'undo to an existing root never creates a provenance cycle');
  let bounded = EditorState.create({ doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('a'))) });
  const boundedStart = bounded.doc.firstChild;
  provenance.checkpointSourceTransactionNode(boundedStart, 'a');
  for (let index = 0; index < 300; index++) {
    const tr = bounded.tr.insertText('x', bounded.doc.content.size - 1);
    provenance.recordSourceTransactionProvenance(bounded.doc, tr.doc, tr); bounded = bounded.apply(tr);
  }
  assert.ok(provenance.sourceProvenanceDepth(bounded.doc.firstChild) >= 256);
  assert.ok(provenance.compactSourceTransactionProvenance(bounded.doc.firstChild, (_raw, _before, after) => after.textContent));
  assert.equal(provenance.sourceProvenanceDepth(bounded.doc.firstChild), 0, 'a block checkpoint cuts pending ancestry before the safety limit');
  const overflowStart = bounded.doc.firstChild;
  for (let index = 0; index < 4097; index++) {
    const tr = bounded.tr.insertText('x', bounded.doc.content.size - 1);
    provenance.recordSourceTransactionProvenance(bounded.doc, tr.doc, tr); bounded = bounded.apply(tr);
  }
  assert.throws(() => provenance.preserveSourceTransactionProvenance(overflowStart.textContent, overflowStart, bounded.doc.firstChild, () => assert.fail('overflow may not normalize source')), error => error instanceof provenance.SourceProvenanceUnavailableError && /阻止覆盖/.test(error.message));
  console.log('Source transaction provenance: no text on input, real multi-step edges, marks/math/link bytes, persistent pieces, checkpoint and undo identity passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
