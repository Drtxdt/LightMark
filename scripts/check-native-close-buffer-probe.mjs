import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runNativeCloseBufferProbe } from './qa/native-close-buffer-probe.mjs';

const target = { url: 'http://127.0.0.1:99/?lightmarkQa=owned', webSocketDebuggerUrl: 'ws://127.0.0.1:22/owned' };
let open = false, calls = 0;
const client = {
  url: target.webSocketDebuggerUrl,
  async evaluate(expression, timeout) {
    calls++;
    assert.ok(timeout <= 5000, 'each CDP evaluation must be bounded independently');
    new vm.Script(expression); // Validate every generated expression, including nested operation bodies.
    if (expression.includes('q.initializationError')) return { ok: true };
    if (expression.includes('q.operations[') && expression.includes("state: 'running'")) {
      if (expression.includes('q.store.openFile')) open = true;
      return { started: true };
    }
    if (expression.includes("const views =")) return { ok: true, views: 1 };
    if (expression.includes('const matches =')) return { ok: true, dialogs: [{ buttons: ['取消', '不保存'] }], activeDialog: { title: 'close' } };
    if (expression.includes('buttons[0].click()')) {
      if (expression.includes('=== "不保存"')) open = false;
      return { clicked: true };
    }
    if (expression.includes('return { open:')) return { open, dirty: true };
    if (expression.includes("q.control.dispatchEvent(new Event('input'")) return { focused: true, dirty: true, pending: true };
    if (expression.includes('operation?.state')) return { ok: true, operations: {}, dialogs: [] };
    if (expression.includes('return q.operations[')) return { state: 'fulfilled', value: null };
    if (expression.includes('Boolean(q.editorRoot()')) return { ok: true };
    return {};
  },
};
const context = { runToken: 'nonce', identifier: 'com.lightmark.qa.test', fixturePath: 'E:/owned/a.md', fixtureContent: '---\na: b\n---',
  expectedAppConfigDir: 'E:/owned/config', expectedAppDataDir: 'E:/owned/data', expectedAppLocalDataDir: 'E:/owned/local',
  manifest: { isolation: { preexistingPathsChecked: true }, launch: { phases: [{ target, targetNonce: 'owned', pid: 1, loopback: {} }] } },
};
const result = await runNativeCloseBufferProbe(client, context);
assert.equal(result.status, 'passed');
assert.equal(result.cases.length, 6);
assert.ok(calls >= 60);
assert.equal(result.browserTimersUsedForWaiting, false);
assert.equal(result.nativeKeyboardOrIMEClaimed, false);
await assert.rejects(runNativeCloseBufferProbe({ ...client, url: 'ws://127.0.0.1:22/foreign' }, context), /owned launcher target/);
console.log(`Host-polled close-probe orchestration/syntax passed (${calls} short mock evaluations; native close is not claimed).`);
