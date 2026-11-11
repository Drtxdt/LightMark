import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const tmp = mkdtempSync(path.resolve('node_modules/.lightmark-workspace-'));
const load = name => import(pathToFileURL(compileTypeScriptModuleGraph(
  path.resolve('src/stores/appStore.ts'), path.join(tmp, name), path.resolve('src'),
)).href);
let dispatch;
globalThis.window = Object.assign(new EventTarget(), {
  setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: (...args) => dispatch(...args) },
});
async function until(label, check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (check()) return; await delay(5); }
  assert.fail('timed out: ' + label);
}
try {
  const blocked = await load('blocked');
  const unavailable = Promise.withResolvers();
  const before = [];
  dispatch = async (cmd) => {
    if (cmd === 'read_app_config') return unavailable.promise;
    before.push(cmd);
  };
  const reading = blocked.loadConfig();
  await blocked.persistConfig();
  unavailable.reject(Error('damaged config fixture'));
  await assert.rejects(reading, /damaged config fixture/);
  blocked.createUntitledTab('safe draft', true);
  await blocked.persistConfig();
  assert.equal(blocked.appStore.currentContent, 'safe draft');
  assert.match(blocked.appStore.configPersistenceMessage, /内存/);
  assert.deepEqual(before, [], 'neither pending nor failed config reads may write session defaults');

  const store = await load('healthy'), state = store.appStore;
  const A = 'C:/owned/A', B = 'C:/owned/B';
  const node = (root, name) => [{ name, path: root + '/' + name, isDir: false, children: [] }];
  let writeGate, treeGate, tagGate, watched, index, serial = 0, treeCalls = 0;
  const writes = [], watches = [];
  dispatch = async (cmd, args) => {
    if (cmd === 'read_app_config') return {};
    if (cmd === 'write_app_config') {
      const gate = writeGate; writeGate = undefined;
      writes.push([...args.config.recentFiles]); if (gate) await gate.promise;
    } else if (cmd === 'list_markdown_files') {
      treeCalls++;
      const gate = treeGate; treeGate = undefined;
      return gate ? gate.promise : node(args.folder, args.folder.endsWith('/A') ? 'fresh-A.md' : 'fresh-B.md');
    } else if (cmd === 'unwatch_markdown_workspace') {
      watched = null;
    } else if (cmd === 'watch_markdown_workspace') {
      watched = { root: args.path, epoch: args.epoch }; watches.push(watched);
    } else if (cmd === 'workspace_index_open') {
      index = { root: args.root, generation: ++serial, busy: false, candidates: [] };
      return index;
    } else if (cmd === 'workspace_index_status') {
      return index;
    } else if (cmd === 'workspace_query_tags') {
      const gate = tagGate; tagGate = undefined;
      const generation = index.generation, root = index.root;
      if (gate) await gate.promise;
      return { generation, data: [{ name: root + '/' + generation, count: 1 }] };
    } else throw Error('Unexpected command: ' + cmd);
  };
  await store.loadConfig();
  await store.persistConfig();
  writes.length = 0;
  const slowWrite = writeGate = Promise.withResolvers();
  state.recentFiles = ['first.md'];
  const firstWrite = store.persistConfig();
  state.recentFiles[0] = 'last.md';
  const lastWrite = store.persistConfig();
  let drained = false;
  const drain = store.flushPendingConfigWrites().then(() => { drained = true; });
  await until('first write began', () => writes.length > 0);
  assert.deepEqual(writes, [['first.md']]);
  assert.equal(drained, false);
  slowWrite.resolve();
  await Promise.all([firstWrite, lastWrite, drain]);
  assert.deepEqual(writes, [['first.md'], ['last.md']]);

  const oldTree = treeGate = Promise.withResolvers();
  const firstA = store.openWorkspace(A);
  await until('first A tree pending', () => treeGate === undefined);
  await store.openWorkspace(B);
  assert.equal(state.fileTree[0].name, 'fresh-B.md');
  await store.openWorkspace(A);
  await until('second A index ready', () => state.workspaceIndexReady);
  const owner = { ...watched };
  oldTree.resolve(node(A, 'stale-A.md')); await firstA;
  assert.equal(state.fileTree[0].name, 'fresh-A.md');
  assert.equal(state.wikiIndex.entries[0].path, A + '/fresh-A.md');
  assert.deepEqual(watched, owner);

  const tags = tagGate = Promise.withResolvers();
  await store.openWorkspace(A);
  await until('stale tag reply pending', () => tagGate === undefined);
  await store.openWorkspace(B);
  await store.openWorkspace(A);
  await until('new A tags applied', () => state.workspaceIndexReady);
  const currentTag = A + '/' + serial;
  tags.resolve(); await delay(0);
  assert.equal(state.workspaceIndexTags[0].name, currentTag);
  const stale = treeGate = Promise.withResolvers();
  const obsolete = store.openWorkspace(A);
  await until('old error pending', () => treeGate === undefined);
  await store.openWorkspace(B);
  stale.reject(Error('obsolete listing failed')); await obsolete;
  assert.equal(state.wikiIndexError, '');
  assert.equal(watched.root, B);
  await store.openWorkspace(A);
  const calls = treeCalls;
  store.scheduleWorkspaceKnowledgeRefresh([A + '/old.md'], watches[0]);
  store.scheduleWorkspaceKnowledgeRefresh([B + '/old.md'], watches.find(w => w.root === B));
  await delay(300); assert.equal(treeCalls, calls, 'late events from another root or epoch must not refresh');
  store.scheduleWorkspaceKnowledgeRefresh([A + '/fresh-A.md'], watched);
  await until('current watcher accepted', () => treeCalls > calls);
  console.log('Config read/write ordering, A→B→A trees/tags, late errors and watcher ownership passed.');
} finally { rmSync(tmp, { force: true, recursive: true }); }
