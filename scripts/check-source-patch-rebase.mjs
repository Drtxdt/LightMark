import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-rebase-'));
try {
  const { rebaseUnchangedSourcePatch: rebase } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/sourcePatchRebase.ts'), temp)).href);
  const original = 'before ![asset](old.png) after';
  const from = original.indexOf('old.png');
  const patch = { from, to: from + 7, expected: 'old.png', insert: 'new.png' };
  const apply = (text, patch) => text.slice(0, patch.from) + patch.insert + text.slice(patch.to);
  const prefix = 'NEW 中文 😀 ' + original;
  assert.equal(apply(prefix, rebase(original, prefix, patch)), 'NEW 中文 😀 before ![asset](new.png) after');
  const suffix = original + ' NEW WORDS';
  assert.equal(apply(suffix, rebase(original, suffix, patch)), 'before ![asset](new.png) after NEW WORDS');
  assert.throws(() => rebase(original, original.replace('old.png', 'changed.png'), patch), /修改或删除/);
  assert.throws(() => rebase(original, original.replace('![asset](old.png)', ''), patch), /修改或删除/);
  const point = { from: 3, to: 3, expected: '', insert: 'IMAGE' };
  assert.equal(rebase('abc def', 'abcXYZ def', point).from, 6, 'new typing at the insertion bookmark uses after affinity');
  assert.throws(() => rebase('abc def', 'REPLACED', point), /插入位置/);
  console.log('Concurrent source range mapping preserves typed prose and rejects modified/deleted references.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
