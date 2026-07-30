import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

const root = process.cwd();
const sourcePath = path.join(root, "src", "utils", "writingModes.ts");
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-writing-modes-"));
const tempPath = path.join(tempDir, "writingModes.mjs");

const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

try {
  const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  fs.writeFileSync(tempPath, transpiled, "utf8");
  const { sourceFocusRange, typewriterScrollDelta } = await import(pathToFileURL(tempPath).href);

  const state = (doc, position) =>
    EditorState.create({
      doc,
      selection: { anchor: position },
      extensions: [markdown()],
    });

  const paragraph = "first paragraph\n\nsecond paragraph";
  assert.deepEqual(
    sourceFocusRange(state(paragraph, paragraph.indexOf("second"))),
    { from: 17, to: 33, fromLine: 3, toLine: 3, nodeName: "Paragraph" },
  );

  const list = "- first\n  - nested\n- second\n";
  const nestedRange = sourceFocusRange(state(list, list.indexOf("nested")));
  assert.equal(nestedRange.nodeName, "ListItem");
  assert.equal(list.slice(nestedRange.from, nestedRange.to), "- first\n  - nested");
  const secondRange = sourceFocusRange(state(list, list.indexOf("second")));
  assert.equal(list.slice(secondRange.from, secondRange.to), "- second");

  for (const sample of [
    "# Heading\r\n\r\nParagraph",
    "> quote\n> continues",
    "```ts\nconst x = 1;\n```",
    "$$\nx^2\n$$",
    "---\ntitle: Demo\n---",
    "| A | B |\n|---|---|\n| 1 | 2 |",
  ]) {
    const position = Math.max(0, Math.floor(sample.length / 2));
    const range = sourceFocusRange(state(sample, position));
    assert.ok(range.from >= 0 && range.to <= sample.length && range.to >= range.from);
    assert.ok(range.fromLine >= 1 && range.toLine >= range.fromLine);
  }

  assert.equal(typewriterScrollDelta(400, 420, 0, 800), 0, "comfort band must not scroll");
  assert.equal(typewriterScrollDelta(100, 120, 0, 800), -290, "upper overflow targets 50%");
  assert.equal(typewriterScrollDelta(700, 720, 0, 800), 310, "lower overflow targets 50%");
  assert.equal(typewriterScrollDelta(10, 20, 20, 20), 0, "empty viewport is safe");

  const app = read("src/App.vue");
  const store = read("src/stores/appStore.ts");
  const layout = read("src/components/layout/AppLayout.vue");
  const sourceEditor = read("src/components/editor/SourceEditor.vue");
  const wysiwyg = read("src/components/editor/WysiwygEditor.vue");
  const settings = read("src/components/settings/SettingsDialog.vue");
  const command = read("src/components/command/CommandPalette.vue");
  const styles = read("src/styles/index.css");
  const rustModels = read("src-tauri/src/commands/models.rs");

  assert.match(app, /bindShortcut\("f8"/);
  assert.match(app, /bindShortcut\("f9"/);
  assert.match(app, /bindShortcut\("ctrl\+shift\+f11"/);
  assert.match(app, /event\.defaultPrevented[\s\S]*hasVisibleBlockingOverlay/);
  assert.match(store, /distractionFreeMode:\s*false/);
  assert.match(store, /toggleFocusMode/);
  assert.match(store, /toggleTypewriterMode/);
  assert.match(store, /toggleDistractionFreeMode/);
  assert.match(store, /大文件模式暂不支持专注模式与打字机模式/);
  assert.match(store, /focusMode:\s*false/);
  assert.match(store, /typewriterMode:\s*false/);
  assert.match(layout, /!appStore\.distractionFreeMode/);
  assert.match(layout, /按 Esc 退出/);
  assert.match(sourceEditor, /sourceFocusRange/);
  assert.match(sourceEditor, /scheduleSourceTypewriter/);
  assert.match(wysiwyg, /WritingFocusDecorations/);
  assert.match(wysiwyg, /scheduleWysiwygTypewriter/);
  assert.match(settings, /localSettings\.editor\.focusMode/);
  assert.match(settings, /localSettings\.editor\.typewriterMode/);
  assert.doesNotMatch(
    settings.match(/const experimentalGroups[\s\S]*?^];/m)?.[0] ?? "",
    /专注模式|打字机模式/,
  );
  assert.match(command, /切换专注模式/);
  assert.match(command, /切换打字机模式/);
  assert.match(command, /切换无干扰模式/);
  assert.match(styles, /\.lm-focus-dimmed[\s\S]*opacity:\s*0\.3/);
  assert.match(styles, /padding-top:\s*50vh/);
  assert.match(rustModels, /#\[serde\(default\)\]\s*pub focus_mode:\s*bool/);
  assert.match(rustModels, /#\[serde\(default\)\]\s*pub typewriter_mode:\s*bool/);

  console.log("Writing mode checks passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
