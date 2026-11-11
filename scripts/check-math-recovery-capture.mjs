import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";
import { installMathDomHarness, TestElement } from "./math-dom-harness.mjs";
import ts from "typescript";

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
    flushPendingMathEdits,
    hasPendingMathEdits,
  } = await import(pathToFileURL(compiledMathNodes).href);
  const recoveryCodec = await import(pathToFileURL(compiledRecoveryCodec).href);
  const { subscribePendingEditorInput, pendingEditorInputVersion } = await import(pathToFileURL(
    compileTypeScriptModuleGraph(path.resolve('src/editor/pendingEditorBuffer.ts'), tempDir),
  ).href);

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
    marks: { strong: {} },
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
    let afterDispatch = () => {};
    const view = {
      get state() {
        if (stateUnavailable) throw new Error("editor view state unavailable");
        return state;
      },
      dispatch(transaction) {
        dispatchCount += 1;
        state = state.apply(transaction);
        afterDispatch(state.doc);
      },
      focus() { focusCount += 1; },
    };
    return {
      view,
      setDoc(nextDoc) { state = EditorState.create({ schema, doc: nextDoc }); },
      setState(nextState) { state = nextState; },
      setAfterDispatch(callback) { afterDispatch = callback; },
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
    const mathSource = fs.readFileSync('src/extensions/MathNodes.ts', 'utf8');
    const ast = ts.createSourceFile('math.ts', mathSource, ts.ScriptTarget.Latest, true);
    const names = new Set(['evaluateEditorMath', 'positionMathToken', 'subscribeMathRefresh']);
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join('\n');
    const cacheNames = new Set(['editorMathEvaluationCache', 'mathRefreshCallbacks', 'mathGlobalListenersInstalled']);
    const cache = ast.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => cacheNames.has(declaration.name.getText(ast)))).map(node => node.getText(ast)).join('\n');
    const compiled = ts.transpileModule(`${cache}\n${functions}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const maps = [];
    class TrackingWeakMap extends WeakMap {
      constructor() { super(); this.observedKeys = new Set(); maps.push(this); }
      set(key, value) { this.observedKeys.add(key); return super.set(key, value); }
    }
    const math = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/utils/mathMarkdown.ts'), tempDir)).href);
    const settings = { settings: { markdown: { mathNumbering: 'all-display' } } };
    const events = new Map();
    const api = new Function('WeakMap', 'appStore', 'mathTokenFromParts', 'evaluateMathTokens', 'window', `${compiled}; return { evaluate: evaluateEditorMath, subscribe: subscribeMathRefresh, cache: () => editorMathEvaluationCache };`)(TrackingWeakMap, settings, math.mathTokenFromParts, math.evaluateMathTokens, { addEventListener: (name, callback) => events.set(name, callback) });
    const evaluate = api.evaluate;
    const roots = Array.from({ length: 300 }, (_, index) => schema.nodes.doc.create(null, [
      blockNode('\\newcommand{\\RR}{\\mathbb{R}}', false), blockNode(`\\RR+${index}`, false),
    ]));
    const editor = makeEditor(roots[0]);
    const initial = evaluate(editor);
    const initialEntries = JSON.stringify([...initial.entriesByPos]);
    for (const root of roots) { editor.setDoc(root); evaluate(editor); }
    assert.equal(maps[0].observedKeys.size, 1, '300 retained history roots retain only one editor-keyed full evaluation');
    assert.equal(maps[0].get(editor).doc, roots.at(-1));
    assert.deepEqual([...maps[0].get(editor).entriesByPos.values()].at(-1).availableMacroNames, ['\\RR']);
    editor.setDoc(roots[0]);
    const undone = evaluate(editor);
    assert.notEqual(undone, initial, 'old history roots recompute evaluation instead of retaining their old full index');
    assert.equal(JSON.stringify([...undone.entriesByPos]), initialEntries, 'history undo preserves exact macro/numbering evaluation');
    editor.setDoc(roots.at(-1));
    const redone = evaluate(editor);
    assert.equal(evaluate(editor), redone, 'current unchanged root reuses its single evaluation');
    settings.settings.markdown.mathNumbering = 'none';
    const unnumbered = evaluate(editor);
    assert.notEqual(unnumbered, redone, 'numbering changes invalidate the current cache');
    assert.equal(unnumbered.numberingMode, 'none');
    const second = makeEditor(roots[0]);
    evaluate(second);
    assert.equal(maps[0].observedKeys.size, 2, 'separate editors own separate bounded cache slots');
    assert.equal(maps[0].observedKeys.has(roots[0]), false, 'history roots are never cache keys');
    let refreshCount = 0;
    const unsubscribe = api.subscribe(() => { refreshCount++; evaluate(editor); evaluate(second); });
    for (const event of ['lightmark:math-settings-changed', 'lightmark:refresh-math']) {
      const before = api.cache();
      events.get(event)();
      assert.notEqual(api.cache(), before, `${event}: invalidate once before notifying live NodeViews`);
      assert.equal(api.cache().observedKeys.size, 2, 'all refreshed NodeViews reuse one bounded evaluation per editor');
    }
    assert.equal(refreshCount, 2);
    unsubscribe();
    events.get('lightmark:refresh-math')();
    assert.equal(refreshCount, 2, 'destroyed/unsubscribed views no longer retain a refresh callback');
  }

  for (const kind of ['inline', 'block']) {
    for (const change of ['equivalent', 'raw', 'marks', 'type']) {
      const node = kind === 'block' ? blockNode('x', true) : inlineNode('x', true);
      const wrap = value => schema.nodes.doc.create(null, kind === 'block'
        ? [value, schema.nodes.paragraph.create()]
        : schema.nodes.paragraph.create(null, value));
      const editor = makeEditor(wrap(node));
      const nodeView = (kind === 'block' ? blockFactory : inlineFactory)({ node, editor, getPos: () => kind === 'block' ? 0 : 1 });
      const control = nodeView.dom.querySelector(kind === 'block' ? '.math-block-editor' : '.math-inline-source-editor');
      if (kind === 'block') control.value = 'x+1'; else control.textContent = 'x+1';
      control.dispatchEvent({ type: 'input' });
      let replacement = schema.nodeFromJSON(node.toJSON());
      if (change === 'raw') replacement = node.type.create({ ...node.attrs, raw: 'different spelling' });
      if (change === 'marks') replacement = node.mark([schema.marks.strong.create()]);
      if (change === 'type') replacement = kind === 'block' ? schema.nodes.paragraph.create() : schema.text('replacement');
      editor.setDoc(wrap(replacement));
      // No NodeView.update: eq roots are deliberately reused by PM, while
      // unacknowledged changed content still must reject the stale buffer.
      if (change === 'equivalent') {
        assert.notEqual(replacement, node);
        assert.equal(replacement.eq(node), true);
        editor.setAfterDispatch(doc => nodeView.update(kind === 'block' ? doc.firstChild : doc.firstChild.firstChild));
        const key = { type: 'keydown', key: 'Enter', ctrlKey: kind === 'block', metaKey: false, preventDefault() {} };
        control.dispatchEvent(key);
        const actual = kind === 'block' ? editor.view.state.doc.firstChild : editor.view.state.doc.firstChild.firstChild;
        assert.equal(actual.attrs.tex, 'x+1', `${kind}: eq root reconstruction keeps the live NodeView commit valid`);
      } else {
        await assert.rejects(flushPendingMathEdits(editor), /公式节点已被文档更新/);
        assert.equal(editor.dispatchCount, 0, `${kind}/${change}: conflict cannot overwrite different node attrs, marks or type`);
      }
      nodeView.destroy();
    }
  }

  {
    // Exercise the exact performance setup against the production NodeView,
    // then its real Ctrl+Enter handler; no attribute-only surrogate commit.
    const bridgeSource = fs.readFileSync('src/performanceQaBridge.ts', 'utf8');
    const bridgeAst = ts.createSourceFile('bridge.ts', bridgeSource, ts.ScriptTarget.Latest, true);
    const setupNode = bridgeAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'prepareFormulaCommit');
    assert.ok(setupNode);
    const setupJs = ts.transpileModule(setupNode.getText(bridgeAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    class SetupEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init); }
      preventDefault() { this.defaultPrevented = true; }
    }
    const setup = new Function('MouseEvent', 'InputEvent', `${setupJs}; return prepareFormulaCommit;`)(SetupEvent, SetupEvent);
    assert.throws(() => setup({ session: {} }), /Owned formula editor is unavailable/);
    const node = blockNode('x^2', false);
    const editor = makeEditor(schema.nodes.doc.create(null, [node, schema.nodes.paragraph.create()]));
    Object.defineProperty(editor, 'state', { get: () => editor.view.state });
    const nodeView = blockFactory({ node, editor, getPos: () => 0 });
    editor.setAfterDispatch(doc => nodeView.update(doc.firstChild));
    editor.view.dom = testDocument.createElement('div');
    editor.view.dom.appendChild(nodeView.dom);
    editor.view.nodeDOM = position => position === 0 ? nodeView.dom : null;
    const equivalentDoc = schema.nodeFromJSON(editor.state.doc.toJSON());
    assert.equal(equivalentDoc.eq(editor.state.doc), true);
    assert.notEqual(equivalentDoc.firstChild, editor.state.doc.firstChild);
    // ProseMirror can retain an eq NodeView without calling update when a
    // document/history root is reconstructed with identical immutable nodes.
    editor.setDoc(equivalentDoc);
    const prepared = setup({ session: { editorIdentity: editor } });
    assert.equal(prepared.expectedTex, 'x^2+1');
    assert.equal(editor.state.doc.firstChild.attrs.tex, 'x^2', 'setup creates a real pending local buffer before model commit');
    assert.equal(hasPendingMathEdits(editor), true);
    const textarea = nodeView.dom.querySelector('.math-block-editor');
    assert.equal(document.activeElement, textarea);
    const key = new SetupEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false });
    textarea.dispatchEvent(key);
    assert.equal(key.defaultPrevented, true);
    assert.equal(editor.state.doc.firstChild.attrs.tex, prepared.expectedTex, 'production Ctrl+Enter commits exactly the prepared TeX');
    assert.equal(nodeView.dom.querySelector('.math-block-editor'), null, 'commit closes the actual source control');
    assert.equal(hasPendingMathEdits(editor), false);
    nodeView.destroy();
  }

  {
    const node = blockNode('x', true);
    const editor = makeEditor(schema.nodes.doc.create(null, node));
    const nodeView = blockFactory({ node, editor, getPos: () => 0 });
    editor.setAfterDispatch(doc => nodeView.update(doc.firstChild));
    const textarea = nodeView.dom.querySelector('.math-block-editor');
    assert.ok(textarea, 'real BlockMath NodeView exposes the source textarea');
    textarea.selectionStart = 1;
    textarea.selectionEnd = 1;
    textarea.setSelectionRange = (anchor, head) => { textarea.selectionStart = anchor; textarea.selectionEnd = head; };
    textarea.focus();
    let dirtyNotifications = 0;
    const unsubscribe = subscribePendingEditorInput(editor, () => { dirtyNotifications++; });
    const inputVersion = getPendingMathInputVersion(editor);
    const bufferVersion = pendingEditorInputVersion(editor);
    textarea.value = 'x+2';
    textarea.dispatchEvent({ type: 'input' });
    assert.equal(dirtyNotifications, 1, 'one real math input immediately notifies its owning document');
    assert.ok(getPendingMathInputVersion(editor) > inputVersion);
    assert.ok(pendingEditorInputVersion(editor) > bufferVersion);
    assert.equal(editor.view.state.doc.firstChild.attrs.tex, 'x', 'pending input is dirty before its PM commit');
    await flushPendingMathEdits(editor, { flushId: 'focused-save-1' });
    await flushPendingMathEdits(editor, { flushId: 'focused-save-2' });
    assert.equal(editor.view.state.doc.firstChild.attrs.tex, 'x+2');
    assert.equal(hasPendingMathEdits(editor), false);
    assert.equal(nodeView.dom.querySelector('.math-block-editor'), textarea, 'ordinary consecutive saves retain the actual source control');
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.selectionStart, 1);
    assert.equal(textarea.selectionEnd, 1);
    assert.equal(dirtyNotifications, 1, 'flush confirmation does not fabricate a new local input notification');
    unsubscribe();
    nodeView.destroy();
  }

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
