import type { EditorMode, EditorPaneId } from "../types";
import type { StructuredOutlineItem } from "../utils/outline";
import type { WysiwygSnapshotDiagnostics } from "./wysiwygSnapshot";
import { DocumentHistory, type HistoryProjection, type DocumentHistoryRoot, type HistoryBookmark } from './documentHistory';
import {
  beginPendingCommand, clearPendingCommands, detachPendingCommands, failPendingCommand,
  hydratePendingCommand, mapPendingCommands, pendingCommand, pendingCommandsForDocument,
  projectPendingCommand, type NativeCommandAnchor, type PendingCommandHandle,
  type PendingCommandKind, type CommandPositionMap,
} from './pendingDocumentCommands';
import {
  documentMutationTokensEqual,
  type DocumentFlushReceipt,
  type DocumentMutationToken,
} from "./documentMutationTracker";

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
  mutationToken?: DocumentMutationToken;
  flushReceipt?: DocumentFlushReceipt;
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

export interface PendingFlushOptions {
  expectedToken?: DocumentMutationToken;
}

export interface EditorNavigationTarget {
  offset?: number;
  line?: number;
  position?: number;
}

export interface DocumentSourcePatch {
  from: number;
  to: number;
  expected: string;
  insert: string;
}

export interface DocumentCommandTarget {
  readonly documentId: string;
  readonly epoch: number;
  readonly tabId: string;
  readonly paneId: EditorPaneId;
  readonly session: DocumentSessionAdapter;
  readonly revision: number;
  readonly pendingInputVersion: number;
  readonly mutationToken?: DocumentMutationToken;
  readonly markdown: string;
}

export interface DocumentSessionAdapter {
  readonly tabId: string;
  readonly paneId: EditorPaneId;
  readonly mode: EditorMode;
  readonly revision: number;
  isComposing?(): boolean;
  hasPendingEdits?(): boolean;
  pendingEditVersion?(): number;
  mutationToken?(): DocumentMutationToken;
  flushPendingEdits?(
    reason: SnapshotReason,
    options?: PendingFlushOptions,
  ): Promise<DocumentFlushReceipt | void>;
  finalizeClosePrompt?(
    options?: PendingFlushOptions,
  ): Promise<DocumentFlushReceipt | void>;
  captureRecoveryBundle?(): Promise<string>;
  restoreRecoveryBundle?(serialized: string): Promise<void>;
  snapshot(reason: SnapshotReason, options?: SnapshotOptions): Promise<MarkdownSnapshot>;
  derivedState(): DocumentDerivedState;
  replaceMarkdown(markdown: string): Promise<void>;
  applySourcePatch?(patch: DocumentSourcePatch, expectedRevision: number): Promise<void>;
  readonly initialCommandMarkdown?: string;
  captureAssetCommandAnchor?(patch: DocumentSourcePatch, markdown: string): NativeCommandAnchor;
  commandAnchorToSource?(anchor: NativeCommandAnchor, kind: PendingCommandKind, markdown: string): Promise<{ from: number; to: number; expected: string }>;
  commandAnchorFromSource?(anchor: { from: number; to: number; expected: string }, kind: PendingCommandKind, markdown: string): Promise<NativeCommandAnchor>;
  validateCommandAnchor?(anchor: NativeCommandAnchor): boolean;
  applyPendingCommand?(anchor: NativeCommandAnchor, payload: PendingCommandPayload, expectedRevision: number, assertCurrent: () => void): Promise<void>;
  prepareHistoryReplay?(projection: HistoryProjection, exactSource: string | undefined, dirty: boolean): Promise<() => void>;
  captureHistoryRoot?(): DocumentHistoryRoot;
  captureHistoryBookmark?(): HistoryBookmark;
  restoreSourceBookmark?(markdown: string, bookmark: HistoryBookmark): Promise<void>;
  navigate(target: EditorNavigationTarget): void;
}

export type PendingCommandPayload = { kind: 'asset'; insert: string } | { kind: 'image'; markdown: string };

export interface DocumentSessionFlushResult {
  session: DocumentSessionAdapter;
  beforeRevision: number;
  afterRevision: number;
  beforeToken: DocumentMutationToken | null;
  afterToken: DocumentMutationToken | null;
  receipt?: DocumentFlushReceipt;
}

