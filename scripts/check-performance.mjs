import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [sourceEditor, wysiwygEditor, wysiwygFocus, appStore, workspaceIndexClient, editorShell, mermaidNode] = await Promise.all([
  read("src/components/editor/SourceEditor.vue"),
  read("src/components/editor/WysiwygEditor.vue"),
  read("src/editor/wysiwygFocus.ts"),
  read("src/stores/appStore.ts"),
  read("src/stores/workspaceIndexClient.ts"),
  read("src/components/editor/EditorShell.vue"),
  read("src/extensions/MermaidNode.ts"),
]);

const requiredMatch = (source, expression, description) => {
  const match = source.match(expression)?.[0];
  assert.ok(match, description);
  return match;
};

const sourceUpdate = requiredMatch(
  sourceEditor,
  /EditorView\.updateListener\.of\(\(update\) => \{[\s\S]*?\n    \}\),/,
  "SourceEditor update listener was not found; performance assertions would otherwise be vacuous",
);
const wysiwygUpdate = requiredMatch(
  wysiwygEditor,
  /onUpdate\(\{ editor, transaction \}\)[\s\S]*?\n  },/,
  "WysiwygEditor update handler was not found; performance assertions would otherwise be vacuous",
);
assert.doesNotMatch(sourceUpdate, /doc\.toString\(\)|setPaneContent/, "CodeMirror input copied the full document");
const sourceTab = requiredMatch(
  sourceEditor,
  /function handleSourceTab[\s\S]*?\n}/,
  "SourceEditor Tab handler was not found; performance assertions would otherwise be vacuous",
);
assert.doesNotMatch(sourceTab, /doc\.toString\(\)|isInsideFencedCode/, "CodeMirror Tab handler copied or rescanned the full document");
assert.match(sourceTab, /sourceContextAtLine/);
const sourcePositionCapture = requiredMatch(
  sourceEditor,
  /function captureSourcePosition[\s\S]*?\n}/,
  "Source position capture was not found; performance assertions would otherwise be vacuous",
);
assert.doesNotMatch(sourcePositionCapture, /doc\.toString\(\)|buildEditorPositionSnapshot/, "CodeMirror position capture copied or rescanned the full document");
assert.match(sourcePositionCapture, /state\.doc\.lineAt/);
assert.doesNotMatch(wysiwygUpdate, /getHTML\(\)|editorHtmlToMarkdown|setPaneContent/, "Tiptap input serialized the full document");
assert.match(sourceEditor, /new Worker\(new URL\("\.\.\/\.\.\/workers\/mathDiagnostics\.worker\.ts"/);
assert.match(sourceEditor, /sourceOutlineField/);
assert.match(wysiwygEditor, /markDocumentChanged/);
assert.match(wysiwygEditor, /getWysiwygDerivedState\(editor\.state\)/);
assert.doesNotMatch(wysiwygUpdate, /collectWysiwygFindMatches/, "Tiptap input performed a full-document find");
assert.doesNotMatch(wysiwygEditor, /scheduleWysiwygFindRefresh|function collectWysiwygFindMatches/, "Tiptap retained a deferred full-document find path");
assert.match(wysiwygEditor, /createWysiwygFindPlugin/);
assert.doesNotMatch(wysiwygFocus, /state\.doc\.forEach|state\.doc\.descendants/, "WYSIWYG focus mode traversed the full document");
assert.doesNotMatch(wysiwygEditor, /createLowlight\(all\)/, "all Lowlight grammars entered the WYSIWYG chunk");
assert.match(wysiwygEditor, /ensureLowlightLanguage/);
assert.match(wysiwygEditor, /installLowlightPlainTextFallback/);
assert.match(wysiwygEditor, /incrementalLowlightPlugin/);
const positionCapture = requiredMatch(
  wysiwygEditor,
  /function captureWysiwygPosition[\s\S]*?\n}/,
  "WYSIWYG position capture was not found; performance assertions would otherwise be vacuous",
);
assert.doesNotMatch(positionCapture, /editorHtmlToMarkdown|docPosToMarkdownOffset|getHTML/, "WYSIWYG position capture serialized Markdown on input");
assert.match(positionCapture, /editorAnchor: anchor/);
const selectionCapture = requiredMatch(
  wysiwygEditor,
  /function captureWysiwygSelectionAnchor[\s\S]*?\n}/,
  "WYSIWYG selection capture was not found; performance assertions would otherwise be vacuous",
);
assert.doesNotMatch(selectionCapture, /editorHtmlToMarkdown|docPosToMarkdownOffset|getHTML/, "WYSIWYG selection anchor serialized Markdown on input");
assert.match(selectionCapture, /getWysiwygDerivedState/);
assert.match(appStore, /documentRuntimeMetadata/);
assert.match(appStore, /waitForDocumentSession/);
assert.match(workspaceIndexClient, /workspace_index_update_open_document/);
assert.match(appStore, /if \(!tab\?\.path \|\| !appStore\.currentWorkspace \|\| !appStore\.workspaceIndexReady\) return/);
assert.match(editorShell, /defineAsyncComponent/);
assert.match(mermaidNode, /import\("mermaid"\)/);

const prose = Array.from({ length: 32 }, (_, index) => `混合 Markdown 性能正文 ${index}，包含中文、ASCII、标点与 [[Wiki Link]]。`).join(" ");
const unit = [
  "# 性能夹具", "", `${prose} **bold** $x^2$`, "", "- item", "- [ ] task", "",
  "| a | b |", "| - | - |", "| 1 | 2 |", "", "```ts", "const x = 1", "```", "",
  "$$", "E = mc^2", "$$", "", "",
].join("\n");
let fixture = "";
for (let group = 0; Buffer.byteLength(fixture, "utf8") < 1024 * 1024; group += 1) {
  fixture += `${unit}${group % 100 === 0 ? "```mermaid\ngraph TD; A-->B\n```\n\n" : ""}`;
}
assert.ok(Buffer.byteLength(fixture, "utf8") >= 1024 * 1024);
assert.ok(fixture.includes("[[Wiki Link]]") && fixture.includes("```mermaid"));

console.log(`static performance architecture checks passed; no UI timing was performed (${Buffer.byteLength(fixture, "utf8")} byte deterministic fixture)`);
