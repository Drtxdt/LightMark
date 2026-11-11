import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-large-client-'));
const previousWindow = globalThis.window;
try {
  const calls = [];
  let responder;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => { calls.push({ command, args }); return responder(command, args); } } };
  const clientPath = compileTypeScriptModuleGraph(path.resolve('src/editor/largeSourceClient.ts'), temp);
  const client = await import(pathToFileURL(clientPath).href);
  assert.throws(() => client.observeLargeSourceReceipts('release-session', () => {}), /only in development/);
  const identity = { sessionId: 'owned-500MiB', revision: 23, coordinateSpace: 'utf16-code-units' };
  const state = { isDirty: true, revision: 23, savedRevision: 20, pendingEditCount: 2, coordinateSpace: identity.coordinateSpace };
  client.assertLargeStateReceipt(state, state);
  for (const patch of [{ revision: 22 }, { savedRevision: 19 }, { savedRevision: 24 }, { revision: undefined }, { pendingEditCount: -1 }, { isDirty: undefined }, { coordinateSpace: 'bytes' }]) {
    assert.throws(() => client.assertLargeStateReceipt({ ...state, ...patch }, state), /完成回执/);
  }
  const range = { ...identity, startLine: 0, startColumn: 400000000, endLine: 0, endColumn: 400000004,
    totalLines: 1, text: '中😀', truncated: true };
  responder = () => ({ ...range });
  assert.deepEqual(await client.readLargeSourceRange(identity, { start: { line: 0, column: 400000000 } }), range);
  assert.equal(calls.at(-1).args.expectedRevision, 23);
  assert.equal(calls.at(-1).args.maxBytes, 262144);
  for (const patch of [{ sessionId: 'wrong' }, { revision: 22 }, { coordinateSpace: 'bytes' }, { text: '中'.repeat(100000) }]) {
    responder = () => ({ ...range, ...patch });
    await assert.rejects(client.readLargeSourceRange(identity, { start: { line: 0, column: 0 } }), /回执/);
  }
  responder = () => ({ ...identity, line: 14, column: 7 });
  assert.deepEqual(await client.resolveLargeSourcePosition(identity, { line: 15, column: 0 }, 'previous'), { line: 14, column: 7 });
  assert.equal(calls.at(-1).command, 'resolve_large_position');
  assert.equal(calls.at(-1).args.mode, 'previous');
  for (const patch of [{ sessionId: 'other' }, { revision: 22 }, { line: -1 }, { column: 1.5 }, { coordinateSpace: 'bytes' }]) {
    responder = () => ({ ...identity, line: 14, column: 7, ...patch });
    await assert.rejects(client.resolveLargeSourcePosition(identity, { line: 15, column: 0 }, 'previous'), /导航回执/);
  }
  let polls = 0;
  responder = (command, args) => {
    if (command === 'start_large_search_job') return { ...identity, jobId: 'job-1', kind: 'search', status: 'running', progress: 0 };
    if (command === 'poll_large_job') {
      assert.equal(args.sessionId, identity.sessionId);
      assert.equal(args.expectedRevision, 23);
      polls++;
      return { ...identity, jobId: 'job-1', kind: 'search', status: 'completed', progress: 1, result: { matches: ['owned'] } };
    }
    throw new Error(command);
  };
  assert.deepEqual(await client.runLargeSourceJob(identity, 'search', { query: 'needle' }), { matches: ['owned'] });
  assert.equal(polls, 1); assert.equal(client.largeSourceJobs.size, 0);
  const cancelledBeforeStart = new AbortController(); cancelledBeforeStart.abort();
  const beforeCancelledCalls = calls.length;
  await assert.rejects(client.runLargeSourceJob(identity, 'search', { query: 'obsolete' }, cancelledBeforeStart.signal), error => error.name === 'AbortError');
  assert.equal(calls.length, beforeCancelledCalls, 'an obsolete queued search must not start backend I/O');
  let releaseStart;
  const startingController = new AbortController();
  responder = (command, args) => {
    if (command === 'start_large_search_job') return new Promise(resolve => { releaseStart = () => resolve({ ...identity, jobId: 'abort-during-start', kind: 'search', status: 'running', progress: 0 }); });
    assert.equal(command, 'cancel_large_job'); assert.equal(args.jobId, 'abort-during-start');
    assert.equal(args.sessionId, identity.sessionId); assert.equal(args.expectedRevision, identity.revision);
  };
  const starting = client.runLargeSourceJob(identity, 'search', { query: 'old' }, startingController.signal);
  startingController.abort(); releaseStart();
  await assert.rejects(starting, error => error.name === 'AbortError');
  assert.equal(calls.at(-1).command, 'cancel_large_job');
  assert.equal(client.largeSourceJobs.size, 0);
  responder = () => ({ ...identity, jobId: 'job-2', kind: 'replace', status: 'cancelled', progress: 0.4 });
  await assert.rejects(client.runLargeSourceJob(identity, 'replace', {}), /已取消/);
  assert.equal(client.largeSourceJobs.size, 0);
  const devPath = clientPath.replace(/\.mjs$/, '.dev.mjs');
  const compiled = fs.readFileSync(clientPath, 'utf8');
  assert.ok(compiled.includes('import.meta.env?.DEV'));
  fs.writeFileSync(devPath, compiled.replaceAll('import.meta.env?.DEV', 'true'));
  const dev = await import(pathToFileURL(devPath).href);
  let committed = 0, releaseAck, observed = 0, frontendCompleted = false;
  const gate = new Promise(resolve => { releaseAck = resolve; });
  responder = (_command, args) => ({ sessionId: args.sessionId, operationId: args.operationId, revision: ++committed });
  const remove = dev.observeLargeSourceReceipts('held-session', async (_command, args, receipt) => {
    assert.equal(receipt.operationId, args.operationId); observed++; await gate;
  });
  const held = dev.invokeLargeSource('apply_file_operation', { sessionId: 'held-session', operationId: 'operation-1' }).then(result => { frontendCompleted = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(committed, 1); assert.equal(frontendCompleted, false); assert.equal(observed, 1);
  await dev.invokeLargeSource('apply_file_operation', { sessionId: 'unrelated-session', operationId: 'operation-2' });
  assert.equal(observed, 1, 'an unrelated session cannot consume the receipt gate');
  releaseAck(); assert.equal((await held).operationId, 'operation-1');
  remove(); await dev.invokeLargeSource('apply_file_operation', { sessionId: 'held-session', operationId: 'operation-3' });
  assert.equal(observed, 1);
  responder = () => ({ ...identity, revision: 24, jobId: 'wrong-generation', kind: 'search', status: 'completed', progress: 1, result: 'must not publish' });
  await assert.rejects(client.runLargeSourceJob(identity, 'search', {}), /不属于/);
  assert.equal(client.largeSourceJobs.size, 0);
  console.log('Large source client checks passed: request fences, UTF-8 cap, stale receipts, job progress, cancellation, cleanup.');
} finally {
  globalThis.window = previousWindow;
  fs.rmSync(temp, { recursive: true, force: true });
}