const sessionsByTab = new Map<string, DocumentSessionAdapter>();
const sessionsByPane = new Map<EditorPaneId, DocumentSessionAdapter>();
const currentTabIds = new WeakMap<DocumentSessionAdapter, string>();
const runtimeListeners = new Set<(tabId: string, state: DocumentDerivedState | null) => void>();
const sessionListeners = new Set<() => void>();
const derivedByTab = new Map<string, DocumentDerivedState>();
const identitiesByTab = new Map<string, { documentId: string; epoch: number; revision: number }>();
const histories = new Map<string, DocumentHistory>();
let documentEpochSequence = 0;
let commandLeaseSequence = 0;
const commandLeases = new WeakMap<DocumentSessionAdapter, number>();
const commandHydrations = new WeakMap<DocumentSessionAdapter, Promise<void>>();

export function documentCommandLease(tabId: string) { const session = sessionsByTab.get(tabId); return session ? commandLeases.get(session) ?? 0 : 0; }
export function pendingCommandTabId(handle: PendingCommandHandle) {
  pendingCommand(handle);
  for (const [tabId, identity] of identitiesByTab) if (identity.documentId === handle.documentId && identity.epoch === handle.epoch) return tabId;
  throw new Error('原文档已关闭，已保留新资源，未插入其他文档。');
}
export function beginPendingImageCommand(tabId: string, from: number, to: number) {
  const session = sessionsByTab.get(tabId);
  if (!session?.applyPendingCommand) throw new Error('当前文档没有可用的插入会话。');
  return beginPendingCommand(documentRuntimeIdentity(tabId), 'image', session.mode, commandLeases.get(session)!, { from, to });
}
export function beginPendingAssetCommand(target: DocumentCommandTarget, patch: DocumentSourcePatch) {
  if (!documentCommandTargetIsCurrent(target) || !target.session.captureAssetCommandAnchor) throw new Error('资源引用目标已变化，请刷新资源列表。');
  const anchor = target.session.captureAssetCommandAnchor(patch, target.markdown);
  return beginPendingCommand(target, 'asset', target.session.mode, commandLeases.get(target.session)!, anchor);
}
export function mapPendingDocumentCommands(tabId: string, lease: number, maps: readonly CommandPositionMap[], validate?: (anchor: NativeCommandAnchor) => boolean) {
  const identity = identitiesByTab.get(tabId);
  if (!identity || documentCommandLease(tabId) !== lease) return;
  mapPendingCommands(identity.documentId, lease, maps, validate);
}
async function attachPendingDocumentCommands(session: DocumentSessionAdapter, lease: number) {
  const identity = documentRuntimeIdentity(session.tabId);
  await Promise.all(pendingCommandsForDocument(identity.documentId).map(async command => {
    if (!command.raw || command.native) return;
    const raw = command.raw;
    if (!session.commandAnchorFromSource || session.initialCommandMarkdown !== raw.markdown) { failPendingCommand(command); return; }
    command.native = { lease, model: session.mode, anchor: null, queued: [] };
    try {
      const anchor = await session.commandAnchorFromSource(raw, command.kind, raw.markdown);
      if (commandLeases.get(session) === lease) hydratePendingCommand(command, lease, anchor, session.validateCommandAnchor);
    } catch (error) { if (command.native?.lease === lease) failPendingCommand(command, error instanceof Error ? error.message : String(error)); }
  }));
}
async function projectPendingDocumentCommands(session: DocumentSessionAdapter, markdown: string, revision: number) {
  await commandHydrations.get(session);
  const tabId = currentTabIds.get(session) ?? session.tabId;
  const identity = identitiesByTab.get(tabId), lease = commandLeases.get(session);
  if (!identity || !lease || !session.commandAnchorToSource) return;
  const toSource = session.commandAnchorToSource;
  await Promise.all(pendingCommandsForDocument(identity.documentId).map(async command => {
    if (command.native?.lease !== lease || !command.native.anchor) return;
    const sequence = command.sequence, anchor = { ...command.native.anchor };
    try {
      const raw = await toSource(anchor, command.kind, markdown);
      if (sessionsByTab.get(tabId) === session && session.revision === revision) projectPendingCommand(command, lease, sequence, { ...raw, markdown, revision });
    } catch (error) { if (command.native?.lease === lease && command.sequence === sequence) failPendingCommand(command, error instanceof Error ? error.message : String(error)); }
  }));
}
export async function preparePendingDocumentCommand(handle: PendingCommandHandle) {
  const tabId = pendingCommandTabId(handle), session = sessionsByTab.get(tabId);
  if (session) {
    await waitForDocumentComposition(tabId, session);
    await commandHydrations.get(session);
    await flushDocumentSessionPendingEdits(tabId, 'externalDiff');
    if (sessionsByTab.get(tabId) !== session) return preparePendingDocumentCommand(handle);
  }
  const command = pendingCommand(handle);
  return { tabId, session: sessionsByTab.get(tabId) ?? null, command };
}
export async function applyMountedPendingDocumentCommand(handle: PendingCommandHandle, payload: PendingCommandPayload, assertExternalCurrent?: () => void) {
  const { tabId, session, command } = await preparePendingDocumentCommand(handle);
  if (!session) return false;
  const native = command.native, lease = commandLeases.get(session);
  if (!native?.anchor || native.lease !== lease || !session.applyPendingCommand) throw new Error('原文档定位尚未就绪，已保留资源，请重试。');
  const anchor = { ...native.anchor }, sequence = command.sequence, revision = session.revision;
  const pendingVersion = session.pendingEditVersion?.() ?? 0, token = session.mutationToken?.();
  const assertCurrent = () => {
    assertExternalCurrent?.();
    const current = pendingCommand(handle), currentToken = session.mutationToken?.();
    if (pendingCommandTabId(handle) !== tabId || sessionsByTab.get(tabId) !== session || current.sequence !== sequence
      || current.native?.lease !== lease || session.revision !== revision || (session.pendingEditVersion?.() ?? 0) !== pendingVersion
      || session.hasPendingEdits?.() || token && (!currentToken || !documentMutationTokensEqual(token, currentToken))) {
      throw new Error('资源操作准备期间输入或定位已变化，已保留新输入，请重试。');
    }
  };
  assertCurrent();
  await session.applyPendingCommand(anchor, payload, revision, assertCurrent);
  return true;
}

