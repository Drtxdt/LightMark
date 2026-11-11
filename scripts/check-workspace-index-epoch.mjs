import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const calls = [];
const exports = {};
const context = vm.createContext({ exports, require(name) {
  assert.equal(name, '@tauri-apps/api/core');
  return { invoke: async (command, args) => { calls.push({ command, args }); return {}; } };
} });
vm.runInContext(ts.transpileModule(fs.readFileSync('src/stores/workspaceIndexClient.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);

await exports.workspaceIndexClient.updateOpenDocument('E:/vault/A.md', 41, 300, '# A');
await exports.workspaceIndexClient.releaseOpenDocument('E:/vault/A.md', 41, 301);
assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
  { command: 'workspace_index_update_open_document', args: { path: 'E:/vault/A.md', epoch: 41, revision: 300, markdown: '# A' } },
  { command: 'workspace_index_release_open_document', args: { path: 'E:/vault/A.md', epoch: 41, revision: 301 } },
]);
console.log('Workspace update and release carry exact document epoch/revision coordinates.');
