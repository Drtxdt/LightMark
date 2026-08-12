import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const sourcePath = path.join(root, "src", "utils", "snippets.ts");
const tempPath = path.join(root, "scripts", `.lightmark-snippets-${Date.now()}.mjs`);
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

try {
  fs.writeFileSync(tempPath, ts.transpileModule(read("src/utils/snippets.ts"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText, "utf8");
  const snippets = await import(pathToFileURL(tempPath).href);
  const fixed = new Date(2026, 7, 12, 9, 7);
  assert.deepEqual(
    snippets.expandSnippet("# ${date} ${time}\n${selection}\n${cursor}尾", { selection: "选中内容", now: fixed }),
    { markdown: "# 2026-08-12 09:07\n选中内容\n尾", cursorOffset: 24, usedSelection: true },
  );
  assert.deepEqual(
    snippets.expandSnippet("A${cursor}B${cursor}C", { selection: "", now: fixed }),
    { markdown: "ABC", cursorOffset: 1, usedSelection: false },
  );
  assert.deepEqual(
    snippets.expandSnippet("\\${cursor} ${cursor}", { selection: "", now: fixed }),
    { markdown: "${cursor} ", cursorOffset: 10, usedSelection: false },
  );
  assert.equal(snippets.validSnippetTrigger("会议"), true);
  assert.equal(snippets.validSnippetTrigger("bad trigger"), false);
  assert.equal(snippets.validSnippetTrigger("bad/trigger"), false);

  const normalized = snippets.normalizeSnippets([
    { id: "one", name: "会议", trigger: "meeting", description: "", markdown: "# ${date}", enabled: true },
    { id: "two", name: "重复", trigger: "MEETING", description: "", markdown: "x", enabled: true },
    { id: "three", name: "保留", trigger: "table", description: "", markdown: "x", enabled: true },
    { id: "four", name: "中文", trigger: "日报", description: "说明", markdown: "正文", enabled: false },
  ]);
  assert.deepEqual(normalized.map((item) => item.name), ["会议", "中文"]);
  assert.equal(snippets.snippetSlashCommands(normalized).length, 1);
  assert.ok(snippets.filterSlashCommands(snippets.builtinSlashCommands, "表格").some((item) => item.id === "table"));
  assert.ok(snippets.filterSlashCommands(snippets.builtinSlashCommands, "h6").some((item) => item.id === "heading-6"));

  const store = read("src/stores/appStore.ts");
  const command = read("src/components/command/CommandPalette.vue");
  const settings = read("src/components/settings/SettingsDialog.vue");
  const wysiwyg = read("src/components/editor/WysiwygEditor.vue");
  const source = read("src/components/editor/SourceEditor.vue");
  const large = read("src/components/editor/LargeMarkdownEditor.vue");
  const rust = read("src-tauri/src/commands/models.rs");
  assert.match(store, /capture-editor-target/);
  assert.match(store, /normalizeSnippets/);
  assert.match(command, /插入片段：/);
  assert.match(settings, /全局 Markdown 片段/);
  assert.match(settings, /validateSnippet/);
  assert.match(wysiwyg, /slash-command-menu/);
  assert.match(wysiwyg, /handleSlashMenuKeydown/);
  assert.match(wysiwyg, /insertSnippetIntoWysiwyg/);
  assert.match(source, /insertSnippetIntoSource/);
  assert.doesNotMatch(source, /slash-command-menu/);
  assert.match(large, /captureLargeEditorTarget/);
  assert.doesNotMatch(large, /slash-command-menu/);
  assert.match(rust, /pub snippets:\s*SnippetSettings/);
  assert.match(rust, /pub struct SnippetDefinition/);
  console.log("Snippet and slash command checks passed.");
} finally {
  fs.rmSync(tempPath, { force: true });
}
