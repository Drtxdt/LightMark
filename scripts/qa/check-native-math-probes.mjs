import assert from "node:assert/strict";
import vm from "node:vm";
import {
  runMathRecoveryProbe,
  runMathSaveProbe,
  runMathWindowDraftProbe,
} from "./isolated-native-evidence.mjs";

class MockNode {
  constructor({ className = "", textContent = "", connected = true, attributes = {}, outerHTML = "<div></div>" } = {}) {
    this.className = className;
    this.textContent = textContent;
    this.isConnected = connected;
    this.outerHTML = outerHTML;
    this.parentElement = null;
    this.children = new Map();
    this.attributes = new Map(Object.entries(attributes));
    const classes = new Set(className.split(/\s+/u).filter(Boolean));
    this.classList = { contains: (name) => classes.has(name) };
  }

  set(selector, values) {
    const children = Array.isArray(values) ? values : [values];
    for (const child of children) if (child) child.parentElement = this;
    this.children.set(selector, children.filter(Boolean));
    return this;
  }

  querySelectorAll(selector) {
    return this.children.get(selector) || [];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (selector.startsWith(".") && current.classList.contains(selector.slice(1))) return current;
      current = current.parentElement;
    }
    return null;
  }

  contains(target) {
    let current = target;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
}

function makeMathDocument(state, { split, initialFormula }) {
  const source = new MockNode({
    className: "math-inline-source-editor",
    textContent: initialFormula,
    outerHTML: `<span class="math-inline-source-editor">${initialFormula}</span>`,
  });
  const mathNode = new MockNode({
    className: "math-node-inline",
    textContent: initialFormula,
    outerHTML: `<span class="math-node-inline">${initialFormula}</span>`,
  }).set(".math-inline-source-editor", [source]);
  const heading = new MockNode({ className: "heading", outerHTML: "<h1>QA fixture</h1>" });
  const proseMirror = new MockNode({
    className: "ProseMirror",
    textContent: `A ${initialFormula} B`,
    outerHTML: `<div class="ProseMirror">A ${initialFormula} B</div>`,
  })
    .set(".math-node-inline", [mathNode])
    .set(".math-inline-source-editor", [source])
    .set("h1", [heading]);
  const shell = new MockNode({ className: "lm-editor-scroll" }).set(".ProseMirror", [proseMirror]);
  const workspace = new MockNode({ className: "lm-workspace" }).set(".lm-editor-scroll", [shell]);
  const mainPane = new MockNode({ className: "lm-editor-pane active" })
    .set(".lm-editor-scroll", [shell])
    .set(".ProseMirror", [proseMirror]);
  const secondaryProseMirror = new MockNode({ className: "ProseMirror", textContent: "secondary" });
  const secondaryShell = new MockNode({ className: "lm-editor-scroll" }).set(".ProseMirror", [secondaryProseMirror]);
  const secondaryPane = new MockNode({ className: "lm-editor-pane" })
    .set(".lm-editor-scroll", [secondaryShell])
    .set(".ProseMirror", [secondaryProseMirror]);
  const document = {
    activeElement: null,
    dialog: null,
    querySelectorAll(selector) {
      if (selector === "main.lm-workspace") return split ? [] : [workspace];
      if (selector === ".lm-editor-pane") return split ? [mainPane, secondaryPane] : [];
      if (selector === ".lm-editor-pane.active") return split ? [mainPane] : [];
      if (selector === ".lm-editor-scroll") return split ? [shell, secondaryShell] : [shell];
      if (selector === ".ProseMirror") return split ? [proseMirror, secondaryProseMirror] : [proseMirror];
      if (selector === ".math-node, [data-type=\"inline-math\"]") return [mathNode];
      if (selector === 'section[role="dialog"]') return this.dialog ? [this.dialog] : [];
      return [];
    },
  };
  source.focus = () => { document.activeElement = source; };
  source.dispatchEvent = () => {
    state.markPending();
    return true;
  };
  mathNode.dispatchEvent = () => true;
  return { document, source, mathNode, proseMirror };
}

function token(state) {
  return { ...state.mutationToken };
}

