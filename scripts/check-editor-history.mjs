import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/components/editor/SourceEditor.vue", import.meta.url), "utf8");
const wysiwyg = await readFile(new URL("../src/components/editor/WysiwygEditor.vue", import.meta.url), "utf8");

assert.match(source, /history\(\)/, "SourceEditor must install CodeMirror history");
assert.match(source, /\.\.\.historyKeymap/, "SourceEditor must expose the official undo/redo keymap");
assert.match(source, /isolateHistory\.of\("full"\)/, "source formatting must be isolated as one history event");
assert.match(source, /EditorState\.create\(/, "loading another document must create fresh editor state");
assert.match(wysiwyg, /wysiwygFormatHistory\.undo\.push/, "WYSIWYG formatting must retain exact Markdown snapshots");
assert.match(wysiwyg, /before:\s*event\.detail\.source/, "WYSIWYG undo must preserve the unformatted source verbatim");
assert.match(wysiwyg, /setMeta\("addToHistory", false\)/, "semantic replacements must not duplicate exact snapshot history");

console.log("Editor history checks passed.");
