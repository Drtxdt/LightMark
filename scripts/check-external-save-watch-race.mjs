import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-watch-race-'));
try {
  const { DocumentDiskWriteFence } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/documentDiskWriteFence.ts'), temp)).href);
  const source = fs.readFileSync('src/stores/appStore.ts', 'utf8');
  const ast = ts.createSourceFile('appStore.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['checkOpenFileSnapshots', 'updateTabExternalState', 'externalStateForSnapshot', 'clearTabExternalState', 'snapshotsMatch', 'snapshotKey', 'rememberWrittenDiskBaseline'];
  const functions = names.map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name); return node.getText(ast).replace(/^export\s+/, '');
  }).join('\n');
  const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const tab = { id: 'original', kind: 'normal', path: 'A.md', fileSnapshot: { exists: true, mtime: 1, size: 1 }, externalState: 'clean' };
  const appStore = { tabs: [tab] };
  const fileWriteFence = new DocumentDiskWriteFence();
  const reads = [];
  const dependencies = { appStore, fileWriteFence, queueMicrotask, Date, toRaw: value => value,
    getFileSnapshot: path => new Promise(resolve => reads.push({ path, resolve })), findSimilarFileCandidates: async () => [],
  };
  const check = new Function(...Object.keys(dependencies), `let externalFileCheckInFlight=false, externalFileCheckQueued=false;${compiled};return checkOpenFileSnapshots;`)(...Object.values(dependencies));
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const oldStat = check(); await settle();
  assert.equal(reads.length, 1);
  // Own save commits while an old metadata read is still in transit.
  tab.fileSnapshot = { exists: true, mtime: 2, size: 2 }; tab.externalState = 'clean';
  reads.shift().resolve({ exists: true, mtime: 1, size: 1 }); await oldStat; await settle();
  assert.equal(tab.externalState, 'clean', 'pre-save stat must not be compared with the post-save baseline');
  while (reads.length) reads.shift().resolve(tab.fileSnapshot);
  await settle();
  // A watcher event arriving during a read must trigger a fresh read afterward.
  const first = check(); await settle();
  await check();
  reads.shift().resolve(tab.fileSnapshot); await first; await settle();
  assert.equal(reads.length, 1, 'coalescing an in-flight event must schedule one final fresh stat');
  reads.shift().resolve({ exists: true, mtime: 3, size: 3 }); await settle();
  assert.equal(tab.externalState, 'modified');
  tab.externalState = 'clean';
  const lease = fileWriteFence.begin(tab.path);
  await check();
  assert.equal(reads.length, 0, 'own writes defer external metadata classification');
  const captured = fileWriteFence.capture(tab.path); fileWriteFence.finish(lease);
  assert.equal(fileWriteFence.canPublish(captured), false);
  const after = fileWriteFence.capture(tab.path), secondLease = fileWriteFence.begin(tab.path);
  assert.equal(fileWriteFence.canPublish(after), false); fileWriteFence.finish(secondLease);
  assert.equal(fileWriteFence.canPublish(after), false, 'completed own writes invalidate earlier stat observations too');
  const left = fileWriteFence.begin('left'), right = fileWriteFence.begin('right');
  fileWriteFence.finish(left); fileWriteFence.finish(left);
  assert.equal(fileWriteFence.capture('left').active, false); assert.equal(fileWriteFence.capture('right').active, true);
  fileWriteFence.finish(right);
  // The transaction retains an independent output copy for recovery. Its mtime
  // differs from the installed target even though both contain identical bytes.
  const remember = new Function('isTabRegistered', `${compiled};return rememberWrittenDiskBaseline;`)(() => true);
  const installed = { sizeBytes: 42, modifiedMillis: 100, sha256: 'new-content' };
  remember({ tab }, tab.path, { path: tab.path, outcome: 'committed', diskWritten: 'yes',
    targetFingerprint: installed, outputFingerprint: { ...installed, modifiedMillis: 200 } });
  assert.equal(tab.fileSnapshot.mtime, 100, 'save baseline must use the installed target, not the independent recovery output copy');
  assert.equal(tab.fileSnapshot.fingerprint, installed);
  console.log('Production file monitor fences pre-save reads, queues overlapping events and defers own writes; write leases are isolated and idempotent.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
