import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { redo, history, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-source-line-endings-"));
const sourcePath = path.join(root, "src", "editor", "sourceLineEndings.ts");
const modulePath = path.join(tempDir, "sourceLineEndings.mjs");
const sourceEditor = fs.readFileSync(path.join(root, "src", "components", "editor", "SourceEditor.vue"), "utf8");

try {
  fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText, "utf8");

  const sourceTools = await import(pathToFileURL(modulePath).href);
  const markdownFormatModule = await import(pathToFileURL(
    compileTypeScriptModuleGraph(path.join(root, "src", "utils", "markdownFormat.ts"), tempDir),
  ).href);
  const {
    parseSourceDocument,
    normalizeSourceLineBreaks,
    rawOffsetToSourceOffset,
    resetSourceLineEndings,
    serializeSourceDocument,
    sourceOffsetToRawOffset,
    sourceLineEndingsExtension,
    sourceLineEndingsField,
  } = sourceTools;
  const original = "\uFEFFa\r\nb\nc\rd";
  assert.match(sourceEditor, /serializeSourceDocument\(view\.state\.doc, view\.state\.field\(sourceLineEndingsField\)\)/);
  assert.match(sourceEditor, /resetSourceLineEndings\.of\(sourceDocument\.lineEndings\)/);
  assert.match(sourceEditor, /doc: sourceDocument\.text/);
  assert.match(sourceEditor, /extensions: extensions\(sourceDocument\)/);

  const create = (source) => {
    const parsed = parseSourceDocument(source);
    return EditorState.create({
      doc: parsed.text,
      extensions: [history(), sourceLineEndingsExtension(parsed.lineEndings)],
    });
  };
  const snapshot = (state) => serializeSourceDocument(state.doc, state.field(sourceLineEndingsField));
  const dispatch = (state, spec) => state.update(spec).state;
  const runHistoryCommand = (state, command) => {
    let next = null;
    assert.equal(command({ state, dispatch: (transaction) => { next = transaction.state; } }), true);
    assert.ok(next, "history command must dispatch a transaction");
    return next;
  };

  // This is the original red light: CodeMirror's raw state has already normalized all source EOLs.
  const rawState = EditorState.create({ doc: original });
  assert.equal(rawState.doc.toString(), "\uFEFFa\nb\nc\nd");
  assert.notEqual(rawState.doc.toString(), original);

  let state = create(original);
  assert.equal(snapshot(state), original, "a no-op source snapshot must be byte exact");

  const originalEndings = state.field(sourceLineEndingsField).endings;
  state = dispatch(state, { changes: { from: 3, to: 4, insert: "B" }, userEvent: "input.type" });
  assert.equal(snapshot(state), "\uFEFFa\r\nB\nc\rd", "a character edit must retain every untouched EOL");
  assert.equal(state.field(sourceLineEndingsField).endings, originalEndings, "non-EOL edits must reuse the metadata sequence");
  assert.throws(
    () => serializeSourceDocument(state.doc, { main: "\n", endings: [] }),
    /out of sync/,
    "snapshot must reject mismatched metadata instead of silently defaulting",
  );

  state = create(original);
  state = dispatch(state, { changes: { from: 2, to: 3, insert: "" }, userEvent: "delete.backward" });
  state = dispatch(state, { changes: { from: 5, to: 6, insert: "" }, userEvent: "delete.backward" });
  assert.equal(snapshot(state), "\uFEFFab\ncd", "deleting different EOLs must retain the untouched LF");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), "\uFEFFab\nc\rd", "first undo must restore the CR EOL");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), original, "second undo must restore the CRLF EOL");
  state = runHistoryCommand(state, redo);
  state = runHistoryCommand(state, redo);
  assert.equal(snapshot(state), "\uFEFFab\ncd", "redo must restore both deletions exactly");

  state = create(original);
  state = dispatch(state, {
    changes: [
      { from: 2, to: 3, insert: "" },
      { from: 6, to: 7, insert: "" },
    ],
    userEvent: "delete.backward",
  });
  assert.equal(snapshot(state), "\uFEFFab\ncd", "a multi-range EOL deletion must update metadata once");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), original, "undo must restore every EOL in a multi-range change");
  state = runHistoryCommand(state, redo);
  assert.equal(snapshot(state), "\uFEFFab\ncd", "redo must restore every multi-range deletion");

  state = create(original);
  state = dispatch(state, { changes: { from: 2, to: 3, insert: "" }, userEvent: "delete.backward" });
  state = dispatch(state, { changes: { from: 2, to: 2, insert: "\n" }, userEvent: "input.type" });
  assert.equal(snapshot(state), original, "adjacent EOL replacement actions must merge into one document result");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), original, "one undo must revert an adjacent EOL action group");
  state = runHistoryCommand(state, redo);
  assert.equal(snapshot(state), original, "one redo must replay an adjacent EOL action group");

  state = create(original);
  state = dispatch(state, { changes: { from: 4, to: 5, insert: "" }, userEvent: "delete.backward" });
  state = dispatch(state, { changes: { from: 4, to: 4, insert: "X" }, userEvent: "input.type" });
  assert.equal(snapshot(state), "\uFEFFa\r\nbXc\rd", "an adjacent edit must retain a non-main EOL before undo");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), original, "a grouped undo must restore the non-main EOL type");
  state = runHistoryCommand(state, redo);
  assert.equal(snapshot(state), "\uFEFFa\r\nbXc\rd", "a grouped redo must restore the non-main EOL deletion");

  state = create(original);
  state = dispatch(state, {
    changes: [
      { from: 3, to: 3, insert: "X" },
      { from: 7, to: 7, insert: "Y" },
    ],
    userEvent: "input.type",
  });
  assert.equal(snapshot(state), "\uFEFFa\r\nXb\nc\rYd", "multiple character changes must reuse metadata");

  state = create(original);
  state = dispatch(state, { changes: { from: 3, to: 3, insert: "\n" }, userEvent: "input.type" });
  state = dispatch(state, { changes: { from: 4, to: 4, insert: "z" }, userEvent: "input.type" });
  assert.equal(snapshot(state), "\uFEFFa\r\n\r\nzb\nc\rd");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), original, "adjacent typing must undo as one history group");
  state = runHistoryCommand(state, redo);
  assert.equal(snapshot(state), "\uFEFFa\r\n\r\nzb\nc\rd", "redo must restore a new main-EOL newline");

  state = create(original);
  state = dispatch(state, { changes: { from: 2, to: 3, insert: "" }, userEvent: "delete.backward" });
  state = dispatch(state, {
    changes: { from: 0, to: 0, insert: "P" },
    annotations: Transaction.addToHistory.of(false),
  });
  assert.equal(snapshot(state), "P\uFEFFab\nc\rd");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), "P\uFEFFa\r\nb\nc\rd", "undo must preserve an addToHistory:false prefix insertion");

  state = create(original);
  state = dispatch(state, { changes: { from: 2, to: 3, insert: "" }, userEvent: "delete.backward" });
  state = dispatch(state, {
    changes: { from: 2, to: 2, insert: "\n" },
    annotations: Transaction.addToHistory.of(false),
  });
  assert.equal(snapshot(state), "\uFEFFa\r\nb\nc\rd");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), "\uFEFFa\r\n\r\nb\nc\rd", "undo must keep a non-history EOL inserted at the same boundary");

  state = create(original);
  state = dispatch(state, { changes: { from: 2, to: 3, insert: "" }, userEvent: "delete.backward" });
  state = dispatch(state, {
    changes: { from: 2, to: 3, insert: "" },
    annotations: Transaction.addToHistory.of(false),
  });
  assert.equal(snapshot(state), "\uFEFFa\nc\rd");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), "\uFEFFa\r\n\nc\rd", "undo must keep a non-history deletion adjacent to the restored EOL");

  state = create(original);
  state = dispatch(state, { changes: { from: 2, to: 3, insert: "" }, userEvent: "delete.backward" });
  state = dispatch(state, {
    changes: { from: 3, to: 4, insert: "" },
    annotations: Transaction.addToHistory.of(false),
  });
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), "\uFEFFa\r\nbc\rd", "undo must not restore a non-history deleted neighboring EOL");

  state = create(original);
  const replacement = parseSourceDocument("\uFEFFx\n\ny\r\nz\r\n");
  state = dispatch(state, {
    changes: { from: 0, to: state.doc.length, insert: replacement.text },
    effects: resetSourceLineEndings.of(replacement.lineEndings),
    userEvent: "input.replace",
  });
  assert.equal(snapshot(state), "\uFEFFx\n\ny\r\nz\r\n", "full replacement must install incoming metadata");
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), original, "undo of a full replacement must restore old metadata");
  assert.equal(state.field(sourceLineEndingsField).main, "\r\n", "undo must restore the old main EOL policy");
  state = dispatch(state, { changes: { from: state.doc.length, to: state.doc.length, insert: "\nX" }, userEvent: "input.type" });
  assert.equal(snapshot(state), `${original}\r\nX`, "new input after undo must use the restored main EOL");

  state = create(original);
  state = dispatch(state, {
    changes: { from: 0, to: state.doc.length, insert: replacement.text },
    effects: resetSourceLineEndings.of(replacement.lineEndings),
    userEvent: "input.replace",
  });
  state = runHistoryCommand(state, undo);
  state = runHistoryCommand(state, redo);
  assert.equal(snapshot(state), "\uFEFFx\n\ny\r\nz\r\n", "redo of a full replacement must restore incoming metadata");
  assert.equal(state.field(sourceLineEndingsField).main, "\n", "redo must restore the replacement main EOL policy");

  state = create("plain");
  const noOldBreakReplacement = parseSourceDocument("plain\r\nnext");
  state = dispatch(state, {
    changes: { from: 0, to: state.doc.length, insert: noOldBreakReplacement.text },
    effects: resetSourceLineEndings.of(noOldBreakReplacement.lineEndings),
    userEvent: "input.replace",
  });
  state = runHistoryCommand(state, undo);
  assert.equal(snapshot(state), "plain", "undo must restore a replacement with no old EOLs");
  assert.equal(state.field(sourceLineEndingsField).main, "\n", "main EOL must be restored even when old metadata has no entries");
  state = dispatch(state, { changes: { from: state.doc.length, to: state.doc.length, insert: "\nnext" }, userEvent: "input.type" });
  assert.equal(snapshot(state), "plain\nnext", "new input after an empty replacement undo must use old main EOL");

  const pasted = "one\r\ntwo\rthree\nfour";
  assert.equal(normalizeSourceLineBreaks(pasted), "one\ntwo\nthree\nfour");
  assert.equal(sourceOffsetToRawOffset(original, 3), 4, "normalized source offsets must account for CRLF bytes");
  assert.equal(rawOffsetToSourceOffset(original, 4), 3, "raw source offsets must map back to normalized positions");

  const formatSource = "\uFEFF# Title   \r\nbody\r\n";
  const formatResult = markdownFormatModule.formatMarkdown(formatSource);
  const formatView = parseSourceDocument(formatSource).text;
  const formatViewOffset = formatView.indexOf("body") + 2;
  const formatRawOffset = sourceOffsetToRawOffset(formatSource, formatViewOffset);
  const mappedRawOffset = markdownFormatModule.mapMarkdownOffset(formatSource, formatResult, formatRawOffset);
  const mappedViewOffset = rawOffsetToSourceOffset(formatResult.text, mappedRawOffset);
  assert.equal(mappedViewOffset, parseSourceDocument(formatResult.text).text.indexOf("body") + 2, "formatter selection mapping must cross CRLF boundaries in source mode");
  state = create(original);
  state = dispatch(state, {
    changes: { from: state.doc.length, to: state.doc.length, insert: normalizeSourceLineBreaks(pasted) },
    userEvent: "input.paste",
  });
  assert.equal(snapshot(state), "\uFEFFa\r\nb\nc\rdone\r\ntwo\r\nthree\r\nfour", "mixed paste uses the document main EOL for new lines");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Source line-ending fidelity checks passed.");
