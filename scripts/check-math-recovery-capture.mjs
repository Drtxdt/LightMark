import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";
import { installMathDomHarness, TestElement } from "./math-dom-harness.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-math-recovery-"));
const domHarness = installMathDomHarness();
const previousGlobals = {
  HTMLElement: globalThis.HTMLElement,
  HTMLInputElement: globalThis.HTMLInputElement,
  HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
  Element: globalThis.Element,
  SVGElement: globalThis.SVGElement,
  CustomEvent: globalThis.CustomEvent,
};

try {
  TestElement.prototype.closest ??= function closest() { return null; };
  TestElement.prototype.setSelectionRange ??= function setSelectionRange() {};
  TestElement.prototype.select ??= function select() {};
  globalThis.HTMLElement = TestElement;
  globalThis.HTMLInputElement = TestElement;
  globalThis.HTMLTextAreaElement = TestElement;
  globalThis.Element = TestElement;
  globalThis.SVGElement = TestElement;
  if (!globalThis.CustomEvent) {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    };
  }
  const testDocument = globalThis.document;
  testDocument.createElementNS ??= (_namespace, tagName) => testDocument.createElement(tagName);
  testDocument.createComment ??= (text) => ({ nodeType: 8, textContent: text, parentNode: null });
  testDocument.body ??= testDocument.createElement("body");
  testDocument.body.ownerDocument = testDocument;

  const compiledMathNodes = compileTypeScriptModuleGraph(path.resolve("src/extensions/MathNodes.ts"), tempDir);
  const compiledRecoveryCodec = compileTypeScriptModuleGraph(path.resolve("src/editor/recoveryCodec.ts"), tempDir);
  const {
    BlockMath,
    InlineMath,
    capturePendingMathRecovery,
    getPendingMathEditVersion,
    getPendingMathInputVersion,
  } = await import(pathToFileURL(compiledMathNodes).href);
  const recoveryCodec = await import(pathToFileURL(compiledRecoveryCodec).href);

  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { content: "inline*", group: "block" },
      blockMath: {
        group: "block",
        atom: true,
        defining: true,
        attrs: {
          tex: { default: "" },
          delimiter: { default: "display-dollar" },
          raw: { default: "" },
          originalTex: { default: "" },
          displayMode: { default: true },
          editing: { default: false },
        },
      },
      text: { group: "inline" },
      inlineMath: {
        group: "inline",
        inline: true,
        atom: true,
        selectable: true,
        attrs: {
          tex: { default: "" },
          delimiter: { default: "inline-dollar" },
          raw: { default: "" },
          originalTex: { default: "" },
          displayMode: { default: false },
          editing: { default: false },
        },
      },
    },
    marks: {},
  });

  const inlineAttrs = (tex, editing = true) => ({
    tex,
    delimiter: "inline-dollar",
    raw: `$${tex}$`,
    originalTex: tex,
    displayMode: false,
    editing,
  });
  const blockAttrs = (tex, editing = true) => ({
    tex,
    delimiter: "display-dollar",
    raw: `$$\n${tex}\n$$`,
    originalTex: tex,
    displayMode: true,
    editing,
  });
  const inlineNode = (tex, editing = true) => schema.nodes.inlineMath.create(inlineAttrs(tex, editing));
  const blockNode = (tex, editing = true) => schema.nodes.blockMath.create(blockAttrs(tex, editing));

  function makeEditor(doc) {
    let state = EditorState.create({ schema, doc });
    let stateUnavailable = false;
    let dispatchCount = 0;
    let focusCount = 0;
    const view = {
      get state() {
        if (stateUnavailable) throw new Error("editor view state unavailable");
        return state;
      },
      dispatch(transaction) {
        dispatchCount += 1;
        state = state.apply(transaction);
      },
      focus() { focusCount += 1; },
    };
    return {
      view,
      setDoc(nextDoc) { state = EditorState.create({ schema, doc: nextDoc }); },
      setState(nextState) { state = nextState; },
      setStateUnavailable() { stateUnavailable = true; },
      get dispatchCount() { return dispatchCount; },
      get focusCount() { return focusCount; },
    };
  }

  function captureStable(editor, label, expectedEntries = 1, options = {}) {
    const stateAvailable = options.stateAvailable !== false;
    const beforeDoc = stateAvailable ? editor.view.state.doc.toJSON() : null;
    const beforeDomText = options.dom ? options.dom.textContent : undefined;
    const beforeVersion = getPendingMathEditVersion(editor);
    const beforeInputVersion = getPendingMathInputVersion(editor);
    const beforeDispatches = editor.dispatchCount;
    const beforeFocuses = editor.focusCount;
    const captured = capturePendingMathRecovery(editor);
    assert.equal(captured.entries.length, expectedEntries, `${label}: entry count`);
    if (stateAvailable) assert.deepEqual(editor.view.state.doc.toJSON(), beforeDoc, `${label}: doc unchanged`);
    assert.equal(getPendingMathEditVersion(editor), beforeVersion, `${label}: registry version unchanged`);
    assert.equal(getPendingMathInputVersion(editor), beforeInputVersion, `${label}: input version unchanged`);
    assert.equal(editor.dispatchCount, beforeDispatches, `${label}: no dispatch`);
    assert.equal(editor.focusCount, beforeFocuses, `${label}: no focus/blur side effect`);
    if (options.dom) assert.equal(options.dom.textContent, beforeDomText, `${label}: DOM local value unchanged`);
    return captured;
  }

  function assertCodecAcceptsCapture(editor, captured, label) {
    const doc = editor.view.state.doc;
    const bundle = recoveryCodec.encodeRecoveryBundle({
      sourceBytes: new TextEncoder().encode("recovery-source"),
      doc,
      selection: new AllSelection(doc),
      scroll: { scrollTop: 0, scrollRatio: 0 },
      pendingMath: captured,
      origin: { path: null, kind: "untitled" },
    });
    assert.equal(typeof bundle, "string", `${label}: codec accepts capture`);
    const decoded = recoveryCodec.decodeRecoveryBundle(bundle, schema);
    assert.deepEqual(decoded.pendingMath, captured, `${label}: codec round-trip preserves capture`);
  }

  const inlineFactory = InlineMath.config.addNodeView();
  const blockFactory = BlockMath.config.addNodeView();

  {
    const node = inlineNode("x", true);
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [node])]);
    const editor = makeEditor(doc);
    let position = 1;
    const nodeView = inlineFactory({ node, editor, getPos: () => position });
    const source = nodeView.dom.querySelector(".math-inline-source-editor");
    assert.ok(source, "editing inline NodeView exposes source editor");

    const initial = captureStable(editor, "editing without local change", 1, { dom: source });
    assert.equal(initial.entries[0].binding.status, "linked");
    assert.equal(initial.entries[0].binding.position, 1);
    assert.equal(initial.entries[0].state, "editing");
    assert.deepEqual(initial.entries[0].accepted, initial.entries[0].local, "editing state keeps equal accepted/local values");

    source.textContent = "x+1";
    source.dispatchEvent({ type: "input" });
    const local = captureStable(editor, "local inline edit", 1, { dom: source });
    assert.equal(local.entries[0].binding.status, "linked");
    assert.equal(local.entries[0].accepted.tex, "x");
    assert.equal(local.entries[0].local.tex, "x+1");
    assert.equal(local.entries[0].state, "editing");
    assertCodecAcceptsCapture(editor, local, "local inline edit");

    const incoming = inlineNode("incoming", false);
    editor.setDoc(schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [incoming])]));
    assert.equal(nodeView.update(incoming), true, "NodeView accepts incoming PM update while preserving local conflict");
    const conflict = captureStable(editor, "incoming conflict", 1, { dom: source });
    assert.equal(conflict.entries[0].binding.status, "conflicted");
    assert.equal(conflict.entries[0].binding.position, 1);
    assert.equal(conflict.entries[0].binding.reason, "node-view-edit-conflict");
    assert.equal(conflict.entries[0].accepted.tex, "x");
    assert.equal(conflict.entries[0].local.tex, "x+1");
    assert.equal(conflict.entries[0].state, "conflict");
    assertCodecAcceptsCapture(editor, conflict, "incoming conflict");
    nodeView.destroy();
  }

  {
    const node = inlineNode("orphan", true);
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [node])]);
    const editor = makeEditor(doc);
    let position = 999;
    const nodeView = inlineFactory({ node, editor, getPos: () => position });
    const source = nodeView.dom.querySelector(".math-inline-source-editor");
    assert.ok(source, "orphan fixture exposes source editor");
    source.textContent = "orphan-local";
    source.dispatchEvent({ type: "input" });
    const stale = captureStable(editor, "out-of-range getPos", 1, { dom: source });
    assert.equal(stale.entries[0].binding.status, "orphaned");
    assert.equal(stale.entries[0].binding.position, 999);
    assert.equal(stale.entries[0].binding.reason, "document-node-unavailable");

    position = 1;
    editor.setDoc(schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]));
    nodeView.destroy();
    const destroyedWithDoc = captureStable(editor, "destroyed NodeView before view teardown", 1, { dom: source });
    assert.equal(destroyedWithDoc.entries[0].binding.status, "orphaned");
    assertCodecAcceptsCapture(editor, destroyedWithDoc, "destroyed orphan");
    editor.setStateUnavailable();
    const destroyed = captureStable(editor, "destroyed NodeView with unavailable view state", 1, { stateAvailable: false, dom: source });
    assert.equal(destroyed.entries[0].binding.status, "orphaned");
    assert.equal(destroyed.entries[0].binding.position, 1);
    assert.equal(destroyed.entries[0].binding.reason, "node-view-destroyed");
    assert.equal(destroyed.entries[0].accepted.tex, "orphan");
    assert.equal(destroyed.entries[0].local.tex, "orphan-local");
    const repeated = captureStable(editor, "repeated orphan capture", 1, { stateAvailable: false, dom: source });
    assert.deepEqual(repeated, destroyed, "repeated capture preserves the same orphan payload");
  }

  {
    const node = inlineNode("throws", true);
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [node])]);
    const editor = makeEditor(doc);
    let throwPosition = false;
    const nodeView = inlineFactory({ node, editor, getPos: () => {
      if (throwPosition) throw new Error("stale NodeView position");
      return 1;
    } });
    const source = nodeView.dom.querySelector(".math-inline-source-editor");
    source.textContent = "throws-local";
    source.dispatchEvent({ type: "input" });
    throwPosition = true;
    const captured = captureStable(editor, "throwing getPos", 1, { dom: source });
    assert.equal(captured.entries[0].binding.status, "orphaned");
    assert.equal(captured.entries[0].binding.position, 1, "a failed getPos keeps the last safe position hint");
    assert.equal(captured.entries[0].binding.reason, "node-view-position-unavailable");
    nodeView.destroy();
  }

  {
    const node = blockNode("E=mc²", true);
    const doc = schema.nodes.doc.create(null, [node]);
    const editor = makeEditor(doc);
    const nodeView = blockFactory({ node, editor, getPos: () => 0 });
    const captured = captureStable(editor, "editing block math", 1, { dom: nodeView.dom });
    assert.equal(captured.entries[0].binding.status, "linked");
    assert.equal(captured.entries[0].binding.kind, "block");
    assert.equal(captured.entries[0].binding.position, 0);
    assert.equal(captured.entries[0].accepted.tex, "E=mc²");
    nodeView.destroy();
  }

  {
    const node = inlineNode("display-only", false);
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [node])]);
    const editor = makeEditor(doc);
    const nodeView = inlineFactory({ node, editor, getPos: () => 1 });
    const captured = captureStable(editor, "display-only formula", 0);
    assert.deepEqual(captured, { version: getPendingMathEditVersion(editor), entries: [] });
    nodeView.destroy();
  }

  console.log("check-math-recovery-capture: passed (real PM doc + InlineMath/BlockMath NodeViews)");
} finally {
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
  domHarness.restore();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
