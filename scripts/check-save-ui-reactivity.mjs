import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { reactive, toRaw, effect, stop } from 'vue';

const source = fs.readFileSync('src/stores/appStore.ts', 'utf8');
const ast = ts.createSourceFile('appStore.ts', source, ts.ScriptTarget.Latest, true);
const names = ['captureSaveContext', 'commitCapturedSave', 'commitCapturedSaveAs', 'clearTabExternalState',
  'syncLargeOutboxProjection', 'setLargeBackendState', 'applyLargeSaveReceipt', 'retargetLargeTabForSaveAs'];
const declarations = names.map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}).join('\n');
const javascript = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const results = [];
for (const saveAs of [false, true]) for (const active of [false, true]) {
  const raw = { id: 'original', path: 'original.md', name: 'original.md', kind: 'normal', content: 'edited', isDirty: true, externalState: 'clean' };
  const appStore = reactive({ tabs: [raw], activeTabId: active ? raw.id : 'other', currentContent: active ? raw.content : 'other content', currentFilePath: raw.path, isDirty: true, saveState: 'dirty', splitLayout: {} });
  let renderCount = 0, rendered;
  const render = effect(() => {
    const tab = appStore.tabs[0];
    renderCount++;
    // The fields read by DocumentTabs' template. It does not depend on the
    // unrelated status-bar saveState/currentContent fields.
    rendered = { dirty: tab.isDirty, name: tab.name, path: tab.path, id: tab.id, externalState: tab.externalState };
  });
  const dependencies = {
    reactive, toRaw, appStore, getActiveTab: () => appStore.tabs[0], documentSessionForTab: () => null,
    mutationEpoch: () => 0, documentRuntimeMetadata: new Map(), pendingEditVersion: () => null,
    isFrozenSaveVersionCurrent: () => versionCurrent, isCapturedTabActive: () => active,
    documentHistoryForTab: () => ({ markSaved() {} }), publishSaveNotice() {}, rememberRecentFile() {},
    advanceMutationEpoch() {}, tabIdForPath: path => 'id:' + path, rebindDocumentRuntime() {},
    fileNameFromPath: path => path, replaceTabIdInSplitLayout: value => value, tabIds: () => [],
  };
  let versionCurrent = true;
  const functions = new Function(...Object.keys(dependencies), javascript + '\nreturn {captureSaveContext, commitCapturedSave, commitCapturedSaveAs};')(...Object.values(dependencies));
  const context = functions.captureSaveContext();
  assert.equal(context.tab, raw, 'production context captures the raw identity');
  const committed = functions[saveAs ? 'commitCapturedSaveAs' : 'commitCapturedSave'](context, { markdown: 'saved bytes' }, saveAs ? 'renamed.md' : 'original.md', { exists: true });
  assert.ok(committed);
  assert.equal(committed.tab, raw, 'the receipt retains the captured raw identity for race checks');
  assert.equal(appStore.tabs[0].isDirty, false, 'plain reads see the successful save');
  assert.equal(appStore.saveState, active ? 'saved' : 'dirty', 'only the active status projection updates');
  assert.equal(rendered.dirty, false, 'the tab render effect observes the saved state');
  assert.equal(rendered.path, saveAs ? 'renamed.md' : 'original.md');
  assert.equal(rendered.name, rendered.path);
  assert.equal(rendered.id, saveAs ? 'id:renamed.md' : 'original');
  assert.ok(renderCount > 1, 'saving invalidates the tab render dependencies');
  if (!active) assert.equal(appStore.currentContent, 'other content', 'inactive save keeps the active document projection');
  versionCurrent = false;
  appStore.tabs[0].isDirty = true;
  const beforeStale = renderCount;
  assert.equal(functions[saveAs ? 'commitCapturedSaveAs' : 'commitCapturedSave'](context, { markdown: 'stale' }, 'original.md', {}), null);
  assert.equal(renderCount, beforeStale, 'a rejected stale save produces no render changes');
  assert.equal(appStore.tabs[0].content, 'saved bytes');
  const result = { operation: saveAs ? 'Save As' : 'Save', active, renderCount };
  results.push(result);
  stop(render);
}
console.log(JSON.stringify(results, null, 2));