function createHarness(phase, context) {
  const evidence = context.scenarioEvidence;
  const initialFormula = phase === "math-save" ? evidence.initialFormula : evidence.draftInitialFormula;
  const initialContent = phase === "math-save" ? context.fixtureContent : "Draft $d$";
  const state = {
    phase,
    tab: null,
    session: null,
    flushSequence: 0,
    mutationToken: { documentGeneration: 0, pendingInputVersion: 0, revision: 0 },
    markPending() {
      this.mutationToken.pendingInputVersion += 1;
      this.appStore.isDirty = true;
      if (this.tab) this.tab.isDirty = true;
      this.pending = true;
    },
    pending: false,
    dialog: null,
    closeResolve: null,
  };
  const dom = makeMathDocument(state, { split: phase === "math-window-draft", initialFormula });
  state.document = dom.document;
  const appStore = {
    activeTabId: null,
    currentContent: initialContent,
    editorMode: "wysiwyg",
    documentMode: "normal",
    isDirty: false,
    splitLayout: { enabled: phase === "math-window-draft", activePaneId: "main" },
    settings: { general: { launchBehavior: "", restoreLastFile: false } },
    tabs: [],
  };
  state.appStore = appStore;

  const session = {
    id: `session-${phase}`,
    revision: 0,
    hasPendingEdits: () => state.pending === true,
    pendingEditVersion: () => state.mutationToken.pendingInputVersion,
    mutationToken: () => token(state),
    flushPendingEdits: async () => {
      const before = token(state);
      state.mutationToken.documentGeneration += 1;
      state.pending = false;
      state.appStore.isDirty = false;
      if (state.tab) state.tab.isDirty = false;
      const after = token(state);
      return {
        sessionIdentity: session,
        flushId: `qa-flush-${++state.flushSequence}`,
        before,
        after,
        firstAuthorizedGeneration: after.documentGeneration,
        lastAuthorizedGeneration: after.documentGeneration,
        authorizedMutationCount: 1,
      };
    },
    finalizeClosePrompt: async () => {
      const before = token(state);
      state.mutationToken.documentGeneration += 1;
      state.pending = false;
      appStore.currentContent = evidence.expectedDraftContent;
      if (state.tab) state.tab.content = evidence.expectedDraftContent;
      const after = token(state);
      return {
        sessionIdentity: session,
        flushId: `qa-flush-${++state.flushSequence}`,
        before,
        after,
        firstAuthorizedGeneration: after.documentGeneration,
        lastAuthorizedGeneration: after.documentGeneration,
        authorizedMutationCount: 1,
      };
    },
  };
  state.session = session;

  const draft = { draftStore: { status: phase === "math-recover" ? "pending" : "idle" } };
  const store = {
    appStore,
    getPaneTab: (paneId) => paneId === "main" ? state.tab : null,
    setActivePane: async (paneId) => { appStore.splitLayout.activePaneId = paneId; },
    openFile: async (filePath) => {
      const tab = { id: "tab-math-save", path: filePath, content: context.fixtureContent, kind: "file", documentMode: "normal", editorMode: "wysiwyg", isDirty: false };
      state.tab = tab;
      appStore.tabs = [tab];
      appStore.activeTabId = tab.id;
      appStore.currentContent = context.fixtureContent;
    },
    switchMode: async (mode) => { appStore.editorMode = mode; if (state.tab) state.tab.editorMode = mode; },
    createUntitledTab: (name) => {
      const tab = { id: "tab-math-draft", path: "", name, content: initialContent, kind: "untitled", documentMode: "normal", editorMode: "source", isDirty: false };
      state.tab = tab;
      appStore.tabs = [tab];
      return tab;
    },
    activateTab: async (tabId) => { appStore.activeTabId = tabId; },
    saveCurrentFile: async () => {
      appStore.currentContent = evidence.expectedSavedContent;
      if (state.tab) state.tab.content = evidence.expectedSavedContent;
      await state.session.flushPendingEdits("save");
      return true;
    },
    persistConfig: async () => {},
    getDirtyTabs: () => appStore.tabs.filter((tab) => tab.isDirty),
  };
  const runtime = {
    waitForDocumentSession: async (tabId, mode, timeoutMs) => {
      assert.equal(tabId, state.tab?.id);
      assert.equal(mode, "wysiwyg");
      assert.equal(timeoutMs, 15000);
      return state.session;
    },
  };
  const pathApi = {
    appConfigDir: async () => context.expectedAppConfigDir,
    appDataDir: async () => context.expectedAppDataDir,
    appLocalDataDir: async () => context.expectedAppLocalDataDir,
  };

  const closeDialog = () => {
    const discard = new MockNode({ textContent: "不保存退出", outerHTML: "<button>不保存退出</button>" });
    discard.click = () => {
      const resolve = state.closeResolve;
      state.closeResolve = null;
      state.document.dialog = null;
      resolve?.(null);
    };
    state.document.dialog = new MockNode({ attributes: { role: "dialog" } }).set("button", [discard]);
  };
  const recoveryDialog = () => {
    const restore = new MockNode({ textContent: "恢复草稿", outerHTML: "<button>恢复草稿</button>" });
    restore.click = () => {
      const tab = { id: "tab-recovered-draft", path: "", content: evidence.expectedDraftContent, kind: "untitled", documentMode: "normal", editorMode: "wysiwyg", isDirty: true };
      state.tab = tab;
      appStore.tabs = [tab];
      appStore.activeTabId = tab.id;
      appStore.currentContent = evidence.expectedDraftContent;
      draft.draftStore.status = "restored";
      state.document.dialog = null;
    };
    state.document.dialog = new MockNode({ attributes: { role: "dialog", "aria-label": "可恢复草稿" } }).set("button", [restore]);
  };
  if (phase === "math-recover") recoveryDialog();

  const invoke = async (command) => {
    if (command === "read_text_file") return evidence.expectedSavedContent;
    if (command !== "plugin:window|close") throw new Error(`unexpected QA invoke: ${command}`);
    if (phase === "math-save") return null;
    if (phase === "math-window-draft") await state.session.finalizeClosePrompt();
    return await new Promise((resolve) => {
      state.closeResolve = resolve;
      closeDialog();
    });
  };
  const modules = new Map([
    ["/src/stores/appStore.ts", store],
    ["/src/editor/documentRuntime.ts", runtime],
    ["/src/stores/draftStore.ts", draft],
    ["/node_modules/@tauri-apps/api/path.js", pathApi],
  ]);
  const sandbox = {
    document: state.document,
    __TAURI_INTERNALS__: { invoke },
    InputEvent: class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    MouseEvent: class MouseEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    setTimeout,
    clearTimeout,
  };
  const importModule = async (specifier) => {
    const module = modules.get(specifier);
    if (!module) throw new Error(`unexpected generated probe module: ${specifier}`);
    return module;
  };
  sandbox.__qaImport = importModule;
  const client = {
    evaluate: async (expression) => await vm.runInNewContext(
      expression.replaceAll("import(", "__qaImport("),
      sandbox,
      { timeout: 3000 },
    ),
  };
  return { client, state };
}

