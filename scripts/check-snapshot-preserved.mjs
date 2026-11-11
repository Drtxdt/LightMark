import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-preserved-snapshot-'));
try {
  const { WysiwygSnapshotCache } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/wysiwygSnapshot.ts'), temp)).href);
  const original = Array.from({ length: 50_000 }, (_, index) => ({ text: `paragraph ${index}` }));
  const preserved = new WeakMap(original.map(block => [block, block.text]));
  let blocks = [...original], revision = 1, serializations = 0, conversions = 0;
  const changed = { text: 'changed first paragraph' };
  blocks[0] = changed;
  const cache = new WysiwygSnapshotCache({ tabId: () => '50k-real-callback-count', revision: () => revision, dirty: () => true,
    previousMarkdown: () => '', blocks: () => blocks, preservedBlockMarkdown: block => preserved.get(block),
    serializeBlock: block => { serializations++; return block.text; }, convertBlock: text => { conversions++; return text; },
    combineBlocks: values => values.join('\n\n'), trustIncremental: true,
    oracle: () => assert.fail('an aligned exact baseline is authoritative') });
  const first = await cache.snapshot('save');
  assert.equal(first.markdown, blocks.map(block => block.text).join('\n\n'));
  assert.equal(serializations, 1, 'first dirty 50k snapshot must call DOM serialization only for the changed block');
  assert.equal(conversions, 1, 'unchanged blocks must never reach HTML conversion');
  assert.equal(cache.diagnostics().reusedBlocks, 49_999);
  // A structural head Enter creates a new empty paragraph without changing
  // the identities of the other 49,999 paragraphs.
  blocks = [{ text: '' }, ...blocks]; revision++; cache.invalidate();
  const split = await cache.snapshot('save');
  assert.equal(split.markdown, blocks.map(block => block.text).join('\n\n'));
  assert.equal(serializations, 2, 'head split serializes only its new block, reusing previously converted changed block');
  assert.equal(conversions, 2);
  // A new source checkpoint may reuse a model identity with different source
  // delimiter spelling; its baseline must win over compatibility cache.
  preserved.set(changed, '__changed first paragraph__'); revision++; cache.invalidate();
  assert.ok((await cache.snapshot('export')).markdown.includes('__changed first paragraph__'));
  assert.equal(serializations, 2);
  console.log('50,000-block first-dirty/save/head-split/export snapshot: actual serialization/conversion callback counts 1 → 2 → 2; unchanged baseline bytes reused.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
