import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-command-targets-'));
const load = file => import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve(file), temp)).href);
try {
  const runtime = await load('src/editor/documentRuntime.ts');
  const { assetReferenceTransaction } = await load('src/editor/assetReferenceTransaction.ts');
  const { extractAssetReferences } = await load('src/utils/documentAssets.ts');
  const { matchesShortcut } = await load('src/utils/shortcuts.ts');
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' }, text: { group: 'inline' },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: {}, alt: { default: 'keep alt' }, width: { default: 123 } } },
  } });
  const original = 'NEW UNSAVED WORDS\n\n![keep alt](assets/old.png)\n';
  let markdown = original;
  let revision = 1;
  let pending = 0;
  let state = EditorState.create({ schema, plugins: [history()], doc: schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text('NEW UNSAVED WORDS')),
    schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: 'assets/old.png' })),
  ]) });
  const adapter = {
    tabId: 'command-A', paneId: 'main', mode: 'wysiwyg', get revision() { return revision; },
    pendingEditVersion: () => pending,
    snapshot: async () => ({ tabId: 'command-A', revision, markdown, dirty: true }),
    derivedState: () => ({}), replaceMarkdown: async () => { throw new Error('must not replace the full document'); }, navigate() {},
    async applySourcePatch(patch, expectedRevision) {
      assert.equal(expectedRevision, revision);
      state = state.apply(assetReferenceTransaction(state, markdown, patch));
      markdown = markdown.slice(0, patch.from) + patch.insert + markdown.slice(patch.to);
      revision++;
    },
  };
  const unregister = runtime.registerDocumentSession(adapter);
  const target = await runtime.captureDocumentCommandTarget(adapter.tabId, 'externalDiff');
  assert.equal(target.markdown, original);
  const reference = extractAssetReferences(target.markdown)[0];
  const patch = { from: reference.from, to: reference.to, expected: reference.source, insert: 'assets/new.png' };
  await runtime.applyDocumentSourcePatch(target, patch);
  assert.equal(markdown, original.replace('old.png', 'new.png'));
  assert.equal(state.doc.firstChild.textContent, 'NEW UNSAVED WORDS');
  assert.deepEqual({ ...state.doc.lastChild.firstChild.attrs }, { src: 'assets/new.png', alt: 'keep alt', width: 123 });
  assert.ok(undo(state, transaction => { state = state.apply(transaction); }));
  assert.equal(state.doc.lastChild.firstChild.attrs.src, 'assets/old.png');
  assert.equal(state.doc.firstChild.textContent, 'NEW UNSAVED WORDS');

  const stale = await runtime.captureDocumentCommandTarget(adapter.tabId, 'externalDiff');
  pending++;
  assert.equal(runtime.documentCommandTargetIsCurrent(stale), false);
  await assert.rejects(runtime.applyDocumentSourcePatch(stale, patch), /发生了变化/);
  pending--;
  const replacement = runtime.registerDocumentSession({ ...adapter, get revision() { return revision; } });
  assert.equal(runtime.documentCommandTargetIsCurrent(stale), false);
  unregister();
  assert.ok(runtime.documentSessionForTab(adapter.tabId), 'old view cleanup cannot unregister its replacement');
  const identity = runtime.documentRuntimeIdentity(adapter.tabId);
  runtime.rebindDocumentSession(adapter.tabId, 'command-A-save-as');
  assert.equal(runtime.documentRuntimeIdentity('command-A-save-as'), identity);
  replacement();

  // Repeated references select the requested occurrence, not every image.
  const duplicateMarkdown = '![a](same.png) ![b](same.png)';
  const duplicateDoc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [
    schema.nodes.image.create({ src: 'same.png', alt: 'a' }), schema.text(' '), schema.nodes.image.create({ src: 'same.png', alt: 'b' }),
  ]));
  const duplicateState = EditorState.create({ schema, doc: duplicateDoc });
  const second = extractAssetReferences(duplicateMarkdown)[1];
  const duplicateTr = assetReferenceTransaction(duplicateState, duplicateMarkdown, { from: second.from, to: second.to, expected: second.source, insert: 'second.png' });
  assert.equal(duplicateTr.doc.firstChild.firstChild.attrs.src, 'same.png');
  assert.equal(duplicateTr.doc.firstChild.lastChild.attrs.src, 'second.png');

  const key = { key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: false };
  assert.ok(matchesShortcut('Mod+S', key, 'Win32'));
  assert.ok(matchesShortcut('Ctrl+S', { ...key, ctrlKey: false, metaKey: true }, 'MacIntel'));
  assert.equal(matchesShortcut('Mod+S', { ...key, isComposing: true }, 'Win32'), false);
  assert.equal(matchesShortcut('Mod+S', { ...key, metaKey: true }, 'Win32'), false);
  console.log('Document target guards, local asset transactions, native history and platform Mod checks passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
