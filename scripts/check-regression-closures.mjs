import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [wysiwyg, appStore, settings, appDialog, overlay, command, quickOpen, heading, goToLine] = await Promise.all([
  read("src/components/editor/WysiwygEditor.vue"),
  read("src/stores/appStore.ts"),
  read("src/components/settings/SettingsDialog.vue"),
  read("src/components/dialog/AppDialog.vue"),
  read("src/composables/useOverlayFocus.ts"),
  read("src/components/command/CommandPalette.vue"),
  read("src/components/command/QuickOpenPalette.vue"),
  read("src/components/command/HeadingJumpPalette.vue"),
  read("src/components/command/GoToLinePalette.vue"),
]);

assert.match(wysiwyg, /wysiwygFormatHistory\.undo\.push/);
assert.match(wysiwyg, /before:\s*event\.detail\.source/);
assert.match(wysiwyg, /setMeta\("addToHistory", false\)/);
assert.match(wysiwyg, /const markdown = paneContent\.value;/);
const wysiwygUpdate = wysiwyg.match(/onUpdate\(\{ editor, transaction \}\)[\s\S]*?\n  },/)?.[0] ?? "";
assert.match(wysiwyg, /registerDocumentSession/);
assert.match(wysiwyg, /blocks:\s*\(\) => \{[\s\S]*?currentEditor\.state\.doc\.forEach/);
assert.match(wysiwyg, /serializeBlock:\s*\(block\)[\s\S]*?DOMSerializer\.fromSchema/);
assert.match(wysiwyg, /convertBlock:\s*\(html\) => editorHtmlToMarkdown\(html\)/);
assert.match(wysiwyg, /oracle:\s*\(previousMarkdown\)[\s\S]*?currentEditor\.getHTML\(\)/);
assert.doesNotMatch(wysiwygUpdate, /getHTML|editorHtmlToMarkdown|setPaneContent/,
  "WYSIWYG input updates must not serialize or copy the full document");
assert.match(wysiwygUpdate, /markDocumentChanged/);
assert.doesNotMatch(
  wysiwyg.match(/function handleModeCursorCapture[\s\S]*?\n}/)?.[0] ?? "",
  /setPaneContent/,
  "mode switches must not mark a document dirty or reserialize Markdown",
);

assert.match(appStore, /function closeTransientPalettes/);
assert.match(appStore, /lightmark:close-transient-editor-ui/);
assert.match(overlay, /window\.addEventListener\("keydown", handleKeydown, true\)/);
assert.match(overlay, /event\.stopImmediatePropagation\(\)/);
assert.match(overlay, /requestAnimationFrame/);
assert.match(overlay, /getClientRects\(\)\.length > 0/);
assert.match(overlay, /overlayZIndex/);
assert.match(overlay, /!panel\?\.contains\(activeElement\)/);
assert.match(overlay, /\.lm-modal-backdrop, \.dialog-backdrop/);
assert.match(overlay, /closingBackdrop/);
assert.doesNotMatch(
  overlay.match(/function isTopmost[\s\S]*?\n  }/)?.[0] ?? "",
  /offsetParent/,
  "fixed modal backdrops must not be treated as hidden",
);

for (const [name, source] of [
  ["command", command],
  ["quick-open", quickOpen],
  ["heading", heading],
  ["go-to-line", goToLine],
]) {
  assert.match(source, /useOverlayFocus/);
  assert.match(source, /aria-modal="true"/);
  assert.doesNotMatch(source, /\sautofocus(?:\s|>)/, `${name} must use deterministic WebView focus`);
}

assert.match(settings, /useOverlayFocus/);
assert.match(settings, /ref="backdrop"/);
assert.match(appDialog, /useOverlayFocus/);
assert.match(appDialog, /active: isOpen/);

const experimentalBlock =
  settings.match(/const experimentalGroups[\s\S]*?^];/m)?.[0] ?? "";
assert.doesNotMatch(experimentalBlock, /自动配对/, "implemented auto-pairing must not be listed as experimental");
assert.match(settings, /自动配对已作为默认编辑行为启用/);

console.log("Regression closure checks passed.");