export function documentRuntimeIdentity(tabId: string) {
  let identity = identitiesByTab.get(tabId);
  if (!identity) {
    identity = { documentId: crypto.randomUUID(), epoch: ++documentEpochSequence, revision: 0 };
    identitiesByTab.set(tabId, identity);
  }
  return identity;
}

export function documentRevision(tabId: string) {
  return documentRuntimeIdentity(tabId).revision;
}

export function advanceDocumentRevision(tabId: string, observedRevision = 0) {
  const identity = documentRuntimeIdentity(tabId);
  identity.revision = Math.max(identity.revision, observedRevision) + 1;
  return identity.revision;
}

export function documentHistoryForTab(tabId: string) {
  const { documentId } = documentRuntimeIdentity(tabId);
  let history = histories.get(documentId);
  if (!history) { history = new DocumentHistory(); histories.set(documentId, history); }
  return history;
}

export async function moveDocumentHistory(tabId: string, direction: -1 | 1) {
  await flushDocumentSessionPendingEdits(tabId, 'externalDiff');
  const session = documentSessionForTab(tabId);
  if (!session?.prepareHistoryReplay) return false;
  const history = documentHistoryForTab(tabId);
  const move = history.prepare(direction);
  if (!move) return false;
  const revision = session.revision;
  const pendingVersion = session.pendingEditVersion?.() ?? 0;
  const token = session.mutationToken?.();
  const projection = history.projection(move.version, session.mode);
  const publish = await session.prepareHistoryReplay(projection, history.exactSource(move.version), !history.isSaved(move.version));
  const currentToken = session.mutationToken?.();
  if (documentSessionForTab(tabId) !== session || session.revision !== revision
    || (session.pendingEditVersion?.() ?? 0) !== pendingVersion
    || token && (!currentToken || !documentMutationTokensEqual(token, currentToken))) {
    throw new Error('撤销准备期间文档已变化，当前输入已保留。');
  }
  history.commit(move, publish);
  if (session.captureHistoryRoot && session.captureHistoryBookmark) history.project(session.captureHistoryRoot(), session.captureHistoryBookmark());
  return true;
}

