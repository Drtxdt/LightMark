import type { EditorMode, EditorPaneId } from "../types";
import type { StructuredOutlineItem } from "../utils/outline";
import type { WysiwygSnapshotDiagnostics } from "./wysiwygSnapshot";

export type SnapshotReason =
  | "save"
  | "saveAs"
  | "export"
  | "draft"
  | "modeSwitch"
  | "tabSwitch"
  | "externalDiff"
  | "indexIdle";

export interface MarkdownSnapshot {
  tabId: string;
  revision: number;
  markdown: string;
  dirty: boolean;
}

export interface DocumentDerivedState {
  revision?: number;
  words?: number;
  chars?: number;
  lines?: number;
  outline?: StructuredOutlineItem[];
  findMatches?: number;
  snapshotDiagnostics?: WysiwygSnapshotDiagnostics;
}

export type DocumentDerivedPatch = Partial<DocumentDerivedState> & { revision: number };

export interface SnapshotOptions {
  signal?: AbortSignal;
}

export interface EditorNavigationTarget {
  offset?: number;
  line?: number;
  position?: number;
}

export interface DocumentSessionAdapter {
  readonly tabId: string;
  readonly paneId: EditorPaneId;
  readonly mode: EditorMode;
  readonly revision: number;
  snapshot(reason: SnapshotReason, options?: SnapshotOptions): Promise<MarkdownSnapshot>;
  derivedState(): DocumentDerivedState;
  replaceMarkdown(markdown: string): Promise<void>;
  navigate(target: EditorNavigationTarget): void;
}

const sessionsByTab = new Map<string, DocumentSessionAdapter>();
const sessionsByPane = new Map<EditorPaneId, DocumentSessionAdapter>();
const currentTabIds = new WeakMap<DocumentSessionAdapter, string>();
const runtimeListeners = new Set<(tabId: string, state: DocumentDerivedState | null) => void>();
const sessionListeners = new Set<() => void>();
const derivedByTab = new Map<string, DocumentDerivedState>();

export function registerDocumentSession(adapter: DocumentSessionAdapter) {
  sessionsByTab.set(adapter.tabId, adapter);
  sessionsByPane.set(adapter.paneId, adapter);
  currentTabIds.set(adapter, adapter.tabId);
  emitSessionChange();
  return () => {
    const currentTabId = currentTabIds.get(adapter) ?? adapter.tabId;
    if (sessionsByTab.get(currentTabId) === adapter) sessionsByTab.delete(currentTabId);
    if (sessionsByPane.get(adapter.paneId) === adapter) sessionsByPane.delete(adapter.paneId);
    currentTabIds.delete(adapter);
    emitSessionChange();
  };
}

export function documentSessionForTab(tabId: string) {
  return sessionsByTab.get(tabId) ?? null;
}

export function documentSessionForPane(paneId: EditorPaneId) {
  return sessionsByPane.get(paneId) ?? null;
}

export function waitForDocumentSession(tabId: string, mode?: EditorMode, timeoutMs = 5000) {
  const matches = () => {
    const session = documentSessionForTab(tabId);
    return session && (!mode || session.mode === mode) ? session : null;
  };
  const current = matches();
  if (current) return Promise.resolve(current);
  return new Promise<DocumentSessionAdapter>((resolve, reject) => {
    const finish = () => {
      const session = matches();
      if (!session) return;
      window.clearTimeout(timer);
      sessionListeners.delete(finish);
      resolve(session);
    };
    const timer = window.setTimeout(() => {
      sessionListeners.delete(finish);
      reject(new Error("编辑器会话初始化超时。"));
    }, timeoutMs);
    sessionListeners.add(finish);
  });
}

export function rebindDocumentSession(previousTabId: string, nextTabId: string) {
  if (!previousTabId || previousTabId === nextTabId) return;
  const session = sessionsByTab.get(previousTabId);
  if (session) {
    sessionsByTab.delete(previousTabId);
    sessionsByTab.set(nextTabId, session);
    currentTabIds.set(session, nextTabId);
    emitSessionChange();
  }
  const derived = derivedByTab.get(previousTabId);
  if (derived) {
    derivedByTab.delete(previousTabId);
    derivedByTab.set(nextTabId, derived);
    emitRuntimeState(previousTabId, null);
    emitRuntimeState(nextTabId, derived);
  }
}

export function publishDocumentDerivedState(tabId: string, state: DocumentDerivedState) {
  const next = { ...state };
  derivedByTab.set(tabId, next);
  emitRuntimeState(tabId, next);
}

export function publishDocumentDerivedPatch(tabId: string, patch: DocumentDerivedPatch) {
  const next = { ...(derivedByTab.get(tabId) ?? {}), ...patch };
  derivedByTab.set(tabId, next);
  emitRuntimeState(tabId, next);
}

export function clearDocumentRuntimeState(tabId: string) {
  derivedByTab.delete(tabId);
  emitRuntimeState(tabId, null);
}

export function subscribeDocumentRuntime(listener: (tabId: string, state: DocumentDerivedState | null) => void) {
  runtimeListeners.add(listener);
  return () => runtimeListeners.delete(listener);
}

function emitRuntimeState(tabId: string, state: DocumentDerivedState | null) {
  for (const listener of runtimeListeners) listener(tabId, state);
}

function emitSessionChange() {
  for (const listener of sessionListeners) listener();
}

export async function snapshotDocumentTab(tabId: string, reason: SnapshotReason, options: SnapshotOptions = {}) {
  const session = documentSessionForTab(tabId);
  if (!session) return null;
  if (options.signal?.aborted) throw new DOMException("文档快照已取消。", "AbortError");
  const expectedRevision = session.revision;
  const snapshot = await session.snapshot(reason, options);
  if (options.signal?.aborted) throw new DOMException("文档快照已取消。", "AbortError");
  const registeredTabId = currentTabIds.get(session) ?? session.tabId;
  if (registeredTabId !== tabId) throw new Error("编辑器返回了错误文档的快照。");
  if (snapshot.revision !== expectedRevision || snapshot.revision !== session.revision) throw new Error("文档在生成快照时发生了变化，请重试。");
  return snapshot.tabId === tabId ? snapshot : { ...snapshot, tabId };
}

export async function snapshotDocumentPane(paneId: EditorPaneId, reason: SnapshotReason) {
  const session = documentSessionForPane(paneId);
  return session ? snapshotDocumentTab(session.tabId, reason) : null;
}

if (
  typeof import.meta.env !== "undefined"
  && import.meta.env.VITE_LIGHTMARK_PERF_QA === "1"
  && typeof window !== "undefined"
) {
  const qaWindow = window as typeof window & {
    __LIGHTMARK_PERFORMANCE_QA__?: {
      session(paneId?: EditorPaneId): DocumentSessionAdapter | null;
      waitForMode(mode: EditorMode, paneId?: EditorPaneId, timeoutMs?: number): Promise<DocumentSessionAdapter>;
    };
  };
  qaWindow.__LIGHTMARK_PERFORMANCE_QA__ = {
    session: (paneId = "main") => documentSessionForPane(paneId),
    async waitForMode(mode, paneId = "main", timeoutMs = 10_000) {
      const started = performance.now();
      while (performance.now() - started < timeoutMs) {
        const session = documentSessionForPane(paneId);
        if (session?.mode === mode) return session;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
      }
      throw new Error(`等待 ${mode} 编辑器会话超时。`);
    },
  };
}
