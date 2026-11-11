import { getCurrentWindow } from "@tauri-apps/api/window";
import { appConfigDir, appDataDir, appLocalDataDir } from "@tauri-apps/api/path";
import {
  appStore,
  getPaneContent,
  getPaneDocumentMode,
  getPaneEditorMode,
  getPaneStructuredOutline,
  getPaneTab,
  loadConfig,
  openFile,
  setActivePane,
  setPaneContent,
  switchMode,
} from "./stores/appStore";
import {
  documentSessionForPane,
  subscribeDocumentRuntime,
  documentHistoryForTab,
  moveDocumentHistory,
  type DocumentSessionAdapter,
} from "./editor/documentRuntime";
import type { DocumentMode, EditorMode, LargeFileState } from "./types";
import { readLargeSourceRange, resolveLargeSourcePosition } from "./editor/largeSourceClient";

const BRIDGE_SCHEMA_VERSION = 1;
const FIXTURE_IDS = new Set([
  "normal-writing",
  "large-document",
  "formula-dense",
  "table-dense",
  "image-dense",
  "long-lines",
  "source-50000-lines",
  "wys-50000-paragraphs",
]);
const MODES = new Set<EditorMode>(["source", "wysiwyg"]);
const LOCATIONS = new Set(["head", "middle", "tail"]);
const OPERATIONS = new Set([
  "insert-text",
  "delete-backward",
  "insert-newline",
  "multi-range-edit",
  "paste-text",
  "formula-commit",
  "scroll",
]);
const SCROLL_LOCATIONS = new Set(["head", "middle", "tail"]);
const INSERT_TEXT = " QA🙂";
const PASTE_TEXT = " pasted🙂\n";
const DEFAULT_TIMEOUT_MS = 10_000;

type LocationName = "head" | "middle" | "tail";
type BridgeOperation = "insert-text" | "insert-newline" | "multi-range-edit" | "delete-backward" | "paste-text" | "formula-commit" | "scroll";
type BridgeMode = "source" | "wysiwyg";

interface FixtureConfig {
  id: string;
  relativePath: string;
  path: string;
  category: string;
  sha256: string;
  supportedModes: string[];
  payload?: { utf16Start: number; utf16End: number; sourceLineCount: number | null; paragraphCount: number | null };
  metrics?: {
    utf8Bytes?: number;
    utf16Length?: number;
    lineCount?: number;
  };
}

interface PerformanceBridgeConfig {
  schemaVersion: number;
  nonce: string;
  expectedOrigin: string;
  fixtureRoot: string;
  profileToken: string;
  processToken: string;
  probeMode: string;
  fixtures: Record<string, FixtureConfig>;
}

interface ActiveFixture {
  fixture: FixtureConfig;
  tabId: string;
  documentMode: DocumentMode;
  editorMode: EditorMode;
  session: DocumentSessionAdapter;
  baselineText?: string;
  baselineRevision: number;
  baselineRoot?: import("./editor/documentHistory").DocumentHistoryRoot;
  largeBaseline?: {
    revision: number;
    savedRevision: number;
    sizeBytes: number;
    totalLines: number;
  };
  pending?: PendingOperation;
}

interface PendingOperation {
  fixtureId: string;
  operation: BridgeOperation;
  location: LocationName;
  sampleId: string;
  startedAt: number;
  beforeRevision: number;
  beforeDirty: boolean;
  method: string;
  timingMetric: string;
  root?: HTMLElement;
  dispatchAt: number | null;
  modelAcceptedAt: number | null;
  domUpdatedAt: number | null;
  rafOpportunityAt: number | null;
  presentationObservedAt: number | null;
  longTasks?: { startTime: number; duration: number }[];
  longTaskObservation?: string;
  rafScheduled?: boolean;
  synchronousCommandMs?: number;
  modelComputeMs?: number;
  dispatchObservableMs?: number;
  keyHandlerObservableMs?: number;
  viewUpdateObservableMs?: number;
  formula?: { position: number; expectedTex: string; dom: HTMLElement; control: HTMLTextAreaElement; suggestOpen: boolean };
  formulaKey?: { key: string; ctrlKey: boolean; metaKey: boolean; keyCode: number; isComposing: boolean; defaultPrevented: boolean; targetIsControl: boolean; targetClass: string | null; activeClass: string | null; controlConnected: boolean };
  cleanup: () => void;
}

export interface PerformanceQaBridge {
  readonly schemaVersion: number;
  readonly bridgeEnabled: true;
  ready(): Promise<Record<string, unknown>>;
  supports(fixtureId: string, operation: BridgeOperation): Promise<Record<string, unknown>>;
  open(fixtureId: string): Promise<Record<string, unknown>>;
  mode(fixtureId: string, mode: BridgeMode): Promise<Record<string, unknown>>;
  reset(fixtureId: string): Promise<Record<string, unknown>>;
  prepareOperation(fixtureId: string, operation: BridgeOperation, location: LocationName): Promise<Record<string, unknown>>;
  completeOperation(fixtureId: string, operation: BridgeOperation, location: LocationName): Promise<Record<string, unknown>>;
  verify(fixtureId: string): Promise<Record<string, unknown>>;
  memory(fixtureId: string): Promise<Record<string, unknown>>;
  shutdown(): Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    __LIGHTMARK_PERF_BRIDGE__?: PerformanceQaBridge;
  }
}

function envValue(name: string) {
  return (import.meta.env as ImportMetaEnv & Record<string, string | undefined>)[name];
}

