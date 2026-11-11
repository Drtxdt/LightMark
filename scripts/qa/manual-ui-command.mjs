import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
assert.ok(args.includes('--control') && args.includes('--expression-file'), 'Pass --control and --expression-file');
const controlPath = await realpath(value('--control'));
const ownedRoot = await realpath(path.resolve('.cache/plan-native-tests'));
assert.ok(controlPath.toLowerCase().startsWith(ownedRoot.toLowerCase() + path.sep), 'Only this task isolated native runs are allowed');
const control = JSON.parse(await readFile(controlPath, 'utf8'));
assert.equal(control.status, 'ready');
assert.ok(control.identifier.startsWith('com.lightmark.qa.'));
assert.equal(control.controlPath.toLowerCase(), controlPath.toLowerCase());
const commandPath = path.join(path.dirname(controlPath), 'manual-ui-command.json');
const resultPath = path.join(path.dirname(controlPath), 'manual-ui-result.json');
const expression = await readFile(value('--expression-file'), 'utf8');
const id = randomUUID();
await writeFile(commandPath, JSON.stringify({ id, expression }), 'utf8');
const started = Date.now();
while (Date.now() - started < 15000) {
  try {
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    if (result.id === id) { console.log(JSON.stringify(result)); if (result.error) process.exitCode = 1; break; }
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  await delay(75);
}
if (Date.now() - started >= 15000) throw new Error(`Owned manual UI command timed out: ${id}`);
