import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync('scripts/qa/performance-release-launcher.mjs', 'utf8');
const ast = ts.createSourceFile('launcher.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bridgeCall');
const bridgeCall = new Function('pageExpressionForBridge', 'monotonicMs', 'serializeError', 'DEFAULT_TIMEOUT_MS', `${declaration.getText(ast)}; return bridgeCall;`)((method, args) => JSON.stringify({ method, args }), () => 0, error => ({ message: String(error) }), 120_000);
for (const method of ['verify', 'reset', 'prepareOperation', 'completeOperation', 'open']) {
  let observed;
  const client = { evaluate: async (expression, timeout = 15_000) => { observed = { expression, timeout }; return 'ok'; } };
  assert.equal(await bridgeCall(client, method, ['fixture']), 'ok');
  assert.equal(observed.timeout, method === 'verify' || method === 'reset' ? 120_000 : 15_000, `${method}: unmeasured whole-document correctness needs its own budget; operation timing budget stays unchanged`);
}
const unavailable = { evaluate: async () => { throw new Error('CDP command timeout: Runtime.evaluate'); } };
await assert.rejects(bridgeCall(unavailable, 'verify'), /CDP command timeout/);
assert.equal(unavailable.rendererUnresponsive, true, 'real timeout must still fail fast after the correctness budget expires');
console.log('Performance RPC budgets passed: verify/reset120s outside measured phases; operation/default15s unchanged; true timeout still fails fast.');