function parseConfig(): PerformanceBridgeConfig {
  const raw = envValue("VITE_LIGHTMARK_PERF_CONFIG_JSON");
  if (!raw) throw new Error("QA performance bridge configuration is missing.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`QA performance bridge configuration is not JSON: ${String(error)}`);
  }
  if (!value || typeof value !== "object") throw new Error("QA performance bridge configuration is not an object.");
  const config = value as Partial<PerformanceBridgeConfig>;
  if (config.schemaVersion !== BRIDGE_SCHEMA_VERSION) throw new Error("Unsupported QA performance bridge schema.");
  for (const field of ["nonce", "expectedOrigin", "fixtureRoot", "profileToken", "processToken", "probeMode"] as const) {
    if (typeof config[field] !== "string" || config[field].trim().length === 0) {
      throw new Error(`QA performance bridge configuration is missing ${field}.`);
    }
  }
  if (!config.fixtures || typeof config.fixtures !== "object") throw new Error("QA performance fixture catalog is missing.");
  const fixtures: Record<string, FixtureConfig> = {};
  for (const [fixtureId, rawFixture] of Object.entries(config.fixtures)) {
    if (!FIXTURE_IDS.has(fixtureId)) throw new Error(`Unknown QA fixture id in compiled catalog: ${fixtureId}`);
    if (!rawFixture || typeof rawFixture !== "object") throw new Error(`Invalid QA fixture catalog entry: ${fixtureId}`);
    const fixture = rawFixture as Partial<FixtureConfig>;
    if (fixture.id !== fixtureId || typeof fixture.relativePath !== "string" || typeof fixture.path !== "string") {
      throw new Error(`QA fixture catalog identity mismatch: ${fixtureId}`);
    }
    if (!/^[a-f0-9]{64}$/iu.test(fixture.sha256 || "")) throw new Error(`QA fixture hash is invalid: ${fixtureId}`);
    if (!Array.isArray(fixture.supportedModes) || fixture.supportedModes.length === 0) {
      throw new Error(`QA fixture modes are missing: ${fixtureId}`);
    }
    fixtures[fixtureId] = fixture as FixtureConfig;
  }
  return { ...config, fixtures } as PerformanceBridgeConfig;
}

function normalizedPath(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase();
}

