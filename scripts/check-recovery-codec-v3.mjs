import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSchema, Node as TiptapNode } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AllSelection } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-recovery-v3-"));

try {
  const codecPath = compileTypeScriptModuleGraph(path.resolve("src/editor/recoveryCodec.ts"), tempDir);
  const codec = await import(pathToFileURL(codecPath).href);
  const atom = (name, attrs) => TiptapNode.create({
    name,
    group: "block",
    atom: true,
    selectable: true,
    addAttributes: () => attrs,
  });
  const schema = getSchema([
    StarterKit.configure({
      blockquote: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      link: false,
      strike: false,
    }),
    atom("frontMatter", { yaml: { default: "" }, editing: { default: false } }),
    atom("htmlBlock", { html: { default: "" }, editing: { default: false } }),
    atom("footnotes", { markdown: { default: "" }, html: { default: "" }, editing: { default: false } }),
    atom("tableOfContents", { editing: { default: false } }),
    atom("mermaidDiagram", { code: { default: "" }, editing: { default: false } }),
    atom("blockMath", {
      tex: { default: "" },
      delimiter: { default: "display-dollar" },
      raw: { default: "" },
      originalTex: { default: "" },
      displayMode: { default: true },
      editing: { default: false },
    }),
  ]);
  const document = schema.nodes.doc.create(null, [
    schema.nodes.frontMatter.create({ yaml: "title: old", editing: false }),
    schema.nodes.htmlBlock.create({ html: "<script>alert(1)</script>", editing: false }),
    schema.nodes.footnotes.create({ markdown: "[^a]: old", html: "<p>old</p>", editing: false }),
    schema.nodes.tableOfContents.create({ editing: true }),
    schema.nodes.mermaidDiagram.create({ code: "graph TD;A-->B", editing: false }),
    schema.nodes.blockMath.create({ tex: "x+1", delimiter: "display-dollar", raw: "$$x+1$$", originalTex: "x+1", displayMode: true, editing: false }),
    schema.nodes.paragraph.create(null, schema.text("原文 😀")),
  ]);
  const sourceText = "\uFEFF原始\r\nsource\n";
  const sourceBytes = new TextEncoder().encode(sourceText);
  const selection = new AllSelection(document);
  const mathContent = {
    tex: "x+1",
    delimiter: "display-dollar",
    raw: "$$x+1$$",
    originalTex: "x+1",
    displayMode: true,
  };
  const localState = {
    schema: "lightmark.local-state",
    revision: 7,
    buffers: [
      {
        id: "fm-1",
        kind: "frontmatter",
        status: "editing",
        sourceRevision: 7,
        pmPath: [0],
        positionHint: 0,
        rawSpan: { from: 0, to: 4 },
        payload: {
          accepted: { yaml: "title: old", editing: false },
          draft: { yaml: "title: draft", editing: true },
          valueRevision: 2,
        },
        ui: { anchor: 5, head: 5, direction: "none", focused: true, composing: true },
      },
      {
        id: "html-1",
        kind: "htmlBlock",
        status: "editing",
        sourceRevision: 7,
        pmPath: [1],
        positionHint: 1,
        rawSpan: { from: 4, to: 8 },
        payload: {
          accepted: { html: "<script>alert(1)</script>", editing: false, decoded: true, sanitized: true },
          draft: { html: "<b>draft</b>", decoded: false, sanitized: false },
          committing: false,
          valueRevision: 3,
        },
        ui: { anchor: 2, head: 5, direction: "forward", focused: true, composing: false },
      },
      {
        id: "footnote-1",
        kind: "footnote",
        status: "editing",
        sourceRevision: 7,
        pmPath: [2],
        positionHint: 2,
        rawSpan: { from: 8, to: 10 },
        payload: {
          accepted: { markdown: "[^a]: old", html: "<p>old</p>", editing: false },
          draft: { markdown: "[^a]: draft\r\n", normalized: false, editing: true },
          fallbackHtml: "<script>keep as data</script>",
          normalized: false,
          committing: true,
          frame: "scheduled",
          valueRevision: 4,
        },
        ui: { anchor: 4, head: 4, direction: "none", focused: true, composing: false },
      },
      {
        id: "toc-1",
        kind: "toc",
        status: "editing",
        sourceRevision: 7,
        pmPath: [3],
        positionHint: 3,
        rawSpan: { from: 10, to: 10 },
        payload: { candidate: "[TOC] draft", accepted: "[TOC]", editing: true, valueRevision: 1 },
        ui: { anchor: 6, head: 6, direction: "none", focused: true, composing: false },
      },
      {
        id: "mermaid-1",
        kind: "mermaid",
        status: "editing",
        sourceRevision: 7,
        pmPath: [4],
        positionHint: 4,
        rawSpan: { from: 10, to: 12 },
        payload: {
          accepted: { code: "graph TD;A-->B", editing: false },
          draft: { code: "graph TD;A-->C", editing: true },
          preview: { generation: 9, status: "pending" },
          valueRevision: 5,
        },
        ui: { anchor: 4, head: 4, direction: "none", focused: false, composing: false },
      },
      {
        id: "math-1",
        kind: "math",
        status: "editing",
        sourceRevision: 7,
        positionHint: 5,
        pmPath: [5],
        payload: { accepted: mathContent, local: { ...mathContent, tex: "x+2", raw: "$$x+2$$" }, valueRevision: 8, ui: {
          anchor: 2,
          head: 4,
          direction: "backward",
          focused: true,
          composing: true,
        } },
      },
    ],
    exposedMarkdown: {
      active: true,
      range: {
        kind: "inline",
        from: 7,
        to: 11,
        blockFrom: 6,
        open: "**",
        close: "**",
        markName: "strong",
      },
      docRevision: 7,
      selection: { anchor: 8, head: 10 },
    },
    composition: { active: true, source: "node-view", revision: 7 },
    history: {
      sourceCheckpointId: "checkpoint-7",
      format: {
        undo: [{ before: "old", after: "new", beforeAnchor: 1, beforeHead: 1, afterAnchor: 2, afterHead: 2 }],
        redo: [],
      },
      pm: { status: "unavailable", reason: "StarterKit history adapter is not versioned" },
      source: { status: "unavailable", reason: "CodeMirror history adapter is not versioned" },
    },
  };

  const capture = { sourceBytes, doc: document, selection, scroll: { scrollTop: 4.5, scrollRatio: 0.25 }, pendingMath: { version: 2, entries: [] }, origin: { path: "C:\\notes\\恢复.md", kind: "normal" } };
  const encoded = codec.encodeRecoveryBundleV3({ ...capture, localState });
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.source.bytesBase64.length > 0, true);
  assert.equal(parsed.localState.buffers[1].payload.accepted.html, "<script>alert(1)</script>");
  const decoded = codec.decodeRecoveryBundleV3(encoded, schema);
  assert.deepEqual(decoded.localState, localState, "v3 local state round-trip");
  assert.equal(decoded.sourceText, sourceText, "v3 source BOM and EOL bytes");
  assert.deepEqual(decoded.doc.toJSON(), document.toJSON(), "v3 PM document");
  assert.throws(
    () => codec.assertRecoverySourceMappingProven({ sourceText: "abc", modelText: "abcd", mappingProven: false }),
    /mapping is unresolved/,
    "a recovered PM model cannot overwrite source bytes without a proven mapping",
  );
  assert.doesNotThrow(
    () => codec.assertRecoverySourceMappingProven({ sourceText: "abc", modelText: "abcd", mappingProven: true }),
    "a later piece/provenance adapter may explicitly authorize a source mapping",
  );
  const retainedPending = {
    version: 9,
    entries: [{
      id: "pending-orphan",
      binding: { status: "orphaned", position: null, kind: "block", reason: "node-view-destroyed" },
      accepted: mathContent,
      local: { ...mathContent, tex: "x+2" },
      state: "conflict",
    }],
  };
  const mergedPending = codec.mergeRecoveryPendingMath({ version: 1, entries: [] }, retainedPending);
  assert.deepEqual(mergedPending, retainedPending, "unbound pending math remains in a subsequent capture");
  assert.deepEqual(codec.subtractCapturedPendingMath(retainedPending, { version: 1, entries: [] }), retainedPending, "unbound pending math is not dropped when no live entry replaces it");
  assert.throws(
    () => codec.mergeRecoveryPendingMath({ version: 1, entries: [{ ...retainedPending.entries[0], local: { ...mathContent, tex: "different" } }] }, retainedPending),
    /conflicts for stable id/,
    "same stable id with divergent pending math is a typed capture conflict",
  );
  const liveLinkedPending = {
    version: 10,
    entries: [{
      id: "pending-remounted-live",
      binding: { status: "linked", position: 5, kind: "block" },
      accepted: mathContent,
      local: { ...mathContent, tex: "x+2" },
      state: "editing",
    }],
  };
  const retainedRemountedPending = {
    version: 9,
    entries: [{
      id: "pending-remounted-old",
      binding: { status: "linked", position: 5, kind: "block" },
      accepted: mathContent,
      local: { ...mathContent, tex: "x+2" },
      state: "blurPending",
    }],
  };
  assert.deepEqual(
    codec.mergeRecoveryPendingMath(liveLinkedPending, retainedRemountedPending),
    liveLinkedPending,
    "a remounted linked formula with the same payload does not duplicate its PM position",
  );
  assert.throws(
    () => codec.mergeRecoveryPendingMath(liveLinkedPending, {
      ...retainedRemountedPending,
      entries: [{ ...retainedRemountedPending.entries[0], local: { ...mathContent, tex: "x+3" } }],
    }),
    /conflicts for linked binding/,
    "a remounted linked formula with divergent payload remains a typed conflict",
  );
  const orphanLocalState = JSON.parse(JSON.stringify(localState));
  orphanLocalState.buffers[0].status = "orphaned";
  orphanLocalState.buffers[0].pmPath = [999];
  orphanLocalState.buffers[0].positionHint = 999;
  orphanLocalState.buffers[0].error = { code: "stale-position", message: "NodeView position no longer resolves." };
  const orphanBundle = codec.encodeRecoveryBundleV3({ ...capture, localState: orphanLocalState });
  const orphanDecoded = codec.decodeRecoveryBundleV3(orphanBundle, schema);
  assert.equal(orphanDecoded.localState.buffers[0].positionHint, 999, "orphan stale PM hint is retained");
  assert.equal(orphanDecoded.localState.buffers[0].status, "orphaned", "orphan is never auto-applied");

  const autoV3 = codec.encodeRecoveryBundle({ ...capture, localState });
  assert.equal(JSON.parse(autoV3).schemaVersion, 3, "localState selects v3 for the common encoder");
  assert.deepEqual(codec.decodeRecoveryBundle(autoV3, schema).localState, localState, "common decoder reads v3");

  const pendingMath = {
    version: 3,
    entries: [{
      id: "math-1",
      binding: { status: "linked", position: 5, kind: "block" },
      accepted: mathContent,
      local: { ...mathContent, tex: "x+2", raw: "$$x+2$$" },
      state: "composing",
    }],
  };
  const duplicatedMathBundle = codec.encodeRecoveryBundleV3({ ...capture, pendingMath, localState });
  assert.deepEqual(codec.decodeRecoveryBundleV3(duplicatedMathBundle, schema).localState, localState, "pending/local math duplicate agrees");

  const v2 = codec.encodeRecoveryBundle(capture);
  assert.equal(JSON.parse(v2).schemaVersion, 2, "v2 capture remains v2");
  assert.equal(codec.decodeRecoveryBundle(v2, schema).localState, undefined, "v2 has no implicit local state");
  const assertError = (fn, code, label, pathValue) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof codec.RecoveryValidationError, `${label}: typed error`);
      assert.equal(error.code, code, `${label}: error code`);
      if (pathValue) assert.equal(error.path, pathValue, `${label}: error path`);
      return;
    }
    assert.fail(`${label}: expected ${code}`);
  };
  const decodeObject = (mutate) => {
    const value = JSON.parse(encoded);
    mutate(value);
    return codec.decodeRecoveryBundle(value, schema);
  };
  assertError(() => decodeObject((value) => { value.extra = true; }), "invalid-json", "unknown v3 top-level field", "$.extra");
  assertError(() => decodeObject((value) => { value.localState.buffers[0].positionHint = 1; }), "invalid-local-state", "accepted buffer position does not bind to PM node");
  assertError(() => decodeObject((value) => { value.localState.buffers[0].payload.accepted.yaml = "changed"; }), "invalid-local-state", "accepted buffer attrs do not match PM node");
  assertError(() => decodeObject((value) => { value.localState.exposedMarkdown.range.blockFrom = 0; }), "invalid-local-state", "exposed inline range does not bind to textblock");
  assertError(() => decodeObject((value) => { value.localState.exposedMarkdown.selection.anchor = 999; }), "invalid-local-state", "exposed selection outside PM document");
  assertError(() => decodeObject((value) => { value.localState.buffers[1].payload.draft.value = "also present"; }), "invalid-local-state", "ambiguous HTML draft aliases");
  assertError(() => decodeObject((value) => { value.localState.buffers[1].payload.draft.value = 123; }), "invalid-local-state", "non-text HTML alias is rejected");
  assertError(() => decodeObject((value) => { value.localState.buffers[1].payload.draft = { value: "draft", html: null }; }), "invalid-local-state", "null HTML alias is rejected");
  assertError(() => decodeObject((value) => { value.localState.buffers[0].payload.unknown = true; }), "invalid-local-state", "unknown frontmatter payload field");
  assertError(() => decodeObject((value) => { value.localState.buffers[1].rawSpan.to = sourceText.length + 1; }), "invalid-local-state", "raw span outside source");
  assertError(() => decodeObject((value) => { value.localState.buffers[0].ui.anchor = 999; }), "invalid-local-state", "local selection outside draft");
  assertError(() => decodeObject((value) => { value.localState.buffers[0].status = "orphaned"; delete value.localState.buffers[0].error; }), "invalid-local-state", "orphan without reason");
  assertError(() => decodeObject((value) => { value.localState.history.pm = { status: "unavailable" }; }), "invalid-local-state", "unavailable history without reason");
  assertError(() => decodeObject((value) => { value.localState.history.source = { status: "captured", checkpointId: "source-7" }; }), "invalid-local-state", "captured history without adapter payload");
  assertError(() => decodeObject((value) => { value.localState.composition.revision = 99; }), "invalid-local-state", "future composition revision");
  assertError(() => decodeObject((value) => { value.localState.history.format.undo[0].beforeAnchor = 999; }), "invalid-local-state", "history selection outside source");
  assertError(() => {
    const value = JSON.parse(duplicatedMathBundle);
    value.localState.buffers.find((buffer) => buffer.kind === "math").payload.local.tex = "different";
    codec.decodeRecoveryBundle(value, schema);
  }, "invalid-local-state", "duplicate math payload disagreement");
  assertError(() => {
    const value = JSON.parse(encoded);
    value.schemaVersion = 4;
    codec.decodeRecoveryBundle(value, schema);
  }, "unsupported-version", "unknown v3 schema version", "$.schemaVersion");
  assertError(() => codec.decodeRecoveryBundleV3(v2, schema), "unsupported-version", "v2 rejected by v3-only reader");

  console.log("check-recovery-codec-v3: passed (v3 local buffers/history + v2 compatibility)");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
