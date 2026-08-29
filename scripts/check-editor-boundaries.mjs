import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (value) => fs.readFileSync(path.resolve(value), "utf8");
const pureEditorModules = [
  "src/editor/wysiwygDerived.ts",
  "src/editor/wysiwygFind.ts",
  "src/editor/wysiwygFocus.ts",
  "src/editor/wysiwygSnapshot.ts",
  "src/editor/wysiwygTables.ts",
  "src/editor/sourceOutlineIndex.ts",
];

for (const file of pureEditorModules) {
  const source = read(file);
  assert.doesNotMatch(source, /stores\/appStore|@tauri-apps|from ["']vue["']/, `${file} crossed the editor-core boundary`);
}

const wysiwyg = read("src/components/editor/WysiwygEditor.vue");
for (const moduleName of ["wysiwygDerived", "wysiwygFind", "wysiwygFocus", "wysiwygSnapshot", "wysiwygTables"]) {
  assert.match(wysiwyg, new RegExp(moduleName), `WYSIWYG assembly did not use ${moduleName}`);
}

const appStore = read("src/stores/appStore.ts");
assert.doesNotMatch(appStore, /["']workspace_(?:index|query)_[^"']+["']/, "appStore issued raw workspace-index commands");
assert.match(appStore, /DocumentSnapshotCoordinator/);
assert.match(appStore, /workspaceIndexClient/);
assert.match(read("src-tauri/src/commands/workspace_index.rs"), /mod service;/);
assert.match(read("src-tauri/src/commands/workspace_index/service.rs"), /struct WorkspaceIndexService/);

console.log("editor, store, and workspace service boundary checks passed");
