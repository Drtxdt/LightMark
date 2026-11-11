import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { EditorState } from '@codemirror/state';
import { Schema } from '@tiptap/pm/model';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-command-lifecycle-'));
const load = file => import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve(file), temp)).href);
try {
  const runtime = await load('src/editor/documentRuntime.ts');
  const broker = await load('src/editor/pendingDocumentCommands.ts');
  const inactive = await load('src/editor/inactiveDocumentPatch.ts');
  const endings = await load('src/editor/sourceLineEndings.ts');
  const appStore = { tabs: [], splitLayout: { mainTabId: 'other', secondaryTabId: '' } };
  const flushes = [], rebases = [];
  let inactiveGate;
  let releasePaths, deferPaths = false;
  const paths = {
    async rebasePendingImagePaths(markdown, originalPath, currentPath) {
      if (deferPaths) { deferPaths = false; await new Promise(resolve => { releasePaths = resolve; }); }
      rebases.push({ originalPath, currentPath });
      return originalPath === currentPath ? markdown : markdown.replace('assets/x.png', '../A/assets/x.png');
    },
    async assetReferenceForDocument(documentPath, absolutePath) { return `${documentPath}:${absolutePath}`; },
  };
  // Execute production orchestration functions with only their IO imports injected.
  const source = fs.readFileSync('src/stores/appStore.ts', 'utf8');
  const ast = ts.createSourceFile('appStore.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ['applyPendingCommandToDocument', 'completePendingImageCommand', 'completePendingAssetRelink'].map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name);
    return node.getText(ast).replace(/^export\s+/, '').replaceAll("import('../editor/inactiveDocumentPatch')", 'loadInactive()').replaceAll("import('../editor/pendingAssetPaths')", 'loadPaths()');
  }).join('\n');
  const dependencies = { ...runtime, ...broker, appStore, loadInactive: async () => { if (inactiveGate) await inactiveGate(); return inactive; }, loadPaths: async () => paths,
    markDocumentChanged(tabId, revision) { appStore.tabs.find(tab => tab.id === tabId).isDirty = true; },
    async flushDocumentSnapshot(tabId) { const snapshot = await runtime.snapshotDocumentTab(tabId, 'externalDiff'); flushes.push(tabId); appStore.tabs.find(tab => tab.id === tabId).content = snapshot.markdown; },
  };
  const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const commands = new Function(...Object.keys(dependencies), `${compiled};return {completePendingImageCommand,completePendingAssetRelink};`)(...Object.values(dependencies));

  function mountSource(tab) {
    const parsed = endings.parseSourceDocument(tab.content);
    let state = EditorState.create({ doc: parsed.text, extensions: endings.sourceLineEndingsExtension(parsed.lineEndings) });
    let revision = runtime.documentRevision(tab.id), lease;
    const markdown = () => endings.serializeSourceDocument(state.doc, state.field(endings.sourceLineEndingsField));
    const adapter = {
      tabId: tab.id, paneId: 'main', mode: 'source', initialCommandMarkdown: tab.content,
      get revision() { return revision; },
      derivedState: () => ({}), navigate() {}, replaceMarkdown: async () => {},
      snapshot: async () => { history.checkpoint(markdown()); return { tabId: tab.id, revision, markdown: markdown(), dirty: true }; },
      async commandAnchorToSource(anchor) { const text = markdown(); const from = endings.sourceOffsetToRawOffset(text, anchor.from), to = endings.sourceOffsetToRawOffset(text, anchor.to); return { from, to, expected: text.slice(from, to) }; },
      async commandAnchorFromSource(anchor, kind, text) { return { from: endings.rawOffsetToSourceOffset(text, anchor.from), to: endings.rawOffsetToSourceOffset(text, anchor.to), binding: kind === 'asset' ? { expected: anchor.expected } : undefined }; },
      captureAssetCommandAnchor(patch, text) { return { from: endings.rawOffsetToSourceOffset(text, patch.from), to: endings.rawOffsetToSourceOffset(text, patch.to), binding: { expected: patch.expected } }; },
      validateCommandAnchor: anchor => state.sliceDoc(anchor.from, anchor.to) === anchor.binding?.expected,
      async applyPendingCommand(anchor, payload, expectedRevision, assertCurrent) {
        assertCurrent(); assert.equal(revision, expectedRevision);
        const text = markdown(), rawFrom = endings.sourceOffsetToRawOffset(text, anchor.from), rawTo = endings.sourceOffsetToRawOffset(text, anchor.to);
        const insert = payload.kind === 'asset' ? payload.insert : inactive.blockSpacedMarkdown(text, rawFrom, rawTo, payload.markdown);
        edit({ from: anchor.from, to: anchor.to, insert });
      },
    };
    const history = runtime.documentHistoryForTab(tab.id);
    history.mount({ mode: 'source', doc: state.doc, lineEndings: state.field(endings.sourceLineEndingsField) }, { anchor: 0, head: 0 }, tab.content);
    const unregister = runtime.registerDocumentSession(adapter); lease = runtime.documentCommandLease(tab.id);
    function edit(change) {
      const transaction = state.update({ changes: change }); state = transaction.state;
      const map = []; transaction.changes.iterChangedRanges((from, to, newFrom, newTo) => map.push({ from, to, inserted: newTo - newFrom }));
      runtime.mapPendingDocumentCommands(tab.id, lease, [map], adapter.validateCommandAnchor);
      history.record({ mode: 'source', doc: state.doc, lineEndings: state.field(endings.sourceLineEndingsField) }, { kind: 'command', before: { anchor: change.from, head: change.to ?? change.from }, after: { anchor: change.from + change.insert.length, head: change.from + change.insert.length }, time: Date.now() });
      revision = runtime.advanceDocumentRevision(tab.id, revision);
    }
    return { adapter, unregister, edit, markdown, get state() { return state; } };
  }

  const tab = { id: 'original', path: 'A/a.md', content: '\uFEFFbefore\r\nbody\nend', documentMode: 'normal', isDirty: false };
  appStore.tabs.push(tab, { id: 'other', content: 'OTHER' });
  let view = mountSource(tab);
  const image = runtime.beginPendingImageCommand(tab.id, 7, 7);
  view.edit({ from: 1, insert: 'NEW ' });
  tab.content = (await runtime.snapshotDocumentTab(tab.id, 'tabSwitch')).markdown;
  view.unregister();
  assert.equal(broker.pendingCommand(image).native, null);
  await commands.completePendingImageCommand(image, '![x](assets/x.png)', { markdownPath: 'A/a.md', settings: {} });
  assert.equal(tab.content, '\uFEFFNEW before\r\n\r\n![x](assets/x.png)\r\n\r\nbody\nend');
  assert.equal(appStore.tabs[1].content, 'OTHER');
  assert.equal(runtime.documentHistoryForTab(tab.id).canUndo, true, 'inactive insert is one document command');
  const history = runtime.documentHistoryForTab(tab.id), undo = history.prepare(-1);
  assert.equal(history.exactSource(undo.version), '\uFEFFNEW before\r\nbody\nend', 'inactive undo retains all recent input');

  // The latest selection belongs to WYS; its numeric PM position must not become a CM offset.
  const caretTab = { id: 'wys-caret', path: 'A/caret.md', content: '## __word__   tail\r\n', documentMode: 'normal' };
  appStore.tabs.push(caretTab);
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, heading: { content: 'text*', group: 'block', attrs: { level: { default: 2 } } }, text: {} }, marks: { bold: {} } });
  const doc = schema.nodes.doc.create(null, schema.nodes.heading.create(null, [schema.text('word', [schema.marks.bold.create()]), schema.text(' tail')]));
  const { captureWysiwygSourceBaseline } = await load('src/editor/wysiwygCodec.ts');
  const caretHistory = runtime.documentHistoryForTab(caretTab.id);
  caretHistory.mount({ mode: 'wysiwyg', doc, baseline: captureWysiwygSourceBaseline(caretTab.content, doc) }, { anchor: 2, head: 3 }, caretTab.content);
  const caretHandle = broker.beginPendingCommand(runtime.documentRuntimeIdentity(caretTab.id), 'image', 'source', 999, { from: 0, to: 0 });
  const caretRecord = broker.pendingCommand(caretHandle);
  broker.projectPendingCommand(caretRecord, 999, 0, { from: caretTab.content.length, to: caretTab.content.length, expected: '', markdown: caretTab.content, revision: 0 });
  broker.detachPendingCommands(caretHandle.documentId, 999);
  await commands.completePendingImageCommand(caretHandle, '![x](assets/x.png)', { markdownPath: caretTab.path, settings: {} });
  const caretUndo = caretHistory.prepare(-1);
  assert.deepEqual(caretHistory.projection(caretUndo.version, 'source').bookmark, { anchor: 6, head: 7 }, 'inactive WYS history selection is explicitly mapped into Source coordinates');

  // The operation starts under A, then Save As changes both path and tab identity.
  view = mountSource(tab);
  const moved = runtime.beginPendingImageCommand(tab.id, view.state.doc.length, view.state.doc.length);
  tab.content = (await runtime.snapshotDocumentTab(tab.id, 'tabSwitch')).markdown;
  view.unregister();
  deferPaths = true;
  const pending = commands.completePendingImageCommand(moved, '![x](assets/x.png)', { markdownPath: 'A/a.md', settings: {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const oldId = tab.id; tab.id = 'saved-as'; tab.path = 'B/b.md'; runtime.rebindDocumentSession(oldId, tab.id);
  releasePaths(); await pending;
  assert.equal(rebases.at(-1).currentPath, 'B/b.md');
  assert.ok(tab.content.endsWith('![x](../A/assets/x.png)'));

  // Mode reconstruction hydrates the same raw position and consumes real edits made after remount.
  view = mountSource(tab);
  const remounted = runtime.beginPendingImageCommand(tab.id, 4, 4);
  tab.content = (await runtime.snapshotDocumentTab(tab.id, 'modeSwitch')).markdown;
  view.unregister(); view = mountSource(tab);
  view.edit({ from: 1, insert: '++' });
  await commands.completePendingImageCommand(remounted, '![x](assets/x.png)', { markdownPath: tab.path, settings: {} });
  assert.ok(tab.content.includes('++NEW\r\n\r\n![x](assets/x.png)'), 'hydrated point replays queued post-mount maps');
  assert.equal(flushes.at(-1), tab.id);

  const overlap = runtime.beginPendingImageCommand(tab.id, view.state.doc.length, view.state.doc.length);
  tab.content = (await runtime.snapshotDocumentTab(tab.id, 'modeSwitch')).markdown;
  const outgoing = view;
  view = mountSource(tab); // Vue transitions may register the replacement before outgoing cleanup.
  outgoing.unregister();
  await commands.completePendingImageCommand(overlap, '![x](assets/x.png)', { markdownPath: tab.path, settings: {} });
  assert.ok(tab.content.endsWith('![x](assets/x.png)'), 'late outgoing unregister cannot strand a command in its old lease');

  const appearing = runtime.beginPendingImageCommand(tab.id, view.state.doc.length, view.state.doc.length);
  tab.content = (await runtime.snapshotDocumentTab(tab.id, 'tabSwitch')).markdown;
  view.unregister();
  let releaseInactive, enteredInactive;
  const entered = new Promise(resolve => { enteredInactive = resolve; });
  inactiveGate = () => { enteredInactive(); return new Promise(resolve => { releaseInactive = resolve; }); };
  const delayed = commands.completePendingImageCommand(appearing, '![appear](assets/x.png)', { markdownPath: tab.path, settings: {} });
  await entered;
  appStore.splitLayout.mainTabId = tab.id;
  view = mountSource(tab);
  releaseInactive(); await delayed; inactiveGate = null;
  assert.ok(view.markdown().endsWith('![appear](assets/x.png)'), 'a document becoming visible during IO receives its live local transaction');
  assert.equal(tab.content, view.markdown(), 'inactive startup text cannot overwrite an incoming view');
  appStore.splitLayout.mainTabId = 'other';

  const closed = runtime.beginPendingImageCommand(tab.id, 1, 1);
  runtime.clearDocumentRuntimeState(tab.id); view.unregister();
  await assert.rejects(commands.completePendingImageCommand(closed, '![x](assets/x.png)', { markdownPath: tab.path, settings: {} }), /已关闭/);
  assert.equal(appStore.tabs[1].content, 'OTHER');
  console.log('Pending command production lifecycle: continued input, inactive insertion/history, Save As identity/path, remount queued edits, original close passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
