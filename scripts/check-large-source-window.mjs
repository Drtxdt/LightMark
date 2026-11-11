import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EditorState } from '@codemirror/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-large-window-'));
try {
  const model = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/largeSourceWindow.ts'), temp)).href);
  const { advanceLargePosition, windowOffsetPosition, windowPositionOffset, replacementForWindow, LargeWindowCache } = model;
  assert.equal(model.safeLargeWindowOffset('a😀b', 2), 1, 'a jump cannot place the editing caret inside an emoji');
  assert.equal(model.safeLargeWindowOffset('a😀b', 3), 3);
  assert.equal(model.safeLargeWindowOffset('a😀b', 100), 4);
  assert.deepEqual(advanceLargePosition({ line: 9, column: 5 }, '😀a\r\nb\rc\nd'), { line: 12, column: 1 });
  const start = { line: 57, column: 3000000 };
  const text = '甲😀乙\nsecond\nlast';
  for (let offset = 0; offset <= text.length; offset++) {
    const position = windowOffsetPosition(text, start, offset);
    assert.equal(windowPositionOffset(text, start, position), offset);
  }
  assert.equal(windowPositionOffset(text, start, { line: 56, column: 0 }), null);
  const before = '😀first\nsecond\nthird';
  assert.deepEqual(replacementForWindow(before, before.replace('second', 'NEXT'), start, '\r\n'), {
    startLine: 58, startColumn: 0, endLine: 58, endColumn: 6, text: 'NEXT',
  });
  const emojiPatch = replacementForWindow('abc😀tail', 'abc😁tail', { line: 0, column: 0 });
  assert.deepEqual(emojiPatch, { startLine: 0, startColumn: 3, endLine: 0, endColumn: 5, text: '😁' });
  const rawBefore = 'first\r\nsecond\rthird\nlast';
  const rawAfter = 'FIRST\r\nsecond\rthird\nLAST';
  const rawPatch = model.replacementForRawWindow(rawBefore, rawAfter, { line: 10, column: 5 });
  assert.deepEqual(rawPatch, { startLine: 10, startColumn: 5, endLine: 13, endColumn: 4, text: rawAfter });
  assert.deepEqual(model.replacementForRawWindow('a\r\nb', 'a\nb', { line: 0, column: 0 }), {
    startLine: 0, startColumn: 1, endLine: 1, endColumn: 0, text: '\n',
  });
  const endings = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/sourceLineEndings.ts'), temp)).href);
  const parsed = endings.parseSourceDocument(rawBefore);
  let mixedState = EditorState.create({ doc: parsed.text, extensions: [endings.sourceLineEndingsExtension(parsed.lineEndings)] });
  let mixedRaw = rawBefore;
  const rawAt = (source, line, column) => {
    let row = 0, col = 0;
    for (let i = 0; i <= source.length; i++) {
      if (row === line && col === column) return i;
      if (source[i] === '\r' || source[i] === '\n') {
        if (source[i] === '\r' && source[i + 1] === '\n') i++;
        row++; col = 0;
      } else col++;
    }
    throw new Error('coordinate outside raw text');
  };
  for (const insertion of ['X', '\nnew\n', '😀', 'first\nlast']) {
    const from = Math.min(2, mixedState.doc.length), to = Math.min(from + 1, mixedState.doc.length);
    mixedState = mixedState.update({ changes: { from, to, insert: insertion } }).state;
    const serialized = endings.serializeSourceDocument(mixedState.doc, mixedState.field(endings.sourceLineEndingsField));
    const patch = model.replacementForRawWindow(mixedRaw, serialized, { line: 0, column: 0 });
    const a = rawAt(mixedRaw, patch.startLine, patch.startColumn), b = rawAt(mixedRaw, patch.endLine, patch.endColumn);
    assert.equal(mixedRaw.slice(0, a) + patch.text + mixedRaw.slice(b), serialized);
    mixedRaw = serialized;
  }
  const cache = new LargeWindowCache(1024);
  for (let i = 0; i < 10000; i++) {
    cache.set(String(i), { text: 'x'.repeat(100), revision: i });
    assert.ok(cache.sizeBytes <= 1024);
  }
  assert.equal(cache.get('0'), undefined);
  assert.equal(cache.get('9999').revision, 9999);
  cache.clear(); assert.equal(cache.sizeBytes, 0);
  // The actual CM document only materializes the bounded window, even for a logical 500MiB line.
  let state = EditorState.create({ doc: 'x'.repeat(model.LARGE_WINDOW_BYTES) });
  const logicalStart = { line: 0, column: 400 * 1024 * 1024 };
  state = state.update({ changes: { from: 100, to: 101, insert: '中😀' } }).state;
  const edit = replacementForWindow('x'.repeat(model.LARGE_WINDOW_BYTES), state.doc.toString(), logicalStart);
  assert.equal(edit.startColumn, logicalStart.column + 100);
  assert.equal(edit.endColumn, logicalStart.column + 101);
  assert.equal(edit.text, '中😀');
  assert.ok(state.doc.length < model.LARGE_WINDOW_BYTES + 10);
  for (const line of [0, 1, 250000000, 499999999]) {
    assert.equal(model.trackToLine(model.lineToTrack(line, 500000000), 500000000), line);
    assert.ok(model.lineToTrack(line, 500000000) <= model.LARGE_SCROLL_TRACK);
  }
  let seed = 7;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  let document = 'a😀b\nc\n'.repeat(20);
  for (let i = 0; i < 500; i++) {
    const from = random(document.length + 1), to = from + random(document.length - from + 1);
    const inserted = ['字', '😀', '\n', 'x\ny', ''][random(5)];
    const next = document.slice(0, from) + inserted + document.slice(to);
    const patch = replacementForWindow(document, next, { line: 0, column: 0 });
    if (patch) {
      const a = windowPositionOffset(document, { line: 0, column: 0 }, { line: patch.startLine, column: patch.startColumn });
      const b = windowPositionOffset(document, { line: 0, column: 0 }, { line: patch.endLine, column: patch.endColumn });
      assert.equal(document.slice(0, a) + patch.text + document.slice(b), next);
    } else assert.equal(document, next);
    document = next;
  }
  console.log('Large source window behavior passed: bounded CM, UTF-16, EOL, LRU, logical tracks, 500 randomized patches.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
