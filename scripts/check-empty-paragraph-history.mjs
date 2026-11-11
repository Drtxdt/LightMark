import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-empty-history-'));
try {
  const { captureWysiwygSourceBaseline } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/wysiwygCodec.ts'), temp)).href);
  const { combinePreservedSourceBlocks, sourceBlocksForNodes } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/sourcePreservation.ts'), temp)).href);
  const { historyPmDocumentForSchema } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/historySource.ts'), temp)).href);
  const { WysiwygSnapshotCache } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/wysiwygSnapshot.ts'), temp)).href);
  const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} } });
  for (const source of ['\uFEFF', '\uFEFF\n', '\uFEFF\r', '\uFEFF\r\n\r\n', '\uFEFF \t', '\uFEFF \t\n\r\n\r']) {
    const paragraph = schema.nodes.paragraph.create();
    const blank = captureWysiwygSourceBaseline(source, schema.nodes.doc.create(null, [paragraph]));
    assert.equal(blank.aligned, true, 'BOM-only and BOM/whitespace-only documents retain an empty paragraph source anchor');
    assert.equal(blank.prefix + blank.blocks.map(block => block.source + block.separator).join(''), source);
    const typed = schema.nodes.paragraph.create(null, schema.text('typed'));
    const updated = combinePreservedSourceBlocks(blank.nodes, blank.blocks, [typed], ['typed'], blank.prefix, blank.lineEnding, blank.syntheticTailOmitted);
    assert.equal(updated, '\uFEFFtyped' + (source.match(/[\r\n]+$/)?.[0] ?? ''), 'typing preserves the BOM and exact terminal EOL envelope');
    const replay = captureWysiwygSourceBaseline(updated, schema.nodes.doc.create(null, [typed]));
    assert.equal(replay.aligned, true);
    assert.equal(replay.prefix + replay.blocks.map(block => block.source + block.separator).join(''), updated);
  }
  const adjacent = sourceBlocksForNodes([{ source: '<!-- sentinel -->', separator: '\n'.repeat(201) }, { source: '# heading', separator: '' }],
    [{ type: { name: 'paragraph' }, content: { size: 1 } }, ...Array.from({ length: 100 }, () => ({ type: { name: 'paragraph' }, content: { size: 0 } })), { type: { name: 'heading' }, content: { size: 7 } }], '');
  assert.equal(adjacent.blocks[0].separator, '\n', 'an existing single-EOL comment/heading boundary must keep its exact width');
  assert.ok(adjacent.blocks.slice(1, 101).every(block => block.separator === '\n\n'));
  for (const eol of ['\n', '\r\n']) {
    const text = ['first', 'last'].join(eol + eol);
    const first = schema.nodes.paragraph.create(null, schema.text('first')), last = schema.nodes.paragraph.create(null, schema.text('last'));
    const original = schema.nodes.doc.create(null, [first, last]);
    const before = captureWysiwygSourceBaseline(text, original);
    const empty = Array.from({ length: 100 }, () => schema.nodes.paragraph.create());
    const nodes = [...empty, first, last];
    const markdown = combinePreservedSourceBlocks(before.nodes, before.blocks, nodes, [...empty.map(() => ''), 'first', 'last'], before.prefix, eol, before.syntheticTailOmitted);
    assert.equal(markdown, eol.repeat(200) + text, '100 head Enter paragraphs must retain their actual blank-line bytes');
    const doc = schema.nodes.doc.create(null, nodes), replay = captureWysiwygSourceBaseline(markdown, doc);
    assert.equal(historyPmDocumentForSchema(doc, schema), doc, 'same-schema history replay must reuse the immutable PM root and all unchanged block identities');
    const otherSchema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} } });
    const remounted = historyPmDocumentForSchema(doc, otherSchema);
    assert.equal(remounted.type.schema, otherSchema);
    assert.deepEqual(remounted.toJSON(), doc.toJSON(), 'cross-schema replay reconstructs safely rather than inserting foreign node types');
    assert.equal(replay.aligned, true, 'snapshot recapture must keep a baseline for empty PM paragraphs, which Markdown tokenization omits');
    assert.equal(replay.nodes.length, replay.blocks.length);
    assert.equal(replay.prefix + replay.blocks.map(block => block.source + block.separator).join(''), markdown);
    assert.equal(replay.blocks[50].separator, eol + eol);
    const changed = schema.nodes.paragraph.create(null, schema.text('typed'));
    const updated = combinePreservedSourceBlocks(replay.nodes, replay.blocks, [...nodes.slice(0, 50), changed, ...nodes.slice(51)], replay.blocks.map((block, index) => index === 50 ? 'typed' : block.source), replay.prefix, eol, replay.syntheticTailOmitted);
    assert.equal(updated, eol.repeat(100) + 'typed' + eol.repeat(100) + text, 'typing into the 51st empty paragraph retains its own source boundary');
    for (const location of ['middle', 'tail']) {
      const inserted = location === 'middle' ? [first, ...empty, last] : [first, last, ...empty];
      const saved = combinePreservedSourceBlocks(before.nodes, before.blocks, inserted, inserted.map(node => node.textContent), before.prefix, eol);
      assert.equal(saved, location === 'middle' ? `first${eol.repeat(202)}last` : text + eol.repeat(200));
      const captured = captureWysiwygSourceBaseline(saved, schema.nodes.doc.create(null, inserted));
      assert.equal(captured.aligned, true, `${location} empty paragraphs must align after recapture`);
      assert.equal(captured.prefix + captured.blocks.map(block => block.source + block.separator).join(''), saved);
      const index = location === 'middle' ? 1 : 2;
      const edited = [...inserted]; edited[index] = changed;
      const output = combinePreservedSourceBlocks(captured.nodes, captured.blocks, edited, edited.map(node => node.textContent), captured.prefix, eol);
      assert.equal(output, location === 'middle' ? `first${eol.repeat(2)}typed${eol.repeat(200)}last` : text + eol.repeat(2) + 'typed' + eol.repeat(198));
    }
  }
  const many = Array.from({ length: 50_000 }, (_, index) => schema.nodes.paragraph.create(null, schema.text(`paragraph ${index}`)));
  const original = schema.nodes.doc.create(null, many), originalSource = many.map(node => node.textContent).join('\n\n');
  const originalBaseline = captureWysiwygSourceBaseline(originalSource, original);
  let current = [...Array.from({ length: 100 }, () => schema.nodes.paragraph.create()), ...many];
  let baseline = originalBaseline, revision = 1, conversions = 0;
  const cache = new WysiwygSnapshotCache({ tabId: () => 'empty-replay-50k', revision: () => revision, dirty: () => true,
    previousMarkdown: () => originalSource, blocks: () => current,
    preservedBlockMarkdown: node => baseline.preservedMarkdownByNode.get(node),
    serializeBlock: node => { conversions++; return node.textContent; }, convertBlock: value => value,
    combineBlocks: values => combinePreservedSourceBlocks(baseline.nodes, baseline.blocks, current, values, baseline.prefix, '\n', baseline.syntheticTailOmitted), trustIncremental: true,
    oracle: () => assert.fail('aligned baseline must remain authoritative') });
  const firstSnapshot = await cache.snapshot('save');
  assert.equal(conversions, 100, 'only the 100 newly inserted empty paragraphs require serialization');
  const doc = schema.nodes.doc.create(null, current);
  baseline = captureWysiwygSourceBaseline(firstSnapshot.markdown, doc);
  const replayed = historyPmDocumentForSchema(doc, schema);
  current = []; replayed.forEach(node => current.push(node)); revision++; cache.invalidate();
  const secondSnapshot = await cache.snapshot('save');
  assert.equal(secondSnapshot.markdown, firstSnapshot.markdown);
  assert.equal(conversions, 100, 'redo must reuse all 50k preserved DOM/block identities and all empty anchors');
  console.log('100 empty paragraph Enter/snapshot/recapture/replay/edit: exact LF/CRLF bytes and stable blank-line anchors passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
