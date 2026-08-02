import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-image-copy-"));
try {
  const source = fs.readFileSync(path.join(root, "src/utils/imageCompression.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(tempDir, "imageCompression.mjs");
  fs.writeFileSync(modulePath, output);
  const compression = await import(pathToFileURL(modulePath).href);
  const settings = {
    pasteCompressionEnabled: true,
    pasteCompressionThresholdBytes: 2 * 1024 * 1024,
    pasteCompressionMaxDimension: 2560,
  };

  assert.deepEqual(
    compression.decidePastedImageCompression({ size: 1000, type: "image/png" }, { width: 800, height: 600 }, settings),
    { supported: true, shouldProcess: false, resizeRequired: false, outputWidth: 800, outputHeight: 600, skipReason: "below-threshold" },
  );
  assert.deepEqual(
    compression.decidePastedImageCompression({ size: 1000, type: "image/jpeg" }, { width: 5120, height: 2880 }, settings),
    { supported: true, shouldProcess: true, resizeRequired: true, outputWidth: 2560, outputHeight: 1440 },
  );
  assert.equal(
    compression.decidePastedImageCompression({ size: 3 * 1024 * 1024, type: "image/webp" }, { width: 1200, height: 800 }, settings).shouldProcess,
    true,
  );
  assert.equal(
    compression.decidePastedImageCompression({ size: 4 * 1024 * 1024, type: "image/gif" }, { width: 4000, height: 2000 }, settings).skipReason,
    "unsupported-format",
  );
  assert.equal(
    compression.decidePastedImageCompression({ size: 4 * 1024 * 1024, type: "image/png" }, { width: 4000, height: 2000 }, { ...settings, pasteCompressionEnabled: false }).skipReason,
    "disabled",
  );
  const fixedDate = new Date(2026, 7, 2, 9, 8, 7);
  assert.equal(compression.pastedImageFileName({ name: "clipboard-123.png", type: "image/png" }, "preserve", fixedDate), "image-20260802-090807.png");
  assert.equal(compression.pastedImageFileName({ name: "设计稿.webp", type: "image/webp" }, "preserve", fixedDate), "设计稿.webp");
  assert.equal(compression.pastedImageFileName({ name: "photo.jpg", type: "image/jpeg" }, "timestamp", fixedDate), "image-20260802-090807.jpg");

  const assets = fs.readFileSync(path.join(root, "src/utils/imageAssets.ts"), "utf8");
  const wysiwyg = fs.readFileSync(path.join(root, "src/components/editor/WysiwygEditor.vue"), "utf8");
  const sourceEditor = fs.readFileSync(path.join(root, "src/components/editor/SourceEditor.vue"), "utf8");
  const copy = fs.readFileSync(path.join(root, "src/utils/clipboardCopy.ts"), "utf8");
  const settingsDialog = fs.readFileSync(path.join(root, "src/components/settings/SettingsDialog.vue"), "utf8");
  const store = fs.readFileSync(path.join(root, "src/stores/appStore.ts"), "utf8");
  const rustModels = fs.readFileSync(path.join(root, "src-tauri/src/commands/models.rs"), "utf8");

  assert.match(assets, /options\.source === "clipboard"/);
  assert.match(wysiwyg, /insertImageFilesIntoWysiwyg\(files, insertAt, insertAt, "drop"\)/);
  assert.match(sourceEditor, /position \?\? currentView\.state\.doc\.length, "drop"/);
  assert.match(wysiwyg, /writeClipboardPayloadToEvent/);
  assert.match(wysiwyg, /copy\(view, event\)/);
  assert.match(wysiwyg, /cut\(view, event\)/);
  assert.match(wysiwyg, /复制为纯文本/);
  assert.match(copy, /text\/plain/);
  assert.match(copy, /text\/html/);
  assert.match(copy, /name\.startsWith\("data-"\)/);
  assert.match(copy, /contenteditable/);
  assert.match(copy, /figure\[data-lightmark-image\]/);
  assert.match(settingsDialog, /pasteCompressionThresholdBytes/);
  assert.match(settingsDialog, /附件目录必须是文档目录内的相对路径/);
  assert.match(store, /pasteCompressionThresholdBytes:\s*2 \* 1024 \* 1024/);
  assert.match(rustModels, /default_paste_compression_threshold_bytes/);
  console.log("Image compression and clipboard copy checks passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