function isOwnedPath(root: string, candidate: string) {
  const rootPath = normalizedPath(root);
  const candidatePath = normalizedPath(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

function validateCatalogPaths(config: PerformanceBridgeConfig) {
  for (const fixture of Object.values(config.fixtures)) {
    if (!isOwnedPath(config.fixtureRoot, fixture.path)) {
      throw new Error(`QA fixture path escapes the owned root: ${fixture.id}`);
    }
    if (fixture.relativePath.split(/[\\/]+/u).includes("..")) {
      throw new Error(`QA fixture relative path contains traversal: ${fixture.id}`);
    }
  }
}

function assertOrigin(config: PerformanceBridgeConfig) {
  const actualOrigin = typeof globalThis.location !== "undefined" ? globalThis.location.origin : "unknown";
  if (actualOrigin !== config.expectedOrigin) {
    throw new Error(`QA bridge origin mismatch: expected ${config.expectedOrigin}, got ${actualOrigin}`);
  }
}

function assertFixtureId(config: PerformanceBridgeConfig, fixtureId: string) {
  if (typeof fixtureId !== "string" || !FIXTURE_IDS.has(fixtureId) || !config.fixtures[fixtureId]) {
    throw new Error(`Unsupported QA fixture id: ${String(fixtureId)}`);
  }
  return config.fixtures[fixtureId];
}

function assertOperation(operation: BridgeOperation) {
  if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
    throw new Error(`Unsupported QA operation: ${String(operation)}`);
  }
  return operation;
}

function assertLocation(locationName: LocationName) {
  if (typeof locationName !== "string" || !LOCATIONS.has(locationName)) {
    throw new Error(`Unsupported QA operation location: ${String(locationName)}`);
  }
  return locationName;
}

function assertMode(mode: BridgeMode) {
  if (typeof mode !== "string" || !MODES.has(mode)) throw new Error(`Unsupported QA editor mode: ${String(mode)}`);
  return mode;
}

async function waitFor<T>(label: string, predicate: () => T | null | false, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
  throw new Error(`${label} timed out.`);
}

function editorElement(mode: EditorMode, documentMode: DocumentMode) {
  const panes = [...document.querySelectorAll<HTMLElement>(".lm-editor-pane")];
  const scope = panes.length > 0
    ? panes.find((pane) => pane.classList.contains("active"))
    : document.querySelector<HTMLElement>(".lm-workspace");
  if (!scope) return null;
  const selector = documentMode === "large"
    ? "[data-large-source-editor] .cm-content"
    : mode === "source" ? ".cm-editor .cm-content" : ".ProseMirror";
  const candidates = [...scope.querySelectorAll<HTMLElement>(selector)].filter((candidate) => {
    if (!candidate.isConnected) return false;
    const page = candidate.closest<HTMLElement>(".editor-page");
    return !page || ![...page.classList].some((className) => /-leave-(active|from|to)$/u.test(className));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function scrollElement(documentMode: DocumentMode) {
  const panes = [...document.querySelectorAll<HTMLElement>(".lm-editor-pane")];
  const scope = panes.length > 0
    ? panes.find((pane) => pane.classList.contains("active"))
    : document.querySelector<HTMLElement>(".lm-workspace");
  if (!scope) return null;
  const selector = documentMode === "large" ? "[data-large-source-editor] .cm-scroller" : ".lm-editor-scroll";
  const candidates = [...scope.querySelectorAll<HTMLElement>(selector)].filter((candidate) => {
    const page = candidate.closest<HTMLElement>(".editor-page");
    return candidate.isConnected && (!page || ![...page.classList].some((className) => /-leave-(active|from|to)$/u.test(className)));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function targetOffset(locationName: LocationName, length: number) {
  if (locationName === "head") return 0;
  if (locationName === "tail") return Math.max(0, length - 1);
  return Math.max(0, Math.floor(length / 2));
}

function targetLine(locationName: LocationName, totalLines: number) {
  if (locationName === "head") return 0;
  if (locationName === "tail") return Math.max(0, totalLines - 1);
  return Math.max(0, Math.floor(totalLines / 2));
}

function bridgeMethod(operation: BridgeOperation) {
  if (operation === "multi-range-edit") return "qa-owned-editor.transaction";
  if (operation === "delete-backward" || operation === "insert-newline" || operation === "formula-commit") return "cdp.Input.dispatchKeyEvent";
  if (operation === "paste-text") return "cdp.Input.insertText(paste-surrogate)";
  if (operation === "scroll") return "owned-editor.scrollTop";
  return "cdp.Input.insertText";
}

function supportsOperation(active: ActiveFixture, operation: BridgeOperation) {
  if (operation === "scroll") return { supported: true, reason: "fixed owned editor scroll target" };
  if (operation === "paste-text") {
    return { supported: false, reason: "clipboard injection is intentionally outside this bridge; use an owned clipboard phase" };
  }
  if (operation === "formula-commit") {
    return { supported: active.fixture.id === "formula-dense" && active.editorMode === "wysiwyg" && active.documentMode === "normal", reason: "owned mounted block formula textarea committed by CDP Ctrl+Enter" };
  }
  if (active.documentMode === "large") {
    return { supported: false, reason: "large editing requires a visible textarea block and is measured through scroll in this phase" };
  }
  return { supported: true, reason: "normal editor accepts fixed CDP input" };
}

function prepareFormulaCommit(active: ActiveFixture) {
  const editor = (active.session as DocumentSessionAdapter & { editorIdentity?: import("@tiptap/core").Editor }).editorIdentity;
  if (!editor) throw new Error("Owned formula editor is unavailable.");
  let position: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (position == null && node.type.name === "blockMath") position = pos;
    return position == null;
  });
  if (position == null) throw new Error("Formula fixture has no block formula.");
  const dom = editor.view.nodeDOM(position);
  if (!(dom instanceof HTMLElement) || !editor.view.dom.contains(dom)) throw new Error("Owned formula NodeView is unavailable.");
  dom.scrollIntoView({ block: "center" });
  dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  const textarea = dom.querySelector<HTMLTextAreaElement>(".math-block-editor");
  if (!textarea || document.activeElement !== textarea) throw new Error("Formula NodeView did not open its focused textarea.");
  const expectedTex = `${textarea.value}+1`;
  textarea.value = expectedTex;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "+1" }));
  textarea.setSelectionRange(expectedTex.length, expectedTex.length);
  return { position, expectedTex, dom, control: textarea, suggestOpen: Boolean(dom.querySelector('.math-suggest')) };
}

async function sessionForPane(tabId: string, mode: EditorMode, previous: DocumentSessionAdapter | null = null) {
  return await waitFor("QA editor session", () => {
    const session = documentSessionForPane("main");
    return session && session.tabId === tabId && session.mode === mode && (!previous || session !== previous)
      ? session
      : null;
  });
}

async function waitForEditor(mode: EditorMode, documentMode: DocumentMode, session: DocumentSessionAdapter | null = null) {
  return await waitFor("QA editor root", () => {
    if (session && documentSessionForPane("main") !== session) return null;
    return editorElement(mode, documentMode);
  });
}

async function focusAt(active: ActiveFixture, locationName: LocationName) {
  if (active.documentMode === "large") {
    const state = getPaneTab("main")?.largeFile;
    if (!state) throw new Error("Large QA fixture state is unavailable.");
    const line = targetLine(locationName, state.totalLines);
    active.session.navigate({ line, offset: 0 });
    const deadline = performance.now() + DEFAULT_TIMEOUT_MS;
    let loaded = false;
    while (performance.now() < deadline) {
      const captured = JSON.parse(await active.session.captureRecoveryBundle!()) as { windowRange: unknown; logicalHead: { line: number }; text: string };
      if (captured.windowRange && captured.logicalHead.line === line && captured.text.length > 0) { loaded = true; break; }
      await new Promise<void>(resolve => window.setTimeout(resolve, 16));
    }
    if (!loaded) throw new Error("Large QA logical navigation did not settle.");
    const root = await waitForEditor(active.editorMode, active.documentMode, active.session);
    root.focus();
    return;
  }
  const length = active.baselineText?.length ?? getPaneContent("main").length;
  const payload = active.fixture.payload;
  const offset = payload && locationName === "head" ? payload.utf16Start : targetOffset(locationName, length);
  active.session.navigate({ offset });
  const root = await waitForEditor(active.editorMode, active.documentMode, active.session);
  root.focus();
}

async function openFixture(config: PerformanceBridgeConfig, fixtureId: string) {
  const fixture = assertFixtureId(config, fixtureId);
  phase(fixtureId, "open-start");
  const startedAt = performance.now();
  await setActivePane("main");
  await loadConfig();
  const defaultMode = appStore.settings.editor.defaultMode;
  // Fixture opening measures its requested editor directly. Mode conversion
  // has its own correctness matrix and must not precede every Source sample.
  appStore.settings.editor.defaultMode = fixture.supportedModes[0] === "source" ? "source" : "wysiwyg";
  try { await openFile(fixture.path, { recordNavigation: false, paneId: "main" }); }
  finally { appStore.settings.editor.defaultMode = defaultMode; }
  const openReturnedAt = performance.now();
  phase(fixtureId, "open-returned");
  const tab = await waitFor("QA fixture tab", () => {
    const current = getPaneTab("main");
    return current && normalizedPath(current.path) === normalizedPath(fixture.path) ? current : null;
  });
  const documentMode = getPaneDocumentMode("main");
  const editorMode = getPaneEditorMode("main");
  const sessionMode: EditorMode = documentMode === "large" ? "source" : editorMode;
  const session = await sessionForPane(tab.id, sessionMode);
  await waitForEditor(sessionMode, documentMode, session);
  const readyAt = performance.now();
  const active: ActiveFixture = {
    fixture,
    tabId: tab.id,
    documentMode,
    editorMode: sessionMode,
    session,
    baselineRevision: session.revision,
  };
  if (documentMode === "large") {
    const state = tab.largeFile;
    if (!state) throw new Error("Large QA fixture state disappeared after open.");
    active.largeBaseline = {
      revision: state.revision,
      savedRevision: state.savedRevision,
      sizeBytes: state.sizeBytes,
      totalLines: state.totalLines,
    };
  } else {
    const baseline = await session.snapshot("externalDiff");
    phase(fixtureId, "open-baseline-snapshot-done");
    active.baselineText = baseline.markdown;
    active.baselineRevision = baseline.revision;
    active.baselineRoot = session.captureHistoryRoot?.();
  }
  return {
    active,
    result: {
      fixtureId,
      relativePath: fixture.relativePath,
      documentMode,
      editorMode: sessionMode,
      tabId: tab.id,
      sessionRevision: session.revision,
      timings: { startedAt, openReturnedAt, readyAt },
      readySignal: "owned editor session plus editable root",
    },
  };
}

async function setFixtureMode(active: ActiveFixture, mode: BridgeMode) {
  assertMode(mode);
  if (active.documentMode === "large") {
    if (mode !== "source") throw new Error("Large QA fixtures expose the bounded source editor mode.");
    return { fixtureId: active.fixture.id, mode: "source", documentMode: "large", changed: false };
  }
  if (!active.fixture.supportedModes.includes(mode)) throw new Error(`Fixture ${active.fixture.id} does not support ${mode}.`);
  if (active.editorMode === mode) {
    await waitForEditor(mode, "normal", active.session);
    return { fixtureId: active.fixture.id, mode, documentMode: "normal", changed: false };
  }
  const previousSession = active.session;
  const startedAt = performance.now();
  await switchMode(mode, "main");
  const tab = await waitFor("QA mode tab", () => getPaneTab("main"));
  const session = await sessionForPane(tab.id, mode, previousSession);
  await waitForEditor(mode, "normal", session);
  const readyAt = performance.now();
  active.tabId = tab.id;
  active.editorMode = mode;
  active.session = session;
  active.baselineRoot = session.captureHistoryRoot?.();
  return {
    fixtureId: active.fixture.id,
    mode,
    documentMode: "normal",
    changed: true,
    timings: { startedAt, readyAt },
    readySignal: "owned editor session plus editable root",
  };
}

async function resetFixture(active: ActiveFixture) {
  phase(active.fixture.id, "reset-start");
  active.pending?.cleanup();
  active.pending = undefined;
  if (active.documentMode === "large") {
    const tab = getPaneTab("main");
    const state = tab?.largeFile;
    if (!state) throw new Error("Large QA fixture state is unavailable during reset.");
    if (active.session.hasPendingEdits?.() || state.pendingEditCount > 0) {
      throw new Error("Large QA fixture still has pending edits; reset refused.");
    }
    if (state.revision !== state.savedRevision || tab?.isDirty) {
      // A large editor has no independent full-text restore API here. Saving
      // this dirty view would write the edited view to disk and mislabel it a
      // reset. The owned launcher must close/reopen its fixture instead.
      throw new Error("Large QA reset refuses dirty state; close and reopen the owned fixture to restore its disk baseline.");
    }
    return {
      fixtureId: active.fixture.id,
      documentMode: "large",
      diskTouched: false,
      method: "owned-large-view-reset-only",
      baselineHash: active.fixture.sha256,
    };
  }
  if (active.baselineText == null) throw new Error("Normal QA fixture baseline is unavailable.");
  await active.session.replaceMarkdown(active.baselineText);
  phase(active.fixture.id, "reset-replace-done");
  setPaneContent("main", active.baselineText, false, false);
  active.session = await sessionForPane(active.tabId, active.editorMode);
  return {
    fixtureId: active.fixture.id,
    documentMode: "normal",
    diskTouched: false,
    method: "owned-session-replaceMarkdown",
    baselineHash: active.fixture.sha256,
  };
}

function createInputPending(active: ActiveFixture, operation: BridgeOperation, locationName: LocationName) {
  if (active.pending) throw new Error("A QA operation is already pending for the active fixture.");
  const root = editorElement(active.editorMode, active.documentMode);
  if (!root) throw new Error("QA editor input root is unavailable.");
  const startedAt = performance.now();
  const pending: PendingOperation = {
    fixtureId: active.fixture.id,
    operation,
    location: locationName,
    sampleId: `perf-${active.fixture.id}-${operation}-${locationName}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt,
    beforeRevision: active.session.revision,
    beforeDirty: Boolean(getPaneTab("main")?.isDirty),
    method: bridgeMethod(operation),
    timingMetric: "dispatch-to-raf-opportunity",
    root,
    dispatchAt: null,
    modelAcceptedAt: null,
    domUpdatedAt: null,
    rafOpportunityAt: null,
    presentationObservedAt: null,
    cleanup: () => {},
  };
  const markDispatch = () => {
    if (pending.dispatchAt == null) pending.dispatchAt = performance.now();
  };
  const beforeInput = (event: Event) => {
    if ((event as InputEvent).isComposing) return;
    markDispatch();
  };
  const input = () => markDispatch();
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (operation === "insert-newline" && event.key === "Enter" || operation === "delete-backward" && event.key === "Backspace" || operation === "formula-commit" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) markDispatch();
  };
  const keydownCompleted = (event: KeyboardEvent) => {
    if (operation === "formula-commit") pending.formulaKey = { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, keyCode: event.keyCode, isComposing: event.isComposing, defaultPrevented: event.defaultPrevented, targetIsControl: event.target === pending.formula?.control, targetClass: event.target instanceof HTMLElement ? event.target.className : null, activeClass: document.activeElement?.className ?? null, controlConnected: pending.formula?.control.isConnected ?? false };
    if (!event.isComposing && pending.dispatchAt != null && (operation === "insert-newline" && event.key === "Enter" || operation === "delete-backward" && event.key === "Backspace" || operation === "formula-commit" && event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
      pending.keyHandlerObservableMs = performance.now() - pending.dispatchAt;
    }
  };
  let restoreModelProbe: (() => void) | undefined;
  if (active.editorMode === "wysiwyg" && operation !== "multi-range-edit" && operation !== "scroll") {
    const editor = (active.session as DocumentSessionAdapter & { editorIdentity?: import("@tiptap/core").Editor }).editorIdentity;
    if (editor) {
      const state = editor.state, original = state.applyTransaction;
      const view = editor.view, originalUpdateState = view.updateState;
      const updateDescriptor = Object.getOwnPropertyDescriptor(view, "updateState");
      const descriptor = Object.getOwnPropertyDescriptor(state, "applyTransaction");
      Object.defineProperty(state, "applyTransaction", { configurable: true, value: function(this: typeof state, transaction: Parameters<typeof original>[0]) {
        const started = performance.now();
        try { return original.call(this, transaction); }
        finally { pending.modelComputeMs = (pending.modelComputeMs ?? 0) + performance.now() - started; }
      } });
      Object.defineProperty(view, "updateState", { configurable: true, value: function(this: typeof view, next: Parameters<typeof originalUpdateState>[0]) {
        const started = performance.now();
        try { return originalUpdateState.call(this, next); }
        finally { pending.viewUpdateObservableMs = (pending.viewUpdateObservableMs ?? 0) + performance.now() - started; }
      } });
      restoreModelProbe = () => {
        if (descriptor) Object.defineProperty(state, "applyTransaction", descriptor); else delete (state as Partial<typeof state>).applyTransaction;
        if (updateDescriptor) Object.defineProperty(view, "updateState", updateDescriptor); else delete (view as Partial<typeof view>).updateState;
      };
    }
  }
  const scheduleOpportunity = () => {
    if (pending.dispatchAt == null || pending.modelAcceptedAt == null || pending.domUpdatedAt == null || pending.rafScheduled) return;
    pending.rafScheduled = true;
    requestAnimationFrame(() => { pending.rafOpportunityAt = performance.now(); });
  };
  const observer = new MutationObserver(() => {
    // Setup mutations from navigation/focus happen before dispatch and are
    // not evidence that this operation updated the editor DOM.
    if (pending.dispatchAt != null && pending.domUpdatedAt == null) pending.domUpdatedAt = performance.now();
    scheduleOpportunity();
  });
  root.addEventListener("beforeinput", beforeInput, true);
  root.addEventListener("input", input, true);
  root.addEventListener("keydown", keydown, true);
  root.addEventListener("keydown", keydownCompleted);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  const unsubscribe = subscribeDocumentRuntime((tabId, state) => {
    if (tabId === active.tabId && (state?.revision ?? -1) > pending.beforeRevision && pending.dispatchAt != null) {
      pending.modelAcceptedAt ??= performance.now();
      scheduleOpportunity();
    }
  });
  let longTaskObserver: PerformanceObserver | null = null;
  pending.longTaskObservation = "unsupported";
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    pending.longTasks = [];
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (pending.dispatchAt != null && entry.startTime + entry.duration >= pending.dispatchAt) {
          pending.longTasks!.push({ startTime: entry.startTime, duration: entry.duration });
        }
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
    pending.longTaskObservation = "PerformanceObserver longtask entries overlapping operation";
  }
  pending.cleanup = () => {
    unsubscribe();
    if (longTaskObserver) {
      for (const entry of longTaskObserver.takeRecords()) {
        if (pending.dispatchAt != null && entry.startTime + entry.duration >= pending.dispatchAt) pending.longTasks!.push({ startTime: entry.startTime, duration: entry.duration });
      }
      longTaskObserver.disconnect();
    }
    root.removeEventListener("beforeinput", beforeInput, true);
    root.removeEventListener("input", input, true);
    root.removeEventListener("keydown", keydown, true);
    root.removeEventListener("keydown", keydownCompleted);
    restoreModelProbe?.();
    observer.disconnect();
  };
  return pending;
}

async function completeInput(active: ActiveFixture, pending: PendingOperation) {
  const deadline = performance.now() + DEFAULT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (pending.dispatchAt != null && pending.modelAcceptedAt != null && pending.domUpdatedAt != null && pending.rafOpportunityAt != null) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  pending.cleanup();
  const status = pending.dispatchAt != null && pending.modelAcceptedAt != null && pending.domUpdatedAt != null && pending.rafOpportunityAt != null
    ? "ok"
    : "failed";
  const editor = (active.session as DocumentSessionAdapter & { editorIdentity?: import("@tiptap/core").Editor }).editorIdentity;
  const formulaFeedback = pending.formula ? {
    modelTexCompared: editor?.state.doc.nodeAt(pending.formula.position)?.attrs.tex === pending.formula.expectedTex,
    editingClosed: !pending.formula.dom.querySelector(".math-block-editor"),
    rendered: Boolean(pending.formula.dom.querySelector(".katex")),
    expectedTex: pending.formula.expectedTex,
    modelTex: editor?.state.doc.nodeAt(pending.formula.position)?.attrs.tex,
    suggestOpenAtSetup: pending.formula.suggestOpen,
  } : undefined;
  const feedbackVerified = !formulaFeedback || formulaFeedback.modelTexCompared && formulaFeedback.editingClosed && formulaFeedback.rendered;
  const formulaRecovery = pending.formula && !feedbackVerified
    ? (await import("./extensions/MathNodes")).capturePendingMathRecovery(editor!)
    : undefined;
  let workCounters: Record<string, unknown> | null = null;
  if (active.editorMode === "wysiwyg") {
    const editor = (active.session as DocumentSessionAdapter & { editorIdentity?: import("@tiptap/core").Editor }).editorIdentity;
    if (editor) {
      const { getWysiwygDerivedState } = await import("./editor/wysiwygDerived");
      const derived = getWysiwygDerivedState(editor.state);
      workCounters = { kind: "WYS derived index actual counters", topLevelBlocks: editor.state.doc.childCount, recomputedBlocks: derived.recomputedBlocks, indexVisits: derived.indexVisits, blockVisits: derived.blockVisits, materializedBlocks: derived.materializedBlocks, materializedHeadings: derived.materializedHeadings };
    }
  } else {
    const { EditorView } = await import("@codemirror/view");
    const element = pending.root?.closest<HTMLElement>(".cm-editor");
    const view = element && EditorView.findFromDOM(element);
    if (view) {
      const { sourceOutlineChangeDiagnostics } = await import("./editor/sourceOutlineChanges");
      const outline = sourceOutlineChangeDiagnostics(view.state.doc);
      workCounters = { kind: "Source model dimensions and actual outline scanner reads", lines: view.state.doc.lines, utf16Length: view.state.doc.length, outlineLineReads: outline?.lineReads ?? null, outlineChangedRanges: outline?.changedRanges ?? null, observation: "actual outline line() accesses, not Lezer visits or total model size" };
    }
  }
  return {
    kind: "interactive",
    fixtureId: pending.fixtureId,
    operation: pending.operation,
    location: pending.location,
    sampleId: pending.sampleId,
    status: feedbackVerified ? status : "failed",
    formulaFeedback,
    formulaKey: pending.formulaKey,
    formulaRecovery,
    feedbackVerified,
    failureReason: !feedbackVerified ? "formula model, closed editor or rendered KaTeX did not match the committed textarea" : status === "ok"
      ? undefined
      : "input dispatch, model acceptance, DOM update or rAF opportunity was not observed",
    modelAcceptanceObservation: "documentRuntime synchronous revision publication callback",
    synchronousCommandMs: pending.synchronousCommandMs,
    modelComputeMs: pending.modelComputeMs,
    dispatchObservableMs: pending.dispatchObservableMs,
    keyHandlerObservableMs: pending.keyHandlerObservableMs,
    viewUpdateObservableMs: pending.viewUpdateObservableMs,
    remainingKeyHandlerObservableMs: pending.keyHandlerObservableMs != null && pending.modelComputeMs != null && pending.viewUpdateObservableMs != null
      ? Math.max(0, pending.keyHandlerObservableMs - pending.modelComputeMs - pending.viewUpdateObservableMs) : undefined,
    workCounters,
    longTasks: pending.longTasks?.filter(entry => pending.rafOpportunityAt == null || entry.startTime <= pending.rafOpportunityAt),
    longTaskObservation: pending.longTaskObservation,
    domUpdateObservation: "MutationObserver callback after dispatch; attribution is bounded to the active editor root",
    method: pending.method,
    timingMetric: pending.timingMetric,
    measurementStage: "input-to-raf-opportunity",
    timings: {
      startedAt: pending.startedAt,
      dispatchAt: pending.dispatchAt,
      modelAcceptedAt: pending.modelAcceptedAt,
      domUpdatedAt: pending.domUpdatedAt,
      rafOpportunityAt: pending.rafOpportunityAt,
      presentationObservedAt: pending.presentationObservedAt,
    },
    durationMs: pending.dispatchAt != null && pending.rafOpportunityAt != null
      ? Math.max(0, pending.rafOpportunityAt - pending.dispatchAt)
      : undefined,
    presentation: "not-observed; rAF is only an opportunity boundary",
  };
}

async function dispatchMultipleRanges(active: ActiveFixture, pending: PendingOperation) {
  if (active.documentMode !== "normal") throw new Error("Multi-range QA is restricted to normal owned fixtures.");
  if (active.editorMode === "source") {
    const { EditorView } = await import("@codemirror/view");
    const element = pending.root?.closest<HTMLElement>(".cm-editor");
    const view = element && EditorView.findFromDOM(element);
    if (!view) throw new Error("Owned Source view is unavailable.");
    const end = active.fixture.payload?.utf16End ?? view.state.doc.length;
    const startOffset = active.fixture.payload?.utf16Start ?? 0;
    const changes = [{ from: startOffset + 1, insert: "Q" }, { from: end - 2, insert: "R" }];
    const start = performance.now();
    pending.dispatchAt = start;
    const transaction = view.state.update({ changes, userEvent: "input.qa-multiple-ranges" });
    void transaction.state;
    const model = performance.now();
    view.dispatch(transaction);
    const dispatched = performance.now();
    pending.modelComputeMs = model - start;
    pending.dispatchObservableMs = dispatched - model;
    pending.synchronousCommandMs = dispatched - start;
    return;
  }
  const editor = (active.session as DocumentSessionAdapter & { editorIdentity?: import("@tiptap/core").Editor }).editorIdentity;
  if (!editor || !pending.root?.contains(editor.view.dom)) throw new Error("Owned WYS view is unavailable.");
  const state = editor.state;
  const positions: number[] = [];
  state.doc.descendants((node, position) => { if (node.isText && node.nodeSize > 1) positions.push(position + 1); });
  if (positions.length < 2) throw new Error("Multi-range fixture requires two text ranges.");
  const originalDescriptor = Object.getOwnPropertyDescriptor(state, "applyTransaction");
  const apply = state.applyTransaction;
  let modelMs = 0;
  Object.defineProperty(state, "applyTransaction", { configurable: true, value: function(this: typeof state, transaction: Parameters<typeof apply>[0]) {
    const started = performance.now();
    try { return apply.call(this, transaction); } finally { modelMs += performance.now() - started; }
  } });
  const start = performance.now();
  pending.dispatchAt = start;
  try {
    const transaction = state.tr.insertText("R", positions.at(-1)!).insertText("Q", positions[0]);
    editor.view.dispatch(transaction);
    pending.synchronousCommandMs = performance.now() - start;
    pending.modelComputeMs = modelMs;
    pending.dispatchObservableMs = pending.synchronousCommandMs - modelMs;
  } finally {
    if (originalDescriptor) Object.defineProperty(state, "applyTransaction", originalDescriptor);
    else delete (state as Partial<typeof state>).applyTransaction;
  }
}

async function completeScroll(active: ActiveFixture, pending: PendingOperation) {
  const scroller = scrollElement(active.documentMode);
  if (!scroller) throw new Error("QA scroll root is unavailable.");
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const target = pending.location === "head" ? 0 : pending.location === "tail" ? maxScrollTop : Math.floor(maxScrollTop / 2);
  let dispatchAt: number | null = null;
  const onScroll = () => { dispatchAt ??= performance.now(); pending.dispatchAt ??= dispatchAt; };
  scroller.addEventListener("scroll", onScroll, { once: false, passive: true });
  const startedAt = pending.startedAt;
  scroller.scrollTop = target;
  const reachedAt = await waitFor("QA scroll position", () => {
    if (Math.abs(scroller.scrollTop - target) > 2) return null;
    return performance.now();
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const rafOpportunityAt = performance.now();
  scroller.removeEventListener("scroll", onScroll);
  pending.cleanup();
  return {
    kind: "interactive",
    fixtureId: pending.fixtureId,
    operation: "scroll",
    location: pending.location,
    sampleId: pending.sampleId,
    status: dispatchAt != null ? "ok" : "failed",
    failureReason: dispatchAt == null ? "scroll event was not observed" : undefined,
    method: "owned-editor.scrollTop",
    timingMetric: "scroll-event-to-raf-opportunity",
    measurementStage: "scroll-to-raf-opportunity",
    longTasks: pending.longTasks?.filter(entry => entry.startTime <= rafOpportunityAt),
    longTaskObservation: pending.longTaskObservation,
    timings: {
      startedAt,
      dispatchAt,
      modelAcceptedAt: null,
      domUpdatedAt: null,
      scrollPositionObservedAt: reachedAt,
      rafOpportunityAt,
      presentationObservedAt: null,
    },
    durationMs: dispatchAt != null ? Math.max(0, rafOpportunityAt - dispatchAt) : undefined,
    targetScrollTop: target,
    presentation: "not-observed; rAF is only an opportunity boundary",
  };
}

async function digestText(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readRuntimePaths() {
  const [config, data, local] = await Promise.all([
    appConfigDir(),
    appDataDir(),
    appLocalDataDir(),
  ]);
  return { config, data, local };
}

async function verifyFixture(active: ActiveFixture) {
  phase(active.fixture.id, "verify-start");
  const tab = getPaneTab("main");
  if (!tab) throw new Error("QA fixture tab is unavailable during verification.");
  const outlineCount = getPaneStructuredOutline("main").length;
  if (active.documentMode === "large") {
    const state = tab.largeFile as LargeFileState | null;
    if (!state) throw new Error("Large QA fixture state is unavailable during verification.");
    const identity = { sessionId: state.sessionId, revision: state.revision, coordinateSpace: state.coordinateSpace };
    const captured = JSON.parse(await active.session.captureRecoveryBundle!()) as {
      windowRange: { startLine: number; startColumn: number };
      baseText: string; text: string;
      logicalAnchor: { line: number; column: number }; logicalHead: { line: number; column: number };
    };
    const range = await readLargeSourceRange(identity, { start: { line: captured.windowRange.startLine, column: captured.windowRange.startColumn } });
    const anchor = await resolveLargeSourcePosition(identity, captured.logicalAnchor, "clamp");
    const head = await resolveLargeSourcePosition(identity, captured.logicalHead, "clamp");
    const prefix = await readLargeSourceRange(identity, { start: { line: 0, column: 0 }, maxBytes: 4096 });
    const suffix = await readLargeSourceRange(identity, { start: { line: Math.max(0, state.totalLines - 8), column: 0 }, maxBytes: 4096 });
    const sentinels = `${prefix.text}\n${suffix.text}`.match(/LM_PERF_SENTINEL_(?:BEFORE|AFTER)_[A-Z0-9_]+_KEEP/gu) || [];
    const normalized = (value: string) => value.replace(/\r\n?|\n/gu, "\n");
    const syntaxCompared = range.text === captured.baseText && normalized(range.text) === captured.text;
    return {
      fixtureId: active.fixture.id,
      documentMode: "large",
      expectedSha256: active.fixture.sha256,
      currentRevision: state.revision,
      savedRevision: state.savedRevision,
      pendingEditCount: state.pendingEditCount,
      dirty: tab.isDirty,
      outlineCount,
      bytesCompared: null,
      syntaxCompared,
      selectionCompared: anchor.line === captured.logicalAnchor.line && anchor.column === captured.logicalAnchor.column && head.line === captured.logicalHead.line && head.column === captured.logicalHead.column,
      historyCompared: state.revision === active.largeBaseline?.revision && state.savedRevision === active.largeBaseline?.savedRevision && !active.session.hasPendingEdits?.(),
      sentinelCompared: sentinels.length === 2,
      focusObserved: document.activeElement?.closest?.("[data-large-source-editor]") != null,
      note: "bounded backend range equals captured source window; scalar-safe logical bookmarks clamp identically; head/tail sentinels checked with 4KiB reads; scroll-only history verifies no revision or pending change; launcher separately compares full disk hash",
    };
  }
  phase(active.fixture.id, "verify-snapshot-start");
  const snapshot = await active.session.snapshot("externalDiff");
  phase(active.fixture.id, "verify-snapshot-done", active.session.derivedState().snapshotDiagnostics);
  const currentSha256 = await digestText(snapshot.markdown);
  const sentinelValues = (value: string) => value.match(/LM_PERF_SENTINEL_(?:BEFORE|AFTER)_[A-Z0-9_]+_KEEP/gu) || [];
  const baselineSentinels = sentinelValues(active.baselineText || "");
  const currentSentinels = sentinelValues(snapshot.markdown);
  const bookmark = active.session.captureHistoryBookmark?.();
  const root = active.session.captureHistoryRoot?.();
  const syntaxCompared = Boolean(root && active.baselineRoot && (root.mode === "source" && active.baselineRoot.mode === "source"
    ? root.doc.eq(active.baselineRoot.doc)
    : root.mode === "wysiwyg" && active.baselineRoot.mode === "wysiwyg" && root.doc.eq(active.baselineRoot.doc)));
  const selectionCompared = Boolean(bookmark && root && Number.isInteger(bookmark.anchor) && Number.isInteger(bookmark.head)
    && Math.min(bookmark.anchor, bookmark.head) >= (root.mode === "source" ? 0 : 1)
    && Math.max(bookmark.anchor, bookmark.head) <= (root.mode === "source" ? root.doc.length : root.doc.content.size));
  const history = documentHistoryForTab(active.tabId);
  phase(active.fixture.id, "verify-root-selection-compare-done");
  let historyCompared = false;
  if (history.canUndo) {
    phase(active.fixture.id, "verify-undo-start");
    const undone = await moveDocumentHistory(active.tabId, -1);
    phase(active.fixture.id, "verify-undo-done");
    const redone = undone && await moveDocumentHistory(active.tabId, 1);
    phase(active.fixture.id, "verify-redo-done");
    const restored = await active.session.snapshot("externalDiff");
    phase(active.fixture.id, "verify-restored-snapshot-done");
    const restoredBookmark = active.session.captureHistoryBookmark?.();
    historyCompared = redone && restored.markdown === snapshot.markdown
      && restoredBookmark?.anchor === bookmark?.anchor && restoredBookmark?.head === bookmark?.head;
  } else {
    historyCompared = snapshot.markdown === active.baselineText && !(await moveDocumentHistory(active.tabId, -1));
  }
  return {
    fixtureId: active.fixture.id,
    documentMode: "normal",
    expectedSha256: active.fixture.sha256,
    currentSha256,
    bytesCompared: currentSha256 === active.fixture.sha256,
    syntaxCompared,
    selectionCompared,
    focusObserved: Boolean(
      editorElement(active.editorMode, "normal")?.contains(document.activeElement),
    ),
    historyCompared,
    sentinelCompared: baselineSentinels.length > 0
      && baselineSentinels.length === currentSentinels.length
      && baselineSentinels.every((value, index) => value === currentSentinels[index]),
    dirty: tab.isDirty,
    revision: snapshot.revision,
    outlineCount,
    snapshotDiagnostics: active.session.derivedState().snapshotDiagnostics,
    note: "syntax compares immutable editor roots to baseline; selection checks native bookmark bounds; nonempty history performs actual undo/redo and compares exact source/bookmark, empty history verifies undo refusal; correctness runs outside timing intervals",
  };
}

function phase(fixtureId: string, stage: string, diagnostics?: unknown) {
  console.debug("__LIGHTMARK_PERF_PHASE__", JSON.stringify({ fixtureId, stage, at: performance.now(), diagnostics }));
}

function createBridge(config: PerformanceBridgeConfig): PerformanceQaBridge {
  let active: ActiveFixture | null = null;
  let sequence = 0;
  const requireActive = (fixtureId: string) => {
    assertFixtureId(config, fixtureId);
    if (!active || active.fixture.id !== fixtureId) throw new Error(`QA fixture is not active: ${fixtureId}`);
    if (appStore.splitLayout.activePaneId !== "main") {
      throw new Error("QA bridge requires the owned fixture to remain in the main active pane.");
    }
    const tab = getPaneTab("main");
    if (!tab
      || tab.id !== active.tabId
      || normalizedPath(tab.path) !== normalizedPath(active.fixture.path)
      || tab.documentMode !== active.documentMode) {
      throw new Error("QA bridge active tab/path/document mode no longer matches the captured fixture.");
    }
    const session = documentSessionForPane("main");
    if (session !== active.session
      || session.tabId !== active.tabId
      || session.mode !== active.editorMode) {
      throw new Error("QA bridge active editor session no longer matches the captured fixture.");
    }
    return active;
  };
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    bridgeEnabled: true,
    async ready() {
      assertOrigin(config);
      const runtimePaths = await readRuntimePaths();
      // A process is not "ready" merely because the bridge object exists.
      // Open one fixed owned fixture through the public app/session APIs and
      // wait for its settled editable root before returning the signal.
      const opened = await openFixture(config, "normal-writing");
      active = opened.active;
      return {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        bridgeEnabled: true,
        nonce: config.nonce,
        expectedOrigin: config.expectedOrigin,
        actualOrigin: location.origin,
        profileToken: config.profileToken,
        processToken: config.processToken,
        probeMode: config.probeMode,
        fixtureIds: [...FIXTURE_IDS],
        operationContract: [...OPERATIONS],
        editorReady: true,
        editorReadyAt: performance.now(),
        editorReadySignal: opened.result.readySignal,
        editor: opened.result,
        runtimePaths,
        presentationBoundary: "not-observed",
      };
    },
    async supports(fixtureId, operation) {
      assertOrigin(config);
      const current = requireActive(fixtureId);
      assertOperation(operation);
      return { fixtureId, operation, ...supportsOperation(current, operation) };
    },
    async open(fixtureId) {
      assertOrigin(config);
      const result = await openFixture(config, fixtureId);
      active = result.active;
      return result.result;
    },
    async mode(fixtureId, mode) {
      assertOrigin(config);
      const current = requireActive(fixtureId);
      return await setFixtureMode(current, mode);
    },
    async reset(fixtureId) {
      assertOrigin(config);
      const current = requireActive(fixtureId);
      return await resetFixture(current);
    },
    async prepareOperation(fixtureId, operation, locationName) {
      assertOrigin(config);
      const current = requireActive(fixtureId);
      assertOperation(operation);
      assertLocation(locationName);
      const support = supportsOperation(current, operation);
      if (!support.supported) return { fixtureId, operation, location: locationName, ...support };
      if (operation !== "formula-commit") await focusAt(current, locationName);
      if (operation === "delete-backward" && locationName === "head") current.session.navigate({ offset: (current.fixture.payload?.utf16Start ?? 0) + 1 });
      const formula = operation === "formula-commit" ? prepareFormulaCommit(current) : undefined;
      const pending = createInputPending(current, operation, locationName);
      pending.formula = formula;
      pending.sampleId = `perf-${++sequence}-${pending.sampleId}`;
      current.pending = pending;
      return {
        fixtureId,
        operation,
        location: locationName,
        supported: true,
        sampleId: pending.sampleId,
        startedAt: pending.startedAt,
        beforeRevision: pending.beforeRevision,
        method: pending.method,
        timingMetric: pending.timingMetric,
        inputText: operation === "insert-text" ? INSERT_TEXT : operation === "paste-text" ? PASTE_TEXT : undefined,
        inputKey: operation === "formula-commit" ? "Ctrl+Enter" : operation === "delete-backward" ? "Backspace" : undefined,
        note: operation === "formula-commit" ? "mounted NodeView mousedown and textarea input setup excluded; real CDP Ctrl+Enter commit measured" : undefined,
      };
    },
    async completeOperation(fixtureId, operation, locationName) {
      assertOrigin(config);
      const current = requireActive(fixtureId);
      assertOperation(operation);
      assertLocation(locationName);
      const pending = current.pending;
      if (!pending || pending.fixtureId !== fixtureId || pending.operation !== operation || pending.location !== locationName) {
        throw new Error("QA operation completion does not match the prepared operation.");
      }
      current.pending = undefined;
      try {
        if (operation === "multi-range-edit") await dispatchMultipleRanges(current, pending);
        return operation === "scroll" ? await completeScroll(current, pending) : await completeInput(current, pending);
      } finally { pending.cleanup(); }
    },
    async verify(fixtureId) {
      assertOrigin(config);
      return await verifyFixture(requireActive(fixtureId));
    },
    async memory(fixtureId) {
      assertOrigin(config);
      requireActive(fixtureId);
      const browserMemory = (performance as Performance & { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
      return {
        fixtureId,
        jsHeap: browserMemory
          ? {
              usedBytes: browserMemory.usedJSHeapSize ?? null,
              totalBytes: browserMemory.totalJSHeapSize ?? null,
              limitBytes: browserMemory.jsHeapSizeLimit ?? null,
            }
          : null,
        processMemory: "launcher-required; browser bridge cannot observe the full WebView2 process tree",
      };
    },
    async shutdown() {
      assertOrigin(config);
      if (active) requireActive(active.fixture.id);
      active?.pending?.cleanup();
      active = null;
      window.setTimeout(() => { void getCurrentWindow().close(); }, 0);
      return { scheduled: true, processToken: config.processToken, method: "owned-current-window-close" };
    },
  };
}

export function installPerformanceQaBridge() {
  if (window.__LIGHTMARK_PERF_BRIDGE__) throw new Error("QA performance bridge is already installed.");
  const config = parseConfig();
  assertOrigin(config);
  validateCatalogPaths(config);
  const bridge = createBridge(config);
  window.__LIGHTMARK_PERF_BRIDGE__ = bridge;
  return bridge;
}
