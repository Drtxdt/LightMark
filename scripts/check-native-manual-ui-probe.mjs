import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runNativeManualUiProbe } from './qa/native-manual-ui-probe.mjs';

const root = path.resolve('node_modules');
const temp = fs.mkdtempSync(path.join(root, '.lightmark-manual-ui-'));
try {
  const target = { url: 'http://127.0.0.1:99/?lightmarkQa=owned', webSocketDebuggerUrl: 'ws://127.0.0.1:22/owned' };
  let commandExecutions = 0, finishPolls = 0, evaluations = 0;
  let bootstrap;
  const client = { url: target.webSocketDebuggerUrl, async evaluate(expression, timeout) {
    evaluations++; assert.ok(timeout <= 5000); new vm.Script(expression);
    if (expression.includes('q.captureSnapshot = async')) bootstrap = expression;
    if (expression === '1 + 2') { commandExecutions++; return 3; }
    if (expression.includes('ready: q?.ready')) return { ready: true, state: { mode: 'wysiwyg' } };
    if (expression.includes('finishRequest ?? null')) return ++finishPolls >= 2 ? { status: 'passed', evidence: { mock: true } } : null;
    if (expression.includes('keyboardEvents: q.keyboardEvents')) return { notes: [], snapshots: [], errors: [], keyboardEvents: [], state: {} };
    return {};
  } };
  const context = { runToken: 'test', identifier: 'com.lightmark.qa.test', fixturePath: path.join(temp, 'fixture.md'), fixtureContent: '# owned', runDir: temp,
    expectedAppConfigDir: 'C:/owned/config', expectedAppDataDir: 'C:/owned/data', expectedAppLocalDataDir: 'C:/owned/local',
    manifest: { isolation: { preexistingPathsChecked: true }, launch: { phases: [{ target, targetNonce: 'owned', pid: 1, cdpPort: 22, vitePort: 99, loopback: {} }] } },
  };
  fs.writeFileSync(path.join(temp, 'manual-ui-command.json'), JSON.stringify({ id: 'once', expression: '1 + 2' }));
  const result = await runNativeManualUiProbe(client, context);
  assert.equal(result.status, 'passed');
  assert.equal(result.keyboardImeAutomaticallyClaimed, false);
  assert.equal(commandExecutions, 1, 'an unchanged mailbox id must never execute twice');
  assert.equal(result.commands.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(result.resultPath, 'utf8')).result, 3);
  assert.equal(JSON.parse(fs.readFileSync(result.controlPath, 'utf8')).status, 'finished');
  const captureBody = bootstrap.slice(bootstrap.indexOf('q.captureSnapshot = async'), bootstrap.indexOf('q.startOperation ='));
  const identity = {}; identity.view = identity;
  const q = { runtime: { snapshotDocumentTab: async () => ({ tabId: 'owned', revision: 7, markdown: '# raw\r\n', dirty: true,
    mutationToken: { documentGeneration: 3, pendingInputVersion: 4, revision: 7 }, flushReceipt: { sessionIdentity: identity } }) },
    tabId: 'owned', snapshots: [], state: () => ({ mode: 'wysiwyg' }) };
  vm.runInNewContext(captureBody, { q, Date });
  await q.captureSnapshot('circular-receipt');
  const serialized = JSON.stringify(q.snapshots);
  assert.equal(JSON.parse(serialized)[0].snapshot.markdown, '# raw\r\n');
  assert.equal(JSON.parse(serialized)[0].snapshot.mutationToken.revision, 7);
  assert.ok(!serialized.includes('sessionIdentity'), 'evidence must exclude the circular live editor identity');
  await assert.rejects(runNativeManualUiProbe({ ...client, url: 'ws://foreign' }, context));
  console.log(`Manual UI probe syntax/mailbox checks passed (${evaluations} bounded mock evaluations; no native IME success is claimed).`);
} finally {
  assert.ok(path.resolve(temp).startsWith(root + path.sep), 'cleanup stays inside the generated workspace test directory');
  fs.rmSync(temp, { recursive: true, force: true });
}
