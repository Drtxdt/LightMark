import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-prime-'));
try {
  const { WysiwygSnapshotCache } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/wysiwygSnapshot.ts'), temp)).href);
  let revision = 1, tabId = 'original';
  const block = {};
  const cache = new WysiwygSnapshotCache({ tabId: () => tabId, revision: () => revision, dirty: () => true,
    previousMarkdown: () => 'old', blocks: () => [block], serializeBlock: () => 'normalized', convertBlock: text => text,
    combineBlocks: values => values.join(''), oracle: () => assert.fail('exact source baseline is authoritative'), trustIncremental: true });
  const superseded = cache.snapshot('save');
  cache.prime('![alt](new.png "keep original title")\r\n', 1, 'original');
  await assert.rejects(superseded, /检查点已更新/);
  assert.equal((await cache.snapshot('save')).markdown, '![alt](new.png "keep original title")\r\n');
  assert.throws(() => cache.prime('stale', 0, 'original'), /过期/);
  assert.throws(() => cache.prime('wrong document', 1, 'another'), /过期/);
  revision = 2;
  cache.invalidate();
  const changed = await cache.snapshot('save');
  assert.equal(changed.revision, 2);
  assert.equal(changed.markdown, 'normalized');
  assert.equal(cache.diagnostics().serializedBlocks, 1, 'immutable block conversion remains reusable after a checkpoint');
  tabId = 'save-as';
  cache.prime('save-as exact', 2, tabId);
  assert.equal((await cache.snapshot('save')).tabId, 'save-as');
  console.log('Exact snapshot checkpoints fence stale serialization, revisions, tab identity and preserve immutable block caches.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