const context = {
  fixturePath: "C:\\LightMark-QA\\math-receipt.md",
  fixtureContent: "# Math receipt fixture\n\nA $x$ B\n\n",
  expectedAppConfigDir: "C:\\LightMark-QA\\config",
  expectedAppDataDir: "C:\\LightMark-QA\\data",
  expectedAppLocalDataDir: "C:\\LightMark-QA\\local",
  scenarioEvidence: {
    initialFormula: "x",
    draftInitialFormula: "d",
    savedFormula: "x+1",
    draftFormula: "draft+1",
    expectedSavedContent: "# Math receipt fixture\n\nA $x+1$ B\n\n",
    expectedDraftContent: "Draft $draft+1$",
  },
};

const saveHarness = createHarness("math-save", context);
const saveResult = await runMathSaveProbe(saveHarness.client, context);
assert.equal(saveResult.receiptSource, "ordinary-flush");
assert.deepEqual(Array.from(saveResult.receiptSources, ({ kind }) => kind), ["ordinary-flush"]);

const draftHarness = createHarness("math-window-draft", context);
const draftResult = await runMathWindowDraftProbe(draftHarness.client, context);
assert.equal(draftResult.closeFinalizeReceiptObserved, true);
assert.equal(draftResult.ordinaryFlushReceiptCount, 0);
assert.equal(draftResult.closeFinalizeReceiptCount, 1);
assert.equal(draftResult.pendingFlushProof, true);
assert.equal(draftResult.closeFinalizeProof, true);
assert.deepEqual(Array.from(draftResult.receiptSources), ["close-finalize"]);

const recoveryHarness = createHarness("math-recover", context);
const recoveryResult = await runMathRecoveryProbe(recoveryHarness.client, context);
assert.equal(recoveryResult.draftStatus, "restored");
assert.equal(recoveryResult.content, context.scenarioEvidence.expectedDraftContent);
assert.equal(recoveryResult.dirty, true);

console.log(JSON.stringify({
  message: "native Math probe evaluate harness executed all three complete runMath* probes",
  phases: [
    { name: "math-save", evaluateCalls: 1, receiptSources: saveResult.receiptSources.map(({ kind }) => kind) },
    { name: "math-window-draft", evaluateCalls: 1, receiptSources: draftResult.receiptSources },
    { name: "math-recover", evaluateCalls: 1, draftStatus: recoveryResult.draftStatus },
  ],
}, null, 2));
