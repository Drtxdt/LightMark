import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runNativeNormalDocumentProbe } from './qa/native-normal-document-probe.mjs';

const target = { url: 'http://127.0.0.1:99/?lightmarkQa=owned', webSocketDebuggerUrl: 'ws://127.0.0.1:22/owned' };
const operations = new Map();
let calls = 0;
const crossTabPolls = { canRedo: 0, canUndo: 0 };
const client = {
  url: target.webSocketDebuggerUrl,
  async evaluate(expression, timeout) {
    calls++;
    assert.ok(timeout <= 5000);
    new vm.Script(expression);
    if (expression.includes("state: 'running'")) {
      const label = JSON.parse(expression.match(/q\.operations\[(".*?")\]/)[1]);
      const value = label === 'owned NodeView twice disk saves' ? { status: 'passed', cases: Array.from({ length: 7 }, (_, index) => ({ kind: `nodeview-${index}`, passed: true, saves: Array.from({ length: 2 }, () => ({ saved: true, diskExact: true, pendingCleared: true, renderedClean: true, focusPreserved: true, sameControl: true, selectionPreserved: true })) })) }
        : label === 'production source provenance cases' ? { status: 'passed', cases: Array.from({ length: 7 }, (_, index) => ({ name: `provenance-${index}`, passed: true })) }
        : label === 'owned asynchronous command cases' ? { status: 'passed', cases: Array.from({ length: 5 }, (_, index) => ({ name: `mock-${index}`, passed: true })) } : label === 'production fine source parser cases' ? [] : label.endsWith('two snapshots')
        ? { kind: label.split(' ')[0], firstExact: true, secondExact: true, focused: true, blurs: 0, pending: false, dirty: true }
        : label.startsWith('undo ') || label.startsWith('redo ') ? { changed: true, exact: true }
          : { exact: true, sourceBytesRestored: true, diskUnchanged: true, formalSnapshotExact: true, nodeStructurePreserved: true, savedDiskExact: true, savedTabRenderedClean: true };
      operations.set(label, { state: 'fulfilled', value });
      return { started: true };
    }
    if (expression.includes('return q.operations[')) {
      const label = JSON.parse(expression.match(/return q\.operations\[(".*?")\]/)[1]);
      return operations.get(label);
    }
    if (expression.includes('q.initializationError')) return { ok: true };
    if (expression.includes('selectors.every')) return { ok: true };
    if (expression.includes('return { ok:')) return { ok: true };
    if (expression.includes('q.control.dispatchEvent')) return { focused: true, dirty: true, pending: true };
    if (expression.includes('canUndo: history.canUndo')) return { canUndo: false };
    if (expression.includes('q.crossTabTrace.push(state)')) {
      const key = expression.includes('.canRedo') ? 'canRedo' : 'canUndo';
      return { available: crossTabPolls[key]++ === 0 };
    }
    return {};
  },
};
const context = { runToken: 'nonce', identifier: 'com.lightmark.qa.test', fixturePath: 'E:/owned/a.md', fixtureContent: '---\na: b\n---',
  expectedAppConfigDir: 'E:/owned/config', expectedAppDataDir: 'E:/owned/data', expectedAppLocalDataDir: 'E:/owned/local',
  manifest: { isolation: { preexistingPathsChecked: true }, launch: { phases: [{ target, targetNonce: 'owned', pid: 1, loopback: {} }] } },
};
const result = await runNativeNormalDocumentProbe(client, context);
assert.equal(result.status, 'passed');
assert.equal(result.nodeViews.length, 4);
assert.equal(result.history.length, 6);
assert.equal(result.contentIntegrity.length, 7);
assert.equal(result.sourceProvenanceCases.cases.length, 7);
assert.equal(result.pendingCommands.cases.length, 5);
assert.equal(result.nodeViewSaves.cases.length, 7);
assert.equal(result.acrossTabs.redo, 1);
assert.equal(result.acrossTabs.undo, 1);
assert.equal(result.nativeKeyboardOrIMEClaimed, false);
assert.equal(result.browserTimersUsedForWaiting, false);
const staleSaveMarkerClient = { ...client, async evaluate(expression, timeout) {
  const value = await client.evaluate(expression, timeout);
  if (expression.includes('return q.operations[') && expression.includes('formal save and structure')) {
    return { ...value, value: { ...value.value, savedTabRenderedClean: false } };
  }
  return value;
} };
const staleSaveMarkerResult = await runNativeNormalDocumentProbe(staleSaveMarkerClient, context);
assert.equal(staleSaveMarkerResult.status, 'failed', 'disk success with a stale rendered dirty marker must fail native acceptance');
assert.equal(staleSaveMarkerResult.contentIntegrityFailures.length, 7);
let pendingRanAfterHistoryFailure = false;
const historyFailureClient = { ...client, async evaluate(expression, timeout) {
  if (expression.includes('cross-tab history changed its content boundary')) throw new Error('injected cross-tab boundary failure');
  if (expression.includes("state: 'running'") && expression.includes('owned asynchronous command cases')) pendingRanAfterHistoryFailure = true;
  return client.evaluate(expression, timeout);
} };
const failedResult = await runNativeNormalDocumentProbe(historyFailureClient, context);
assert.equal(failedResult.status, 'failed');
assert.match(failedResult.acrossTabs.error, /injected cross-tab/);
assert.equal(pendingRanAfterHistoryFailure, true, 'history failures must retain red evidence and still exercise the independent pending cases');
for (const failure of ['rejected', 'missing-case', 'failed-case']) {
  const provenanceFailureClient = { ...client, async evaluate(expression, timeout) {
    const value = await client.evaluate(expression, timeout);
    if (expression.includes('return q.operations["production source provenance cases"]')) {
      if (failure === 'rejected') return { state: 'rejected', error: 'injected provenance helper failure' };
      const cases = [...value.value.cases];
      if (failure === 'missing-case') cases.pop();
      else cases[0] = { ...cases[0], passed: false };
      return { state: 'fulfilled', value: { status: 'passed', cases } };
    }
    return value;
  } };
  const provenanceFailure = await runNativeNormalDocumentProbe(provenanceFailureClient, context);
  assert.equal(provenanceFailure.status, 'failed', `provenance ${failure} must fail ordinary native QA`);
  assert.equal(provenanceFailure.pendingCommands.status, 'passed', 'independent pending cases still execute');
}
for (const failure of ['missing-case', 'missing-save', 'dirty-tab', 'lost-focus']) {
  const nodeViewFailureClient = { ...client, async evaluate(expression, timeout) {
    const value = await client.evaluate(expression, timeout);
    if (!expression.includes('return q.operations["owned NodeView twice disk saves"]')) return value;
    const cases = structuredClone(value.value.cases);
    if (failure === 'missing-case') cases.pop();
    if (failure === 'missing-save') cases[0].saves.pop();
    if (failure === 'dirty-tab') cases[0].saves[1].renderedClean = false;
    if (failure === 'lost-focus') cases[0].saves[1].focusPreserved = false;
    return { state: 'fulfilled', value: { status: 'passed', cases } };
  } };
  assert.equal((await runNativeNormalDocumentProbe(nodeViewFailureClient, context)).status, 'failed', `NodeView ${failure} must fail acceptance`);
}
await assert.rejects(runNativeNormalDocumentProbe({ ...client, url: 'ws://foreign/target' }, context), /owned launcher target/);
console.log(`Normal-document host-probe syntax/orchestration passed (${calls} short mock evaluations; native behavior is not claimed).`);