// The real large-file IPC capture is deliberately raw. Its nested state must
// still notify both the tab header and editor-derived revision/pending state.
const largeRaw = { id: 'large', path: 'large.md', name: 'large.md', kind: 'large', documentMode: 'large', isDirty: true,
  largeFile: { sessionId: 'session', revision: 2, savedRevision: 1, pendingEditCount: 1, targetPath: 'large.md', coordinateSpace: 'utf16-code-units' } };
const largeStore = reactive({ tabs: [largeRaw], activeTabId: 'large', largeFile: largeRaw.largeFile, splitLayout: {}, isDirty: true, saveState: 'dirty' });
let largeRendered;
const largeRender = effect(() => {
  const tab = largeStore.tabs[0];
  largeRendered = { dirty: tab.isDirty, path: tab.path, name: tab.name, revision: tab.largeFile.revision,
    saved: tab.largeFile.savedRevision, pending: tab.largeFile.pendingEditCount, bytes: tab.largeFile.sizeBytes };
});
const pending = new WeakMap([[largeRaw, 1]]);
const largeDeps = { reactive, toRaw, appStore: largeStore, largeRemotePendingCounts: pending,
  largeOutboxFor: tab => { assert.equal(tab, largeRaw, 'outbox keys retain raw identity'); return []; },
  largeBackendPendingCount: tab => pending.get(tab), documentSessionForTab: () => null,
  assertLargeStateReceipt() {}, LARGE_COORDINATE_SPACE: 'utf16-code-units', LargeSessionStaleError: Error,
  formatLargeSaveReceiptFailure: () => 'invalid', advanceMutationEpoch() {}, tabIdForPath: path => 'id:' + path,
  rebindDocumentRuntime() {}, fileNameFromPath: path => path, replaceTabIdInSplitLayout: value => value, tabIds: () => [],
};
const largeFunctions = new Function(...Object.keys(largeDeps), javascript + '\nreturn {syncLargeOutboxProjection,setLargeBackendState,applyLargeSaveReceipt,retargetLargeTabForSaveAs};')(...Object.values(largeDeps));
largeFunctions.syncLargeOutboxProjection(largeRaw);
assert.equal(largeRendered.pending, 1);
largeFunctions.setLargeBackendState(largeRaw, { revision: 3, savedRevision: 1, pendingEditCount: 0, coordinateSpace: 'utf16-code-units' });
assert.equal(largeRendered.revision, 3);
assert.equal(largeRendered.pending, 0);
assert.equal(largeRendered.dirty, true);
const current = { tab: largeRaw, sessionId: 'session', revision: 3 };
largeFunctions.applyLargeSaveReceipt(current, { outcome: 'committed', diskWritten: 'yes', sessionId: 'session', requestedRevision: 3,
  currentRevision: 3, savedRevision: 3, pendingEditCount: 0, coordinateSpace: 'utf16-code-units',
  baseFingerprint: { sizeBytes: 123 }, diskFingerprint: {}, path: 'large.md' });
assert.equal(current.tab, largeRaw);
assert.deepEqual(largeRendered, { dirty: false, path: 'large.md', name: 'large.md', revision: 3, saved: 3, pending: 0, bytes: 123 });
assert.equal(largeStore.isDirty, false);
assert.equal(largeStore.saveState, 'saved');
largeFunctions.retargetLargeTabForSaveAs(largeRaw, 'large-renamed.md');
assert.equal(largeRendered.path, 'large-renamed.md');
assert.equal(largeRendered.name, 'large-renamed.md');
assert.equal(largeStore.activeTabId, 'id:large-renamed.md');
stop(largeRender);
console.log('Save UI reactivity: ordinary active/inactive Save/Save As, stale rejection, raw identity, and large-file receipt/retarget passed.');