export async function captureDocumentCommandTarget(tabId: string, reason: SnapshotReason): Promise<DocumentCommandTarget> {
  const snapshot = await snapshotDocumentTab(tabId, reason);
  const session = documentSessionForTab(tabId);
  if (!snapshot || !session) throw new Error("文档编辑会话不可用，操作已取消。");
  if (session.revision !== snapshot.revision || session.hasPendingEdits?.()) throw new Error("文档输入仍在变化，请完成输入后重试。");
  return Object.freeze({
    ...documentRuntimeIdentity(tabId), tabId, paneId: session.paneId, session,
    revision: snapshot.revision, pendingInputVersion: session.pendingEditVersion?.() ?? 0,
    mutationToken: snapshot.mutationToken, markdown: snapshot.markdown,
  });
}

export function documentCommandTargetIsCurrent(target: DocumentCommandTarget) {
  const session = documentSessionForTab(target.tabId);
  const identity = identitiesByTab.get(target.tabId);
  if (session !== target.session || identity?.documentId !== target.documentId || identity.epoch !== target.epoch) return false;
  if (session.revision !== target.revision || (session.pendingEditVersion?.() ?? 0) !== target.pendingInputVersion) return false;
  const token = session.mutationToken?.();
  return !target.mutationToken || Boolean(token && documentMutationTokensEqual(target.mutationToken, token));
}

export async function applyDocumentSourcePatch(target: DocumentCommandTarget, patch: DocumentSourcePatch) {
  if (!documentCommandTargetIsCurrent(target)) throw new Error("文档在操作期间发生了变化，已保留新输入，请重新选择。");
  if (target.markdown.slice(patch.from, patch.to) !== patch.expected) throw new Error("源码范围已变化，操作已取消。");
  if (!target.session.applySourcePatch) throw new Error("当前内容不能安全地局部修改，请在源码模式中操作。");
  await target.session.applySourcePatch(patch, target.revision);
}

