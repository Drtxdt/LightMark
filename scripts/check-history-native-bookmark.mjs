import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EditorSelection, Text } from '@codemirror/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-native-bookmark-'));
try {
  const { DocumentHistory } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/documentHistory.ts'), temp)).href);
  const history = new DocumentHistory();
  const root = { mode: 'source', doc: Text.of(['x'.repeat(120)]), lineEndings: { main: '\n', endings: [] } };
  history.mount(root, EditorSelection.cursor(90), 'x'.repeat(120));
  assert.deepEqual(history.projection(history.current, 'source').bookmark, { anchor: 90, head: 90 }, 'mount must read the real CodeMirror getter values rather than spread its storage fields');
  history.project(root, EditorSelection.range(98, 94));
  assert.deepEqual(history.projection(history.current, 'source').bookmark, { anchor: 98, head: 94 }, 'projection must retain the direction of a native selection range');
  const before = EditorSelection.cursor(98), after = EditorSelection.cursor(106);
  history.record({ ...root, doc: Text.of(['y'.repeat(128)]) }, { kind: 'command', before, after, time: 100 });
  const next = history.current;
  assert.deepEqual(next.primary.bookmark, { anchor: 106, head: 106 }, 'new immutable versions must capture native anchor/head getters');
  const undo = history.prepare(-1);
  assert.deepEqual(history.projection(undo.version, 'source').bookmark, { anchor: 98, head: 98 });
  history.commit(undo, () => {});
  assert.deepEqual(history.projection(history.prepare(1).version, 'source').bookmark, { anchor: 106, head: 106 });
  console.log('Real CodeMirror selection bookmark capture passed (mount, projection, backward range and redo).');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
