import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Text } from '@codemirror/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-history-save-race-'));
try {
  const { DocumentHistory } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/documentHistory.ts'), temp)).href);
  const root = value => ({ mode: 'source', doc: Text.of([value]), lineEndings: { main: '\n', endings: [] } });
  const bookmark = head => ({ anchor: head, head });
  const history = new DocumentHistory();
  history.mount(root('A'), bookmark(1), 'A', true);
  const diskA = history.current;
  history.record(root('AB'), { kind: 'command', before: bookmark(1), after: bookmark(2), time: 100 });
  history.checkpoint('AB');
  const savedB = history.current;
  // The save captured B; typing C is deliberately allowed while its native write runs.
  history.record(root('ABC'), { kind: 'command', before: bookmark(2), after: bookmark(3), time: 200 });
  history.markSaved('AB');
  assert.equal(history.isSaved(savedB), true, 'the captured write is now the disk baseline');
  assert.equal(history.isSaved(diskA), false, 'the previous disk baseline must become dirty after a newer save completes');
  assert.equal(history.isSaved(history.current), false, 'typing during save must remain dirty');
  let move = history.prepare(-1);
  history.commit(move, () => {});
  assert.equal(history.isSaved(history.current), true);
  move = history.prepare(-1);
  history.commit(move, () => {});
  assert.equal(history.isSaved(history.current), false, 'undoing past the newest disk baseline must prompt on close');

  const recovered = new DocumentHistory();
  recovered.mount(root('recovered draft'), bookmark(15), 'recovered draft', false);
  const draft = recovered.current;
  recovered.record(root('recovered draft!'), { kind: 'typing', before: bookmark(15), after: bookmark(16), time: 100 });
  assert.equal(recovered.isSaved(draft), false, 'first mount of a recovered dirty draft is not a save');
  console.log('Document history save-race and dirty recovered-root checks passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