export function registerDocumentSession(adapter: DocumentSessionAdapter) {
  const previous = sessionsByTab.get(adapter.tabId);
  if (previous && previous !== adapter) {
    const identity = identitiesByTab.get(adapter.tabId), previousLease = commandLeases.get(previous);
    if (identity && previousLease) detachPendingCommands(identity.documentId, previousLease);
    commandLeases.delete(previous);
  }
  sessionsByTab.set(adapter.tabId, adapter);
  sessionsByPane.set(adapter.paneId, adapter);
  currentTabIds.set(adapter, adapter.tabId);
  const lease = ++commandLeaseSequence;
  commandLeases.set(adapter, lease);
  commandHydrations.set(adapter, attachPendingDocumentCommands(adapter, lease));
  emitSessionChange();
  return () => {
    const currentTabId = currentTabIds.get(adapter) ?? adapter.tabId;
    const identity = identitiesByTab.get(currentTabId);
    if (identity) detachPendingCommands(identity.documentId, lease);
    commandLeases.delete(adapter);
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

/**
 * Flush only the mounted editor buffer and return its exact session fence.
 * Large documents use this boundary without asking the adapter for a full
 * Markdown string.
 */
export async function flushDocumentSessionPendingEdits(
  tabId: string,
  reason: SnapshotReason,
): Promise<DocumentSessionFlushResult | null> {
  const session = documentSessionForTab(tabId);
  if (!session) return null;
  await waitForDocumentComposition(tabId, session);
  const beforeRevision = session.revision;
  const beforeToken = session.mutationToken?.() ?? null;
  const receipt = (await session.flushPendingEdits?.(reason, {
    expectedToken: beforeToken ?? undefined,
  })) || undefined;
  if (documentSessionForTab(tabId) !== session) {
    throw new Error("编辑器输入 flush 期间会话已被替换。");
  }
  const afterRevision = session.revision;
  const afterToken = session.mutationToken?.() ?? null;
  if (receipt) {
    if (receipt.sessionIdentity !== session
      || (beforeToken && !documentMutationTokensEqual(receipt.before, beforeToken))
      || (afterToken && !documentMutationTokensEqual(receipt.after, afterToken))) {
      throw new Error("编辑器输入 flush 返回了无法验证的会话回执。");
    }
  } else if (beforeToken || afterToken) {
    if (!beforeToken || !afterToken || !documentMutationTokensEqual(beforeToken, afterToken)) {
      throw new Error("编辑器输入 flush 期间文档版本发生了变化。");
    }
  }
  return { session, beforeRevision, afterRevision, beforeToken, afterToken, receipt };
}

export async function waitForDocumentComposition(tabId: string, session = documentSessionForTab(tabId), signal?: AbortSignal) {
  while (session?.isComposing?.()) {
    if (signal?.aborted) throw new DOMException('文档操作已取消。', 'AbortError');
    if (documentSessionForTab(tabId) !== session) throw new Error('输入法组合期间文档会话已更换，输入已保留。');
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  if (session && documentSessionForTab(tabId) !== session) throw new Error('文档会话已更换，操作已取消。');
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
  const identity = identitiesByTab.get(previousTabId);
  if (identity) { identitiesByTab.delete(previousTabId); identitiesByTab.set(nextTabId, identity); }
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
  const identity = documentRuntimeIdentity(tabId);
  identity.revision = Math.max(identity.revision, state.revision ?? 0);
  const next = { ...state };
  derivedByTab.set(tabId, next);
  emitRuntimeState(tabId, next);
}

export function publishDocumentDerivedPatch(tabId: string, patch: DocumentDerivedPatch) {
  const identity = documentRuntimeIdentity(tabId);
  identity.revision = Math.max(identity.revision, patch.revision);
  const next = { ...(derivedByTab.get(tabId) ?? {}), ...patch };
  derivedByTab.set(tabId, next);
  emitRuntimeState(tabId, next);
}

export function clearDocumentRuntimeState(tabId: string) {
  const identity = identitiesByTab.get(tabId);
  if (identity) histories.delete(identity.documentId);
  if (identity) clearPendingCommands(identity.documentId);
  identitiesByTab.delete(tabId);
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
  await waitForDocumentComposition(tabId, session, options.signal);
  if (sessionsByTab.get(tabId) !== session) throw new Error("编辑器会话已被替换，已阻止使用旧正文。");
  if (options.signal?.aborted) throw new DOMException("文档快照已取消。", "AbortError");
  const tokenBeforeFlush = session.mutationToken?.();
  const flushReceipt = await session.flushPendingEdits?.(reason, {
    expectedToken: tokenBeforeFlush,
  });
  if (sessionsByTab.get(tabId) !== session) throw new Error("编辑器会话已被替换，已阻止使用旧正文。");
  if (options.signal?.aborted) throw new DOMException("文档快照已取消。", "AbortError");
  const tokenAfterFlush = session.mutationToken?.();
  if (flushReceipt && flushReceipt.sessionIdentity !== session) {
    throw new Error("文档 flush receipt 不属于当前编辑器会话。");
  }
  if (flushReceipt && (!tokenAfterFlush || !documentMutationTokensEqual(tokenAfterFlush, flushReceipt.after))) {
    throw new Error("文档 flush 完成后版本已变化，已阻止使用旧正文。");
  }
  const tokenBeforeSnapshot = tokenAfterFlush ?? tokenBeforeFlush;
  const expectedRevision = session.revision;
  const snapshot = await session.snapshot(reason, options);
  await projectPendingDocumentCommands(session, snapshot.markdown, snapshot.revision);
  if (sessionsByTab.get(tabId) !== session) throw new Error("编辑器会话已被替换，已阻止使用旧正文。");
  if (options.signal?.aborted) throw new DOMException("文档快照已取消。", "AbortError");
  const tokenAfterSnapshot = session.mutationToken?.();
  if (tokenBeforeSnapshot && tokenAfterSnapshot
    && !documentMutationTokensEqual(tokenBeforeSnapshot, tokenAfterSnapshot)) {
    throw new Error("文档在生成快照时发生了变化，请重试。");
  }
  const registeredTabId = currentTabIds.get(session) ?? session.tabId;
  if (registeredTabId !== tabId) throw new Error("编辑器返回了错误文档的快照。");
  if (snapshot.revision !== expectedRevision || snapshot.revision !== session.revision) throw new Error("文档在生成快照时发生了变化，请重试。");
  const normalized = snapshot.tabId === tabId ? snapshot : { ...snapshot, tabId };
  return {
    ...normalized,
    ...(tokenAfterSnapshot ? { mutationToken: tokenAfterSnapshot } : {}),
    ...(flushReceipt ? { flushReceipt } : {}),
  };
}

export async function snapshotDocumentPane(paneId: EditorPaneId, reason: SnapshotReason) {
  const session = documentSessionForPane(paneId);
  return session ? snapshotDocumentTab(currentTabIds.get(session) ?? session.tabId, reason) : null;
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
