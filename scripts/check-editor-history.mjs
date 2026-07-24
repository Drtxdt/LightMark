import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/components/editor/SourceEditor.vue", import.meta.url), "utf8");
const wysiwyg = await readFile(new URL("../src/components/editor/WysiwygEditor.vue", import.meta.url), "utf8");

assert.match(source, /history\(\)/, "SourceEditor must install CodeMirror history");
assert.match(source, /\.\.\.historyKeymap/, "SourceEditor must expose the official undo/redo keymap");
assert.match(source, /isolateHistory\.of\("full"\)/, "source formatting must be isolated as one history event");
assert.match(source, /EditorState\.create\(/, "loading another document must create fresh editor state");
assert.match(wysiwyg, /closeHistory/, "WYSIWYG formatting must close its ProseMirror history event");

console.log("Editor history checks passed.");
