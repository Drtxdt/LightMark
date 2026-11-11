import { computed, nextTick, reactive, toRaw } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { invokeLargeSource, readLargeSourceRange, runLargeSourceJob, assertLargeStateReceipt, type LargeRangeRequest } from "../editor/largeSourceClient";
import { throwIfLargeSearchAborted } from '../editor/largeSearchCoordinator';
import {
  captureDocumentCommandTarget,
  advanceDocumentRevision,
  applyMountedPendingDocumentCommand,
  pendingCommandTabId,
  preparePendingDocumentCommand,
  type PendingCommandPayload,
  documentCommandTargetIsCurrent,
  documentHistoryForTab,
  documentRuntimeIdentity,
  clearDocumentRuntimeState,
  documentSessionForTab,
  flushDocumentSessionPendingEdits,
  publishDocumentDerivedPatch,
  rebindDocumentSession,
  snapshotDocumentTab,
  waitForDocumentSession,
  waitForDocumentComposition,
  type DocumentSessionAdapter,
  type DocumentSessionFlushResult,
  type MarkdownSnapshot,
  type SnapshotReason,
} from "../editor/documentRuntime";
import { mapInactivePendingCommands, pendingCommand, type PendingCommandHandle } from '../editor/pendingDocumentCommands';
import { DocumentDiskWriteFence } from '../editor/documentDiskWriteFence';
import type { ImageAssetTarget } from '../utils/imageAssets';
import type { ImageSettings } from '../types';
import {
  documentMutationTokensEqual,
  type DocumentFlushReceipt,
  type DocumentMutationToken,
} from "../editor/documentMutationTracker";
import { DocumentSnapshotCoordinator } from "../editor/documentSnapshotCoordinator";
import {
  LargeOperationQueue,
  LargeSessionStaleError,
  type LargeSessionIdentity,
} from "../editor/largeOperationQueue";
import { installRuntimeProjection, type RuntimeDerivedProjection } from "./runtimeProjection";
import { workspaceIndexClient, type WorkspaceIndexStatus } from "./workspaceIndexClient";
import {
  captureDraftCleanupContext,
  captureDraftCleanupReceipt,
  checkDraftForOpenedFile,
  clearCapturedDraft,
  flushCurrentDraft,
} from "./draftStore";
import {
  advanceMutationEpoch,
  mutationEpoch,
  runVersionedSave,
  saveVersionIsCurrent,
  SaveTransactionQueue,
  type WindowCloseDraftReceipt,
  type SaveVersion,
} from "./saveTransaction";
import { alertDialog, showDialog } from "./dialogStore";
import { LARGE_COORDINATE_SPACE } from "../types";
import type {
  AppConfig,
  AppSettings,
  CapturedEditorTarget,
  ClosedTabRecord,
  DirtyState,
  DocumentTab,
  DocumentMode,
  EditorPositionSnapshot,
  EditorPaneId,
  EditorMode,
  ExternalFileState,
  ExportStatus,
  ExportTargetId,
  ImageInsertBehavior,
  FileChunk,
  FileInfo,
  FileNode,
  FileSnapshot,
  LargeFileSession,
  LargeFileState,
  LargeFileFingerprint,
  LargeFindMatch,
  LargeFindOptions,
  LargeFindResult,
  LargeSaveReceipt,
  LargeCloseReceipt,
  LargeDraftCaptureReceipt,
  LargeDraftOpenReceipt,
  NavigationLocation,
  PendingModeCursor,
  QuickOpenCandidate,
  SessionRestoreState,
  SessionSplitLayoutState,
  SessionTabState,
  SimilarFileCandidate,
  SplitLayoutState,
  TextFileSnapshot,
  TextFileWriteReceipt,
  TextEdit,
  ThemeMode,
} from "../types";
import { buildTextDiffSummary } from "../utils/textDiff";
import { buildMarkdownFormatDiff, formatMarkdown, type MarkdownFormatResult } from "../utils/markdownFormat";
import { mergeEditorPosition } from "../utils/editorPosition";
import { normalizeSnippets } from "../utils/snippets";
import {
  extractOutlineWithLines,
  reconcileCollapsedKeys,
  resolveHeadingSection,
  structureOutline,
  type StructuredOutlineItem,
} from "../utils/outline";
import {
  defaultSplitLayout,
  disableSplitLayout,
  enableSplitLayout,
  normalizeSplitLayout,
  otherPaneId,
  paneTabId,
  resolveClosedTabSplitLayout,
  splitLayoutForPaneActivation,
} from "../utils/splitLayout";
import {
  createWikiWorkspaceIndex,
  prepareUnlinkedMentionConversion,
  resolveWikiLink,
  scoreKnowledgeQuickOpenEntry,
  wikiPageFileName,
  type BacklinkItem,
  type KnowledgeTagItem,
  type UnlinkedMentionItem,
  type WikiDocumentEntry,
  type WikiLinkTarget,
  type WikiWorkspaceIndex,
} from "../utils/wikiLinks";

export const appStore = reactive({
  currentWorkspace: "",
  fileTree: [] as FileNode[],
  currentFilePath: "",
  currentContent: "",
  documentMode: "normal" as DocumentMode,
  largeFile: null as LargeFileState | null,
  paneContextLines: { main: 0, secondary: 0 } as Record<EditorPaneId, number>,
  paneOutlineAnchorLines: { main: 0, secondary: 0 } as Record<EditorPaneId, number>,
  paneOutlineAnchorSources: { main: "selection", secondary: "selection" } as Record<EditorPaneId, "selection" | "scroll" | "navigation">,
  largeFileViewportLines: { main: 0, secondary: 0 } as Record<EditorPaneId, number>,
  isDirty: false,
  saveState: "saved" as "dirty" | "saving" | "saved" | "failed",
  editorMode: "wysiwyg" as EditorMode,
  tabs: [] as DocumentTab[],
  activeTabId: "",
  splitLayout: defaultSplitLayout() as SplitLayoutState,
  closedTabs: [] as ClosedTabRecord[],
  quickOpenOpen: false,
  quickOpenQuery: "",
  quickOpenActiveIndex: 0,
  headingJumpOpen: false,
  headingJumpQuery: "",
  headingJumpActiveIndex: 0,
  formulaJumpOpen: false,
  formulaJumpQuery: "",
  formulaJumpActiveIndex: 0,
  goToLineOpen: false,
  navigationBackStack: [] as NavigationLocation[],
  navigationForwardStack: [] as NavigationLocation[],
  recentFiles: [] as string[],
  configPersistenceMessage: "",
  theme: "light" as ThemeMode,
  activeTheme: "light" as Exclude<ThemeMode, "system">,
  settings: defaultSettings(),
  settingsOpen: false,
  commandPaletteOpen: false,
  capturedEditorTarget: null as CapturedEditorTarget | null,
  wordCountOpen: false,
  distractionFreeMode: false,
  distractionHintVisible: false,
  wikiBacklinksOpen: false,
  wikiBacklinks: [] as BacklinkItem[],
  wikiBacklinksForPath: "",
  wikiBacklinksBusy: false,
  wikiBacklinksError: "",
  wikiIndex: createWikiWorkspaceIndex([]) as WikiWorkspaceIndex,
  wikiIndexBusy: false,
  wikiIndexError: "",
  workspaceIndexReady: false,
  workspaceIndexGeneration: 0,
  workspaceIndexTags: [] as KnowledgeTagItem[],
  runtimeDerivedByTab: {} as RuntimeDerivedProjection,
  wikiUnlinkedMentions: [] as UnlinkedMentionItem[],
  wikiMentionsForPath: "",
  pendingModeCursor: null as PendingModeCursor | null,
  pendingEditorPosition: null as EditorPositionSnapshot | null,
  exportStatus: {
    status: "idle",
    message: "",
  } as ExportStatus,
  statusMessage: "",
});

const EXTERNAL_FILE_CHECK_INTERVAL_MS = 10_000;
let externalFileFallbackTimer = 0;
let externalFileCheckInFlight = false;
let externalFileCheckQueued = false;
const fileWriteFence = new DocumentDiskWriteFence(normalizePathKey);
let externalFileWatcherRunning = false;
let externalFileWatcherAvailable = true;
let backlinkRefreshTimer = 0;
let backlinkRefreshGeneration = 0;
let wikiIndexHydrationPromise: Promise<void> | null = null;
let workspaceKnowledgeRefreshTimer = 0;
let workspaceEpoch = 0;
let workspaceSelectionRequest = 0;
let treeRequest = 0;
let workspaceWatchTail: Promise<void> = Promise.resolve();
let indexOpenTail: Promise<void> = Promise.resolve();
type WorkspaceView = { root: string; epoch: number };
const currentWorkspaceView = (): WorkspaceView => ({ root: appStore.currentWorkspace, epoch: workspaceEpoch });
const ownsWorkspace = (view: WorkspaceView) => view.epoch === workspaceEpoch && view.root === appStore.currentWorkspace;
let distractionHintTimer = 0;
const documentSnapshotCoordinator = new DocumentSnapshotCoordinator();
const documentRuntimeMetadata = new Map<string, {
  revision: number;
  derived: { words?: number; chars?: number; lines?: number };
}>();
const workspaceKnowledgePendingPaths = new Set<string>();
const watchedFilePaths = new Map<string, string>();
const saveTransactionQueue = new SaveTransactionQueue();
const largeQueues = new WeakMap<DocumentTab, LargeOperationQueue>();
type LargeOutboxBatch = {
  id: string;
  edits: TextEdit[];
  /** Revision whose line/column coordinates produced this batch. */
  expectedRevision: number;
  sessionId: string;
  failed?: unknown;
};
const largeOutboxes = new WeakMap<DocumentTab, LargeOutboxBatch[]>();
const largeRemotePendingCounts = new WeakMap<DocumentTab, number>();

type SaveContext = {
  tab: DocumentTab;
  tabId: string;
  path: string;
  kind: DocumentTab["kind"];
  session: DocumentSessionAdapter | null;
  epoch: number;
  revision: number | null;
  pendingVersion: number | null;
  content: string;
  fileSnapshot?: FileSnapshot;
  windowCloseExpected?: CloseAuthorization;
  windowCloseFlushReceipt?: DocumentFlushReceipt;
  mutationToken: DocumentMutationToken | null;
};

type FrozenSaveVersion = Omit<SaveVersion, "tab"> & {
  tab: DocumentTab;
  markdown: string;
  dirty: boolean;
};

export type CloseAuthorization = {
  tab: DocumentTab;
  tabId: string;
  path: string;
  kind: DocumentTab["kind"];
  documentMode: DocumentTab["documentMode"];
  epoch: number;
  revision: number | null;
  pendingVersion: number | null;
  session: DocumentSessionAdapter | null;
  mutationToken: DocumentMutationToken | null;
  content: string;
  dirty: boolean;
  pending: boolean;
  largeFile: LargeFileState | null;
  largePendingEdits: string;
};

export type WindowCloseAuthorization = {
  tabs: CloseAuthorization[];
};

export type WindowCloseSaveReceipt = {
  tab: DocumentTab;
  before: CloseAuthorization;
  after: CloseAuthorization;
  retargeted: boolean;
};

installRuntimeProjection(appStore.runtimeDerivedByTab);

export const currentFileName = computed(() => {
  const tab = getActiveTab();
  if (tab) return tab.name;
  if (!appStore.currentFilePath) return "未命名";
  return appStore.currentFilePath.split(/[\\/]/).pop() || appStore.currentFilePath;
});

export const quickOpenCandidates = computed(() => {
  const query = appStore.quickOpenQuery.trim();
  const workspaceFiles = appStore.wikiIndex.entries.map((entry) => candidateFromWikiEntry(entry));
  const recentFiles = appStore.recentFiles.map((path) => candidateFromPath(path, "recent"));
  const workspaceMatches = filterQuickOpenCandidates(workspaceFiles, query);
  if (appStore.currentWorkspace && workspaceFiles.length > 0 && workspaceMatches.length > 0) {
    return workspaceMatches;
  }
  const recentMatches = filterQuickOpenCandidates(recentFiles, query);
  return recentMatches.length > 0 || query ? recentMatches : recentFiles;
});

export const workspaceKnowledgeTags = computed(() => (
  appStore.workspaceIndexReady ? appStore.workspaceIndexTags : []
));

export function setContent(content: string, dirty = true) {
  setPaneContent(appStore.splitLayout.activePaneId, content, dirty);
}

export async function formatCurrentMarkdown() {
  const paneId = appStore.splitLayout.activePaneId;
  const tab = getPaneTab(paneId);
  if (!tab) {
    appStore.statusMessage = "没有可格式化的活动文档。";
    return false;
  }
  if (tab.documentMode === "large") {
    appStore.statusMessage = "大文件模式暂不支持 Markdown 格式化。";
    return false;
  }
  const commandTarget = await captureDocumentCommandTarget(tab.id, "externalDiff");
  const source = commandTarget.markdown;
  const result = formatMarkdown(source);
  if (!result.changed) {
    appStore.statusMessage = "当前文档已经符合保守格式规范。";
    return false;
  }
  const decision = await showDialog({
    title: "格式化当前 Markdown",
    message: `将调整 ${result.stats.changedLines} 行；保护区内容保持不变。应用后可一次撤销。`,
    details: buildMarkdownFormatDiff(source, result.text),
    cancelId: "cancel",
    defaultId: "apply",
    buttons: [
      { id: "cancel", label: "取消", variant: "secondary" },
      { id: "apply", label: "应用格式化", variant: "primary" },
    ],
  });
  if (decision !== "apply") {
    appStore.statusMessage = "已取消格式化。";
    return false;
  }
  if (getPaneTab(paneId) !== tab || !documentCommandTargetIsCurrent(commandTarget)) {
    appStore.statusMessage = "格式化预览已过期，当前输入已保留。";
    if (getPaneTab(paneId) === tab && appStore.splitLayout.activePaneId === paneId) return formatCurrentMarkdown();
    return false;
  }
  const detail: { paneId: EditorPaneId; source: string; result: MarkdownFormatResult; handled: boolean } = {
    paneId,
    source,
    result,
    handled: false,
  };
  window.dispatchEvent(new CustomEvent("lightmark:apply-markdown-format", { detail }));
  if (!detail.handled) setPaneContent(paneId, result.text, true);
  appStore.statusMessage = `格式化完成：调整 ${result.stats.changedLines} 行。`;
  return true;
}

export function setPaneContent(paneId: EditorPaneId, content: string, dirty = true, replaceRuntime = true) {
  const tab = getPaneTab(paneId);
  if (tab?.documentMode === "large") return;
  if (!tab && paneId === appStore.splitLayout.activePaneId) ensureEditableTab();
  const target = getPaneTab(paneId);
  if (!target || target.documentMode === "large") return;
  advanceMutationEpoch(target);
  target.content = content;
  delete appStore.runtimeDerivedByTab[target.id];
  target.isDirty = dirty;
  target.documentMode = "normal";
  if (paneId === appStore.splitLayout.activePaneId || target.id === appStore.activeTabId) {
    appStore.currentContent = content;
    appStore.isDirty = dirty;
    appStore.saveState = dirty ? "dirty" : "saved";
    appStore.documentMode = target.documentMode;
  }
  scheduleKnowledgeRefresh();
  scheduleWikiIndexEntryRefresh(target.path, content);
  const session = replaceRuntime ? documentSessionForTab(target.id) : null;
  if (session) {
    void session.replaceMarkdown(content).catch((error) => {
      appStore.statusMessage = `编辑器内容替换失败：${error}`;
    });
  }
}

export function markDocumentChanged(
  tabId: string,
  revision: number,
  derived: { words?: number; chars?: number; lines?: number; outline?: StructuredOutlineItem[] } = {},
) {
  const tab = appStore.tabs.find((item) => item.id === tabId);
  if (!tab || tab.documentMode === "large") return;
  advanceMutationEpoch(tab);
  tab.isDirty = true;
  if (tab.id === appStore.activeTabId) {
    appStore.isDirty = true;
    appStore.saveState = "dirty";
  }
  documentRuntimeMetadata.set(tabId, { revision, derived });
  publishDocumentDerivedPatch(tabId, { revision, ...derived });
  scheduleDocumentSnapshot(tabId);
}

function scheduleDocumentSnapshot(tabId: string) {
  const tab = appStore.tabs.find((item) => item.id === tabId);
  if (!tab?.path || !appStore.currentWorkspace || !appStore.workspaceIndexReady) return;
  documentSnapshotCoordinator.schedule(
    tabId,
    async (signal) => { await flushDocumentSnapshot(tabId, "indexIdle", signal); },
    (error) => { appStore.statusMessage = `后台文档快照失败：${error}`; },
  );
}

export async function flushDocumentSnapshot(tabId: string, reason: SnapshotReason, signal?: AbortSignal) {
  const result = await flushDocumentSnapshotWithReceipt(tabId, reason, signal);
  return result.markdown;
}

async function applyPendingCommandToDocument(handle: PendingCommandHandle, payload: PendingCommandPayload, expectedPath?: string) {
  const originalTabId = pendingCommandTabId(handle);
  const assertPath = () => { if (expectedPath != null && appStore.tabs.find(tab => tab.id === pendingCommandTabId(handle))?.path !== expectedPath) throw new Error('原文档路径已变化，资源已保留，请重试。'); };
  assertPath();
  if (await applyMountedPendingDocumentCommand(handle, payload, assertPath)) {
    await flushDocumentSnapshot(originalTabId, 'externalDiff');
    return;
  }
  const { tabId, command } = await preparePendingDocumentCommand(handle);
  const tab = appStore.tabs.find(item => item.id === tabId);
  if (!tab) throw new Error('原文档已关闭，已保留资源。');
  if (appStore.splitLayout.mainTabId === tabId || appStore.splitLayout.secondaryTabId === tabId) {
    await waitForDocumentSession(tabId);
    if (await applyMountedPendingDocumentCommand(handle, payload, assertPath)) {
      await flushDocumentSnapshot(tabId, 'externalDiff');
      return;
    }
    throw new Error('原文档编辑器尚未就绪，已保留资源，请重试。');
  }
  const raw = command.raw, sequence = command.sequence;
  if (!raw || raw.markdown !== tab.content || command.native) throw new Error('原文档定位已变化，已保留当前内容。');
  const { inactiveDocumentPatch, blockSpacedMarkdown, inactiveHistorySelection } = await import('../editor/inactiveDocumentPatch');
  const history = documentHistoryForTab(tabId), historyVersion = history.version;
  const oldBookmark = history.current ? await inactiveHistorySelection(history.projection(history.current, 'source'), raw.markdown) : { anchor: raw.from, head: raw.to };
  const current = pendingCommand(handle);
  assertPath();
  const becameVisible = appStore.splitLayout.mainTabId === tabId || appStore.splitLayout.secondaryTabId === tabId;
  if (becameVisible) {
    await waitForDocumentSession(tabId);
    if (await applyMountedPendingDocumentCommand(handle, payload, assertPath)) { await flushDocumentSnapshot(tabId, 'externalDiff'); return; }
    throw new Error('原文档编辑器尚未就绪，已保留资源，请重试。');
  }
  if (pendingCommandTabId(handle) !== tabId || !appStore.tabs.includes(tab) || documentSessionForTab(tabId)
    || current.sequence !== sequence || current.raw !== raw || tab.content !== raw.markdown
    || documentRuntimeIdentity(tabId).revision !== raw.revision || history.version !== historyVersion) throw new Error('原文档已变化，请重试资源操作。');
  let from = raw.from, to = raw.to;
  if (payload.kind === 'image' && from === 0 && to === 0 && tab.content.startsWith('\uFEFF')) from = to = 1;
  const insert = payload.kind === 'asset' ? payload.insert : blockSpacedMarkdown(tab.content, from, to, payload.markdown);
  const before = tab.content;
  const result = inactiveDocumentPatch(before, { from, to, expected: before.slice(from, to), insert });
  history.project(result.before, oldBookmark);
  history.record(result.after, { kind: 'command', before: oldBookmark, after: result.bookmark, time: Date.now() });
  history.checkpoint(result.markdown);
  tab.content = result.markdown;
  const revision = advanceDocumentRevision(tabId);
  mapInactivePendingCommands(handle.documentId, before, result.markdown, revision, [{ from, to, inserted: result.markdown.length - before.length + to - from }]);
  markDocumentChanged(tabId, revision);
}

export async function completePendingImageCommand(handle: PendingCommandHandle, markdown: string, target: ImageAssetTarget) {
  const { rebasePendingImagePaths } = await import('../editor/pendingAssetPaths');
  for (let attempt = 0; attempt < 3; attempt++) {
    const tabId = pendingCommandTabId(handle), tab = appStore.tabs.find(item => item.id === tabId);
    if (!tab) throw new Error('原文档已关闭，图片已保存在原资源目录。');
    const path = tab.path;
    const rebased = await rebasePendingImagePaths(markdown, target.markdownPath, path, target.settings);
    if (pendingCommandTabId(handle) !== tabId || tab.path !== path) continue;
    await applyPendingCommandToDocument(handle, { kind: 'image', markdown: rebased }, path);
    return;
  }
  throw new Error('原文档路径正在变化，图片已保留，请重试。');
}

export async function completePendingAssetRelink(handle: PendingCommandHandle, absolutePath: string, settings: Readonly<ImageSettings>) {
  const { assetReferenceForDocument } = await import('../editor/pendingAssetPaths');
  for (let attempt = 0; attempt < 3; attempt++) {
    const tabId = pendingCommandTabId(handle), tab = appStore.tabs.find(item => item.id === tabId);
    if (!tab) throw new Error('原文档已关闭，未修改其他文档。');
    const path = tab.path;
    const insert = await assetReferenceForDocument(path, absolutePath, settings);
    if (pendingCommandTabId(handle) !== tabId || tab.path !== path) continue;
    await applyPendingCommandToDocument(handle, { kind: 'asset', insert }, path);
    return;
  }
  throw new Error('原文档路径正在变化，请重试重链。');
}

export async function flushDocumentSnapshotWithReceipt(
  tabId: string,
  reason: SnapshotReason,
  signal?: AbortSignal,
): Promise<{ markdown: string; flushReceipt?: DocumentFlushReceipt }> {
  const expectedTab = appStore.tabs.find((item) => item.id === tabId);
  if (!expectedTab) throw new Error("快照对应的标签页已不存在。");
  const expectedSession = documentSessionForTab(tabId);
  if (expectedTab.documentMode === "large") {
    await flushLargePendingInputForTab(toRaw(expectedTab) as DocumentTab, reason);
    if (!appStore.tabs.includes(expectedTab)
      || expectedTab.id !== tabId
      || documentSessionForTab(tabId) !== expectedSession) {
      throw new Error("大文件输入 flush 后标签页或编辑器会话已被替换。");
    }
    // Large documents deliberately do not materialize their remote view in
    // JavaScript. Callers that need content must use a dedicated large-file
    // API rather than treating this empty marker as Markdown.
    return { markdown: "" };
  }
  documentSnapshotCoordinator.prepare(tabId, reason);
  const snapshot = await snapshotDocumentTab(tabId, reason, { signal });
  if (!snapshot) {
    if (documentRuntimeMetadata.has(tabId)) throw new Error("活动编辑器会话不可用，已阻止使用旧正文。");
    if (!appStore.tabs.includes(expectedTab)
      || expectedTab.id !== tabId
      || documentSessionForTab(tabId) !== expectedSession) {
      throw new Error("快照对应的标签页或编辑器会话已被替换。");
    }
    return { markdown: expectedTab.content };
  }
  if (!appStore.tabs.includes(expectedTab)
    || expectedTab.id !== tabId
    || documentSessionForTab(tabId) !== expectedSession) {
    throw new Error("快照对应的标签页或编辑器会话已被替换。");
  }
  const currentSession = documentSessionForTab(tabId);
  if (currentSession && currentSession.revision !== snapshot.revision) {
    throw new Error("快照返回后文档版本已变化，已阻止提交旧正文。");
  }
  const currentToken = currentSession?.mutationToken?.();
  if (snapshot.mutationToken
    && (!currentToken || !documentMutationTokensEqual(currentToken, snapshot.mutationToken))) {
    throw new Error("快照返回后文档 token 已变化，已阻止提交旧正文。");
  }
  return {
    markdown: commitDocumentSnapshot(snapshot, expectedTab),
    flushReceipt: snapshot.flushReceipt,
  };
}

function commitDocumentSnapshot(snapshot: MarkdownSnapshot, expectedTab: DocumentTab) {
  const tabId = snapshot.tabId;
  const tab = expectedTab;
  if (!appStore.tabs.includes(tab) || tab.id !== tabId) throw new Error("快照对应的标签页已不存在。");
  const session = documentSessionForTab(tabId);
  if (session && session.revision !== snapshot.revision) {
    throw new Error("提交快照时文档版本已变化。");
  }
  const currentToken = session?.mutationToken?.();
  if (snapshot.mutationToken
    && (!currentToken || !documentMutationTokensEqual(currentToken, snapshot.mutationToken))) {
    throw new Error("提交快照时文档 token 已变化。");
  }
  tab.content = snapshot.markdown;
  tab.isDirty = snapshot.dirty;
  if (tab.id === appStore.activeTabId) {
    appStore.currentContent = snapshot.markdown;
    appStore.isDirty = snapshot.dirty;
  }
  scheduleWikiIndexEntryRefresh(tab.path, snapshot.markdown);
  scheduleKnowledgeRefresh();
  const runtime = documentRuntimeMetadata.get(tabId);
  if (tab.path && appStore.workspaceIndexReady) {
    const view = currentWorkspaceView();
    void workspaceIndexClient.updateOpenDocument(
      tab.path,
      documentRuntimeIdentity(tab.id).epoch,
      runtime?.revision ?? snapshot.revision,
      snapshot.markdown,
    ).then((status) => applyRustWorkspaceIndexStatus(status, view)).catch((error) => {
      if (ownsWorkspace(view)) appStore.wikiIndexError = `Rust 工作区索引更新失败：${error}`;
    });
  }
  return snapshot.markdown;
}

export async function flushPaneDocumentSnapshot(paneId: EditorPaneId, reason: SnapshotReason) {
  const tab = getPaneTab(paneId);
  return tab ? flushDocumentSnapshot(tab.id, reason) : "";
}

export function getPaneTab(paneId: EditorPaneId) {
  const id = paneTabId(appStore.splitLayout, paneId);
  return appStore.tabs.find((tab) => tab.id === id) ?? null;
}

/** Capture the raw tab/pane/session tuple used by every large-file IPC call. */
export function captureLargeSessionIdentity(paneId: EditorPaneId = appStore.splitLayout.activePaneId) {
  const candidate = getPaneTab(paneId);
  const tab = candidate ? toRaw(candidate) as DocumentTab : null;
  const largeFile = tab?.largeFile ? toRaw(tab.largeFile) as LargeFileState : null;
  if (!tab || tab.documentMode !== "large" || !largeFile) return null;
  return {
    tab,
    tabId: tab.id,
    paneId,
    sessionId: largeFile.sessionId,
    sessionIdentity: largeFile,
    editorIdentity: documentSessionForTab(tab.id),
    revision: largeFile.revision,
    coordinateSpace: largeFile.coordinateSpace,
  } satisfies LargeSessionIdentity;
}

function currentLargeSessionIdentity(identity: LargeSessionIdentity) {
  const paneCurrent = captureLargeSessionIdentity(identity.paneId);
  if (paneCurrent?.tab === identity.tab
    && paneCurrent.tabId === identity.tabId
    && paneCurrent.sessionId === identity.sessionId) {
    return { ...paneCurrent, paneId: identity.paneId };
  }
  const tabCurrent = appStore.tabs
    .map((item) => toRaw(item) as DocumentTab)
    .find((item) => item === identity.tab);
  const largeFile = tabCurrent?.largeFile ? toRaw(tabCurrent.largeFile) as LargeFileState : null;
  if (!tabCurrent || tabCurrent.documentMode !== "large" || !largeFile) return null;
  if (tabCurrent.id !== identity.tabId || largeFile.sessionId !== identity.sessionId) return null;
  return {
    tab: tabCurrent,
    tabId: tabCurrent.id,
    paneId: identity.paneId,
    sessionId: largeFile.sessionId,
    sessionIdentity: largeFile,
    editorIdentity: documentSessionForTab(tabCurrent.id),
    revision: largeFile.revision,
    coordinateSpace: largeFile.coordinateSpace,
  } satisfies LargeSessionIdentity;
}

function largeTabObjectStillCurrent(identity: LargeSessionIdentity) {
  const current = currentLargeSessionIdentity(identity);
  return current
    && current.tab === identity.tab
    && current.sessionId === identity.sessionId
    && current.sessionIdentity === identity.sessionIdentity
    ? current
    : null;
}

function largeViewIdentityStillCurrent(identity: LargeSessionIdentity) {
  const current = captureLargeSessionIdentity(identity.paneId);
  return current
    && current.tab === identity.tab
    && current.tabId === identity.tabId
    && current.sessionId === identity.sessionId
    && current.sessionIdentity === identity.sessionIdentity
    && current.editorIdentity === identity.editorIdentity
    ? current
    : null;
}

function largeQueueFor(tab: DocumentTab) {
  let queue = largeQueues.get(tab);
  if (!queue) {
    queue = new LargeOperationQueue();
    largeQueues.set(tab, queue);
  }
  return queue;
}

function initializeLargeSession(tab: DocumentTab) {
  if (!tab.largeFile) return;
  largeOutboxes.set(tab, []);
  largeRemotePendingCounts.set(tab, tab.largeFile.pendingEditCount);
  largeQueueFor(tab);
  syncLargeOutboxProjection(tab);
}

function largeOutboxFor(tab: DocumentTab) {
  let outbox = largeOutboxes.get(tab);
  if (!outbox) {
    outbox = [];
    largeOutboxes.set(tab, outbox);
  }
  return outbox;
}

function largeBackendPendingCount(tab: DocumentTab) {
  return largeRemotePendingCounts.get(tab) ?? tab.largeFile?.pendingEditCount ?? 0;
}

function syncLargeOutboxProjection(tab: DocumentTab) {
  // IPC identities and outbox keys stay raw; UI writes use Vue's canonical
  // proxy for that same object, including when a captured tab is inactive.
  const projection = reactive(tab);
  const largeFile = projection.largeFile;
  if (!largeFile) return;
  const outbox = largeOutboxFor(tab);
  largeFile.pendingEdits = outbox.flatMap((batch) => batch.edits.map((edit) => ({ ...edit })));
  largeFile.pendingEditCount = largeBackendPendingCount(tab) + largeFile.pendingEdits.length;
  largeFile.targetPath = largeFile.targetPath === undefined ? tab.path || null : largeFile.targetPath;
  projection.isDirty = largeFile.targetPath === null
    || largeFile.pendingEditCount > 0
    || largeFile.revision !== largeFile.savedRevision
    || documentSessionForTab(tab.id)?.hasPendingEdits?.() === true;
  if (tab.id === appStore.activeTabId && toRaw(appStore.largeFile) === toRaw(largeFile)) {
    appStore.isDirty = tab.isDirty;
    appStore.saveState = tab.isDirty ? "dirty" : "saved";
  }
}

function setLargeBackendState(tab: DocumentTab, state: DirtyState) {
  const largeFile = reactive(tab).largeFile;
  if (!largeFile) return;
  assertLargeStateReceipt(state, largeFile);
  largeRemotePendingCounts.set(tab, state.pendingEditCount);
  largeFile.revision = state.revision;
  largeFile.savedRevision = state.savedRevision;
  largeFile.coordinateSpace = state.coordinateSpace;
  const totalLines = (state as DirtyState & { totalLines?: number }).totalLines;
  if (totalLines !== undefined) largeFile.totalLines = totalLines;
  syncLargeOutboxProjection(tab);
}

export function getPaneEditorMode(paneId: EditorPaneId) {
  const tab = getPaneTab(paneId);
  return tab?.documentMode === "large" ? "source" : tab?.editorMode ?? appStore.editorMode;
}

export function getPaneDocumentMode(paneId: EditorPaneId) {
  return getPaneTab(paneId)?.documentMode ?? appStore.documentMode;
}

export function getPaneContent(paneId: EditorPaneId) {
  return getPaneTab(paneId)?.content ?? "";
}

export function updatePanePosition(paneId: EditorPaneId, position: EditorPositionSnapshot) {
  appStore.paneContextLines[paneId] = Math.max(0, position.markdownLine - 1);
  const tab = getPaneTab(paneId);
  if (!tab || tab.kind !== "normal") return;
  const next = mergeEditorPosition(tab.position, position, tab.content.length);
  tab.position = next;
  if (paneId === appStore.splitLayout.activePaneId || tab.id === appStore.activeTabId) {
    appStore.pendingEditorPosition = next;
  }
}

export function updatePaneOutlineAnchor(
  paneId: EditorPaneId,
  line: number,
  source: "selection" | "scroll" | "navigation",
) {
  appStore.paneOutlineAnchorLines[paneId] = Math.max(0, Math.floor(Number.isFinite(line) ? line : 0));
  appStore.paneOutlineAnchorSources[paneId] = source;
}

export function updateLargeFileViewportLine(paneId: EditorPaneId, line: number) {
  appStore.largeFileViewportLines[paneId] = Math.max(0, Math.floor(Number.isFinite(line) ? line : 0));
  updatePaneOutlineAnchor(paneId, line, "scroll");
}

export function getPaneStructuredOutline(paneId: EditorPaneId): StructuredOutlineItem[] {
  const tab = getPaneTab(paneId);
  if (!tab) return [];
  if (tab.documentMode === "large") {
    return structureOutline(tab.largeFile?.outline ?? [], tab.largeFile?.totalLines ?? 1);
  }
  const runtimeOutline = appStore.runtimeDerivedByTab[tab.id]?.outline;
  if (runtimeOutline) return runtimeOutline;
  const content = tab.content;
  return structureOutline(extractOutlineWithLines(content), content.split(/\r?\n/).length);
}

export function reconcilePaneCollapsedHeadings(paneId: EditorPaneId) {
  const tab = getPaneTab(paneId);
  if (!tab) return;
  const outline = getPaneStructuredOutline(paneId);
  tab.collapsedOutlineKeys = reconcileCollapsedKeys(outline, tab.collapsedOutlineKeys);
  tab.collapsedHeadingKeys = reconcileCollapsedKeys(outline, tab.collapsedHeadingKeys);
}

export function togglePaneOutlineFold(paneId: EditorPaneId, key: string) {
  const tab = getPaneTab(paneId);
  const item = getPaneStructuredOutline(paneId).find((candidate) => candidate.key === key);
  if (!tab || !item?.hasChildren) return;
  const collapsed = new Set(tab.collapsedOutlineKeys);
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  tab.collapsedOutlineKeys = Array.from(collapsed);
  void persistConfig();
}

export function revealPaneOutlineKey(paneId: EditorPaneId, key: string) {
  const tab = getPaneTab(paneId);
  const item = getPaneStructuredOutline(paneId).find((candidate) => candidate.key === key);
  if (!tab || !item) return;
  const ancestors = new Set(item.ancestorKeys);
  const next = tab.collapsedOutlineKeys.filter((collapsedKey) => !ancestors.has(collapsedKey));
  if (next.length === tab.collapsedOutlineKeys.length) return;
  tab.collapsedOutlineKeys = next;
  void persistConfig();
}

export function setAllPaneOutlineFolds(paneId: EditorPaneId, collapsed: boolean) {
  const tab = getPaneTab(paneId);
  if (!tab) return;
  tab.collapsedOutlineKeys = collapsed
    ? getPaneStructuredOutline(paneId).filter((item) => item.hasChildren).map((item) => item.key)
    : [];
  void persistConfig();
}

export function revealHeadingAtLine(paneId: EditorPaneId, line: number) {
  const tab = getPaneTab(paneId);
  if (!tab || tab.documentMode !== "normal") return;
  const outline = getPaneStructuredOutline(paneId);
  const targetLine = Math.max(0, Math.floor(line));
  const containingKeys = new Set(
    outline
      .filter((item) => item.line <= targetLine && targetLine < item.sectionEndLine)
      .map((item) => item.key),
  );
  const next = tab.collapsedHeadingKeys.filter((key) => !containingKeys.has(key));
  if (next.length === tab.collapsedHeadingKeys.length) return;
  tab.collapsedHeadingKeys = next;
  window.dispatchEvent(new CustomEvent("lightmark:heading-folds-changed", { detail: { paneId } }));
  void persistConfig();
}

export function toggleCurrentHeadingFold() {
  const paneId = appStore.splitLayout.activePaneId;
  const tab = getPaneTab(paneId);
  if (!tab) {
    appStore.statusMessage = "请先打开一个文档。";
    return;
  }
  if (tab.documentMode === "large") {
    appStore.statusMessage = "大文件模式暂不支持正文标题折叠。";
    return;
  }
  const outline = getPaneStructuredOutline(paneId);
  const item = resolveHeadingSection(outline, appStore.paneOutlineAnchorLines[paneId]);
  if (!item || item.sectionEndLine <= item.line + 1) {
    appStore.statusMessage = item ? "当前标题下没有可折叠的正文。" : "光标不在标题章节中。";
    return;
  }
  const collapsed = new Set(tab.collapsedHeadingKeys);
  const collapsing = !collapsed.has(item.key);
  if (collapsing) collapsed.add(item.key);
  else collapsed.delete(item.key);
  tab.collapsedHeadingKeys = Array.from(collapsed);
  window.dispatchEvent(new CustomEvent("lightmark:heading-folds-changed", { detail: { paneId } }));
  appStore.statusMessage = `${collapsing ? "已折叠" : "已展开"}：${item.text}`;
  void persistConfig();
}

export function toggleHeadingFoldByKey(paneId: EditorPaneId, key: string) {
  const tab = getPaneTab(paneId);
  const item = getPaneStructuredOutline(paneId).find((candidate) => candidate.key === key);
  if (!tab || tab.documentMode !== "normal" || !item || item.sectionEndLine <= item.line + 1) return;
  const collapsed = new Set(tab.collapsedHeadingKeys);
  const collapsing = !collapsed.has(key);
  if (collapsing) collapsed.add(key);
  else collapsed.delete(key);
  tab.collapsedHeadingKeys = Array.from(collapsed);
  window.dispatchEvent(new CustomEvent("lightmark:heading-folds-changed", { detail: { paneId } }));
  appStore.statusMessage = `${collapsing ? "已折叠" : "已展开"}：${item.text}`;
  void persistConfig();
}

export function expandAllHeadingFolds() {
  const paneId = appStore.splitLayout.activePaneId;
  const tab = getPaneTab(paneId);
  if (!tab) {
    appStore.statusMessage = "请先打开一个文档。";
    return;
  }
  if (tab.documentMode === "large") {
    appStore.statusMessage = "大文件模式暂不支持正文标题折叠。";
    return;
  }
  tab.collapsedHeadingKeys = [];
  window.dispatchEvent(new CustomEvent("lightmark:heading-folds-changed", { detail: { paneId } }));
  appStore.statusMessage = "已展开当前文档全部标题。";
  void persistConfig();
}

export function getPanePendingModeCursor(paneId: EditorPaneId) {
  return getPaneTab(paneId)?.pendingModeCursor ?? null;
}

export function setPanePendingModeCursor(paneId: EditorPaneId, cursor: PendingModeCursor | null) {
  const tab = getPaneTab(paneId);
  if (tab) tab.pendingModeCursor = cursor;
  if (paneId === appStore.splitLayout.activePaneId || tab?.id === appStore.activeTabId) {
    appStore.pendingModeCursor = cursor;
  }
}

export function consumePanePendingEditorPosition(paneId: EditorPaneId, mode: EditorMode) {
  const tab = getPaneTab(paneId);
  const position = tab?.position;
  if (!position || position.editorMode !== mode) return null;
  return position;
}

export function syncActivePaneProjection() {
  const tab = getPaneTab(appStore.splitLayout.activePaneId) ?? getActiveTab();
  if (tab) projectTab(tab);
}

export function updateActiveTabPosition(position: EditorPositionSnapshot) {
  if (appStore.documentMode !== "normal") return;
  const tab = getActiveTab();
  if (!tab || tab.kind !== "normal") return;
  const next = mergeEditorPosition(tab.position, position, appStore.currentContent.length);
  tab.position = next;
  appStore.pendingEditorPosition = next;
}

export function consumePendingEditorPosition(mode: EditorMode) {
  const position = appStore.pendingEditorPosition;
  if (!position || position.editorMode !== mode) return null;
  appStore.pendingEditorPosition = null;
  return position;
}

let configLoadPromise: Promise<void> | null = null;
let configPersistenceReady = false;
let configWriteTail: Promise<void> = Promise.resolve();
export function loadConfig() {
  // Bootstrap is a single application generation. A second caller must not
  // reset tabs after an early file-open command has already created one.
  return configLoadPromise ??= readConfigState().finally(ensureDefaultTab);
}

async function readConfigState() {
  try {
    await restoreConfigState();
    configPersistenceReady = true;
  } catch (error) {
    appStore.configPersistenceMessage = "设置未能载入，本次更改仅保存在内存中，仍可编辑和保存文档。关闭应用后可检查配置目录中的 config.json 和 config.previous.json。";
    throw new Error(`${appStore.configPersistenceMessage} ${error}`);
  }
}

async function restoreConfigState() {
  const initialWorkspace = currentWorkspaceView();
  const config = await invoke<AppConfig>("read_app_config");
  appStore.recentFiles = config.recentFiles ?? [];
  appStore.settings = normalizeSettings(config);
  appStore.theme = appStore.settings.appearance.theme;
  resetOpenDocument();
  appStore.tabs = [];
  appStore.activeTabId = "";
  appStore.splitLayout = defaultSplitLayout();
  if (shouldRestoreSession(config)) {
    if (config.session?.workspacePath && ownsWorkspace(initialWorkspace) && !initialWorkspace.root) {
      const restored = selectWorkspace(config.session.workspacePath);
      try {
        await refreshFileTree();
      } catch {
        if (ownsWorkspace(restored)) selectWorkspace("");
      }
    }
    await restoreSession(config.session);
  }
}

export function persistConfig(): Promise<void> {
  // Startup creates an untitled tab even when reading config failed. Its
  // session defaults are never authorization to overwrite the old profile.
  if (!configPersistenceReady) return Promise.resolve();
  syncActiveTabFromProjection();
  const config: AppConfig = {
    recentFiles: appStore.recentFiles,
    settings: appStore.settings,
    session: buildSessionRestoreState(),
  };
  // Vue state may change while an earlier disk write is outstanding.
  const frozen: AppConfig = JSON.parse(JSON.stringify(config));
  const write = configWriteTail.then(async () => {
    await invoke("write_app_config", { config: frozen });
    appStore.configPersistenceMessage = "";
  });
  configWriteTail = write.catch(error => {
    appStore.configPersistenceMessage = `设置与会话尚未保存：${error}`;
  });
  return write;
}

export async function flushPendingConfigWrites() {
  let pending: Promise<void>;
  do {
    pending = configWriteTail;
    await pending;
  } while (pending !== configWriteTail);
}

function selectWorkspace(root: string): WorkspaceView {
  ++workspaceEpoch;
  ++backlinkRefreshGeneration;
  clearWorkspaceRefreshTimer();
  wikiIndexHydrationPromise = null;
  appStore.currentWorkspace = root;
  appStore.fileTree = [];
  appStore.wikiIndex = createWikiWorkspaceIndex([], root);
  appStore.workspaceIndexReady = false;
  appStore.workspaceIndexGeneration = 0;
  appStore.workspaceIndexTags = [];
  appStore.wikiIndexBusy = false;
  appStore.wikiIndexError = "";
  appStore.wikiBacklinks = [];
  appStore.wikiBacklinksForPath = "";
  appStore.wikiUnlinkedMentions = [];
  appStore.wikiMentionsForPath = "";
  appStore.wikiBacklinksBusy = false;
  appStore.wikiBacklinksError = "";
  return currentWorkspaceView();
}

async function readWorkspaceTree(view: WorkspaceView) {
  const request = ++treeRequest;
  if (!view.root) return false;
  try {
    const tree = await invoke<FileNode[]>("list_markdown_files", { folder: view.root });
    if (!ownsWorkspace(view) || request !== treeRequest) return false;
    appStore.fileTree = tree;
    appStore.wikiIndex = createWikiWorkspaceIndex(tree, view.root);
    return true;
  } catch (error) {
    if (!ownsWorkspace(view) || request !== treeRequest) return false;
    throw error;
  }
}

export async function refreshFileTree() {
  const view = currentWorkspaceView();
  await readWorkspaceTree(view);
  if (!view.root || !ownsWorkspace(view)) return;
  appStore.wikiIndexError = "";
  const hydration = hydrateRustWorkspaceIndex(view).catch((error) => {
    if (!ownsWorkspace(view) || wikiIndexHydrationPromise !== hydration) return;
    appStore.workspaceIndexReady = false;
    appStore.wikiIndexBusy = false;
    appStore.wikiIndexError = `Rust 工作区索引不可用：${error}`;
  });
  wikiIndexHydrationPromise = hydration;
  void hydration.finally(() => {
    if (wikiIndexHydrationPromise === hydration) wikiIndexHydrationPromise = null;
  });
}

async function hydrateRustWorkspaceIndex(view: WorkspaceView) {
  appStore.wikiIndexBusy = true;
  // Rust has one active index. Order root-changing commands, not the
  // potentially long rebuild or polling of a previous workspace.
  const opened = indexOpenTail.then(() => ownsWorkspace(view) ? workspaceIndexClient.open(view.root) : null);
  indexOpenTail = opened.then(() => {}, () => {});
  let status = await opened;
  if (!status || !ownsWorkspace(view)) return;
  const delays = [100, 250, 500];
  let poll = 0;
  const generation = status.generation;
  while (status.busy && isSamePath(status.root, view.root) && status.generation === generation) {
    await new Promise((resolve) => window.setTimeout(resolve, delays[Math.min(poll, delays.length - 1)]));
    if (!ownsWorkspace(view)) return;
    status = await workspaceIndexClient.status();
    if (!ownsWorkspace(view)) return;
    poll += 1;
  }
  if (!isSamePath(status.root, view.root) || status.generation !== generation) return;
  if (status.error) throw new Error(status.error);
  await applyRustWorkspaceIndexStatus(status, view);
}

async function applyRustWorkspaceIndexStatus(status: WorkspaceIndexStatus, view: WorkspaceView) {
  if (!ownsWorkspace(view) || !isSamePath(status.root, view.root) || status.busy) return;
  const tags = await workspaceIndexClient.tags();
  if (!ownsWorkspace(view) || tags.generation !== status.generation || status.generation < appStore.workspaceIndexGeneration) return;
  const byPath = new Map(appStore.wikiIndex.entries.map((entry) => [normalizePathKey(entry.path), entry]));
  for (const candidate of status.candidates) {
    const entry = byPath.get(normalizePathKey(candidate.path));
    if (!entry) continue;
    entry.aliases = candidate.aliases;
    entry.normalizedAliases = candidate.aliases.map((alias) => alias.trim().toLocaleLowerCase());
    entry.indexed = true;
  }
  appStore.workspaceIndexTags = tags.data;
  appStore.workspaceIndexGeneration = status.generation;
  appStore.workspaceIndexReady = true;
  appStore.wikiIndexBusy = false;
}

function scheduleWikiIndexEntryRefresh(path: string, _content: string) {
  if (!path || typeof window === "undefined") return;
  scheduleKnowledgeRefresh();
}

export async function openWorkspace(folder?: string) {
  const request = ++workspaceSelectionRequest;
  const selected = folder ?? (await invoke<string | null>("open_folder_dialog"));
  if (!selected || request !== workspaceSelectionRequest) return;
  const view = selectWorkspace(selected);
  await Promise.all([refreshFileTree(), syncWorkspaceKnowledgeWatch()]);
  if (!ownsWorkspace(view)) return;
  void refreshKnowledge();
  await persistConfig();
}

export async function refreshKnowledgeIndex() {
  await refreshFileTree();
  void refreshKnowledge();
}

function queueWorkspaceWatch(view: WorkspaceView, enable: boolean) {
  workspaceWatchTail = workspaceWatchTail.then(async () => {
    if (!ownsWorkspace(view)) return;
    await invoke("unwatch_markdown_workspace").catch(() => {});
    if (!enable || !view.root || !ownsWorkspace(view)) return;
    await invoke("watch_markdown_workspace", { path: view.root, epoch: view.epoch }).catch((error) => {
      if (ownsWorkspace(view)) appStore.wikiIndexError = `工作区监听不可用：${error}`;
    });
  });
  return workspaceWatchTail;
}

export function syncWorkspaceKnowledgeWatch() {
  return queueWorkspaceWatch(currentWorkspaceView(), true);
}

function clearWorkspaceRefreshTimer() {
  if (workspaceKnowledgeRefreshTimer && typeof window !== "undefined") {
    window.clearTimeout(workspaceKnowledgeRefreshTimer);
    workspaceKnowledgeRefreshTimer = 0;
  }
  workspaceKnowledgePendingPaths.clear();
}

export function stopWorkspaceKnowledgeWatch() {
  clearWorkspaceRefreshTimer();
  return queueWorkspaceWatch(currentWorkspaceView(), false);
}

export function scheduleWorkspaceKnowledgeRefresh(paths: string[], view: WorkspaceView) {
  if (!ownsWorkspace(view) || !view.root || typeof window === "undefined") return;
  for (const path of paths) {
    if (isMarkdownFilePath(path)) workspaceKnowledgePendingPaths.add(path);
  }
  if (workspaceKnowledgeRefreshTimer) window.clearTimeout(workspaceKnowledgeRefreshTimer);
  workspaceKnowledgeRefreshTimer = window.setTimeout(() => {
    workspaceKnowledgeRefreshTimer = 0;
    const pendingPaths = [...workspaceKnowledgePendingPaths];
    workspaceKnowledgePendingPaths.clear();
    void refreshChangedKnowledgePaths(pendingPaths, view);
  }, 250);
}

async function refreshChangedKnowledgePaths(_paths: string[], view: WorkspaceView) {
  if (!ownsWorkspace(view)) return;
  appStore.wikiIndexBusy = true;
  appStore.wikiIndexError = "";
  try {
    if (!await readWorkspaceTree(view) || !ownsWorkspace(view)) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    if (!ownsWorkspace(view)) return;
    const status = await workspaceIndexClient.status();
    if (!ownsWorkspace(view) || !isSamePath(status.root, view.root)) return;
    if (status.error) throw new Error(status.error);
    await applyRustWorkspaceIndexStatus(status, view);
    if (ownsWorkspace(view)) scheduleKnowledgeRefresh();
  } catch (error) {
    if (ownsWorkspace(view)) appStore.wikiIndexError = String(error);
  } finally {
    if (ownsWorkspace(view) && !wikiIndexHydrationPromise) appStore.wikiIndexBusy = false;
  }
}

export async function openFile(path?: string, options: { recordNavigation?: boolean; paneId?: EditorPaneId } = {}) {
  const requestedPaneId = options.paneId ?? appStore.splitLayout.activePaneId;
  if (typeof document !== 'undefined') {
    // An OS/file command can precede App.onMounted. Start, rather than merely
    // observe, the shared bootstrap before capturing a pane activation fence.
    await loadConfig().catch(error => { appStore.statusMessage = String(error); });
    await nextTick();
  }
  const selected = path ?? (await invoke<string | null>("open_file_dialog"));
  if (!selected) return;
  const paneId = requestedPaneId;
  const activation = await preparePaneActivation(paneId, "tabSwitch");
  if (!activation) return false;
  const shouldRecordNavigation = options.recordNavigation !== false;
  if (shouldRecordNavigation) {
    recordCurrentNavigationBeforeOpening(selected);
  }
  await flushCurrentDraft();
  if (!paneActivationFenceStillCurrent(activation.fence, activation.flushed)) {
    appStore.statusMessage = "打开文件期间当前标签页或编辑器会话发生了变化，已保留当前输入。";
    return false;
  }
  syncActiveTabFromProjection();
  const existing = findFileTab(selected);
  if (existing) {
    await activateTabInPane(paneId, existing.id);
    await checkDraftForOpenedFile(selected);
    void syncExternalFileWatches();
    await persistConfig();
    return;
  }
  const info = await invoke<FileInfo>("get_file_info", { path: selected });
  if (!paneActivationFenceStillCurrent(activation.fence, activation.flushed)) {
    appStore.statusMessage = "打开文件期间当前标签页或编辑器会话发生了变化，已保留当前输入。";
    return false;
  }
  let tab: DocumentTab;
  if (info.isLarge) {
    const session = await invoke<LargeFileSession>("open_large_file", { path: selected });
    if (!paneActivationFenceStillCurrent(activation.fence, activation.flushed)) {
      await releaseOpenedLargeSession(session);
      appStore.statusMessage = "打开大文件期间当前标签页或编辑器会话发生了变化，已保留当前输入。";
      return false;
    }
    tab = createTab({
      path: selected,
      kind: "large",
      content: "",
      documentMode: "large",
      editorMode: "source",
      largeFile: {
        sessionId: session.sessionId,
        sizeBytes: session.sizeBytes,
        totalLines: session.totalLines,
        loadedRanges: [],
        pendingEdits: [],
        outline: session.outline,
        revision: session.revision,
        savedRevision: session.savedRevision,
        pendingEditCount: session.pendingEditCount,
        baseFingerprint: session.baseFingerprint,
        diskFingerprint: session.diskFingerprint,
        coordinateSpace: session.coordinateSpace,
        targetPath: session.targetPath !== undefined ? session.targetPath : session.path,
        originPath: session.originPath ?? session.path,
        recoveryDraftId: session.recoveryDraftId,
      },
      isDirty: false,
    });
    initializeLargeSession(tab);
    appStore.statusMessage = `大文件模式：${formatBytes(session.sizeBytes)}，${session.totalLines} 行`;
  } else {
    const snapshot = await readTextFileSnapshot(selected);
    if (!paneActivationFenceStillCurrent(activation.fence, activation.flushed)) {
      appStore.statusMessage = "打开文件期间当前标签页或编辑器会话发生了变化，已保留当前输入。";
      return false;
    }
    const content = snapshot.content;
    const fileSnapshot = fileSnapshotFromTextSnapshot(snapshot);
    tab = createTab({
      path: selected,
      kind: "normal",
      content,
      documentMode: "normal",
      editorMode: appStore.settings.editor.defaultMode,
      largeFile: null,
      isDirty: false,
      fileSnapshot,
    });
    appStore.statusMessage = "";
  }
  appStore.tabs.push(tab);
  projectTabInPane(tab, paneId);
  rememberRecentFile(selected);
  await checkDraftForOpenedFile(selected);
  void syncExternalFileWatches();
  void refreshBacklinks();
  await persistConfig();
}

/** Close a native large-file session that was opened before pane fencing failed. */
async function releaseOpenedLargeSession(session: LargeFileSession) {
  try {
    const receipt = await invoke<LargeCloseReceipt>("close_large_file", {
      sessionId: session.sessionId,
      expectedRevision: session.revision,
      coordinateSpace: session.coordinateSpace,
      disposition: "discard",
    });
    if (!receipt.closed) throw new Error("原生大文件会话未确认关闭。");
    if (receipt.cleanupWarning || receipt.recoveryArtifact) {
      appStore.statusMessage = formatTransactionNotice(
        "已释放未接入视图的大文件会话，但清理需处理",
        receipt.cleanupWarning,
        receipt.recoveryArtifact,
      );
    }
  } catch (error) {
    appStore.statusMessage = `释放未接入的大文件会话失败：${formatLargeTransactionEvidence(error)}`;
  }
}

export async function navigateToFilePath(path: string) {
  recordNavigationLocation();
  await openFile(path, { recordNavigation: false });
}

export async function navigateToKnowledgeOccurrence(item: UnlinkedMentionItem | BacklinkItem) {
  const from = "from" in item ? item.from : undefined;
  const to = "to" in item ? item.to : undefined;
  recordNavigationLocation();
  await openFile(item.sourcePath, { recordNavigation: false });
  dispatchKnowledgeOccurrence(item.sourcePath, item.line, from, to);
}

export async function convertUnlinkedMention(item: UnlinkedMentionItem) {
  recordNavigationLocation();
  await openFile(item.sourcePath, { recordNavigation: false });
  const paneId = appStore.splitLayout.activePaneId;
  const tab = getPaneTab(paneId);
  if (!tab || tab.kind !== "normal" || tab.documentMode === "large") {
    appStore.statusMessage = "大文件模式仅支持定位未链接提及。";
    dispatchKnowledgeOccurrence(item.sourcePath, item.line, item.from, item.to);
    return false;
  }
  const conversion = prepareUnlinkedMentionConversion(tab.content, item);
  if (conversion.status === "stale") {
    appStore.statusMessage = "该提及位置已经变化，知识索引已刷新，请重新选择。";
    scheduleWikiIndexEntryRefresh(tab.path, tab.content);
    return false;
  }
  const next = conversion.text;
  const lineCount = tab.content.split(/\r?\n/).length;
  const detail = {
    paneId,
    source: tab.content,
    result: {
      text: next,
      changed: true,
      stats: {
        changedLines: 1,
        trailingWhitespaceRemoved: 0,
        blankLinesRemoved: 0,
        listIndentationFixed: 0,
        tablesFormatted: 0,
      },
      lineMap: Array.from({ length: lineCount }, (_, index) => index),
    } satisfies MarkdownFormatResult,
    handled: false,
  };
  window.dispatchEvent(new CustomEvent("lightmark:apply-markdown-format", { detail }));
  if (!detail.handled) setPaneContent(paneId, next, true);
  scheduleWikiIndexEntryRefresh(tab.path, next);
  appStore.statusMessage = `已将“${item.text}”转为 Wiki Link，尚未保存。`;
  dispatchKnowledgeOccurrence(item.sourcePath, item.line, conversion.from, conversion.to);
  return true;
}

function dispatchKnowledgeOccurrence(path: string, line: number, from?: number, to?: number) {
  const detail = {
    path,
    paneId: appStore.splitLayout.activePaneId,
    line,
    from,
    to,
  };
  for (const delay of [0, 60, 160]) {
    window.setTimeout(() => {
      if (!isSamePath(appStore.currentFilePath, path)) return;
      window.dispatchEvent(new CustomEvent("lightmark:jump-knowledge-occurrence", { detail }));
    }, delay);
  }
}

export async function openFileInOtherPane(path?: string) {
  const sourcePaneId = appStore.splitLayout.activePaneId;
  const sourceActivation = await preparePaneActivation(sourcePaneId, "tabSwitch");
  if (!sourceActivation) return false;
  if (!appStore.splitLayout.enabled) {
    appStore.splitLayout = enableSplitLayout(appStore.splitLayout, tabIds());
  }
  if (!paneActivationFenceStillCurrent(sourceActivation.fence, sourceActivation.flushed)) {
    appStore.statusMessage = "打开到另一栏期间当前文档或编辑器会话发生了变化，已保留当前输入。";
    return false;
  }
  const paneId = otherPaneId(sourcePaneId);
  await openFile(path, { paneId });
}

export async function activateTabInOtherPane(tabId: string) {
  const sourcePaneId = appStore.splitLayout.activePaneId;
  const sourceActivation = await preparePaneActivation(sourcePaneId, "tabSwitch");
  if (!sourceActivation) return false;
  if (!appStore.splitLayout.enabled) {
    appStore.splitLayout = enableSplitLayout(appStore.splitLayout, tabIds());
  }
  if (!paneActivationFenceStillCurrent(sourceActivation.fence, sourceActivation.flushed)) {
    appStore.statusMessage = "打开到另一栏期间当前文档或编辑器会话发生了变化，已保留当前输入。";
    return false;
  }
  await activateTabInPane(otherPaneId(sourcePaneId), tabId);
}

export async function openWikiLink(target: WikiLinkTarget) {
  if (!appStore.currentWorkspace) {
    appStore.statusMessage = "请先打开工作区再使用 Wiki Links";
    return false;
  }
  if (appStore.wikiIndexBusy && wikiIndexHydrationPromise) await wikiIndexHydrationPromise;
  const resolution = resolveWikiLink(target, appStore.wikiIndex);
  if (resolution.path) {
    recordNavigationLocation();
    await openFile(resolution.path, { recordNavigation: false });
    if (resolution.status === "ambiguous") {
      appStore.statusMessage = `找到多个 “${target.page}”，已打开最接近的候选`;
    }
    scheduleWikiHeadingJump(target);
    return true;
  }

  const createdPath = await createWikiLinkTarget(target);
  if (!createdPath) return false;
  recordNavigationLocation();
  await openFile(createdPath, { recordNavigation: false });
  appStore.statusMessage = `已创建 Wiki 页面：${fileNameFromPath(createdPath)}`;
  return true;
}

export async function createWikiLinkTarget(target: WikiLinkTarget) {
  if (!appStore.currentWorkspace) {
    appStore.statusMessage = "请先打开工作区再创建 Wiki 页面";
    return null;
  }
  const name = wikiPageFileName(target);
  if (!name) {
    appStore.statusMessage = "当前 Wiki Link 名称不能自动创建文件";
    return null;
  }
  const path = await invoke<string>("create_markdown_file", {
    folder: appStore.currentWorkspace,
    name,
  });
  await refreshFileTree();
  return path;
}

export async function refreshBacklinks() {
  const generation = ++backlinkRefreshGeneration;
  if (!appStore.currentWorkspace || !appStore.currentFilePath) {
    appStore.wikiBacklinks = [];
    appStore.wikiBacklinksForPath = "";
    appStore.wikiBacklinksError = "";
    appStore.wikiBacklinksBusy = false;
    appStore.wikiUnlinkedMentions = [];
    appStore.wikiMentionsForPath = "";
    return;
  }
  const targetPath = appStore.currentFilePath;
  if (!isSamePath(appStore.wikiBacklinksForPath, targetPath)) {
    appStore.wikiBacklinks = [];
    appStore.wikiBacklinksForPath = targetPath;
  }
  syncActiveTabFromProjection();
  appStore.wikiBacklinksBusy = true;
  appStore.wikiBacklinksError = "";
  try {
    if (appStore.workspaceIndexReady) {
      const expectedGeneration = appStore.workspaceIndexGeneration;
      const [backlinks, mentions] = await Promise.all([
        workspaceIndexClient.backlinks(targetPath),
        workspaceIndexClient.mentions(targetPath),
      ]);
      const expectedRevision = documentRuntimeMetadata.get(appStore.activeTabId)?.revision;
      if (backlinks.generation !== expectedGeneration || mentions.generation !== expectedGeneration) return;
      if (expectedRevision != null && (backlinks.documentRevision ?? expectedRevision) !== expectedRevision) return;
      if (expectedGeneration !== appStore.workspaceIndexGeneration || generation !== backlinkRefreshGeneration || !isSamePath(appStore.currentFilePath, targetPath)) return;
      appStore.wikiBacklinks = backlinks.data;
      appStore.wikiUnlinkedMentions = mentions.data;
      appStore.wikiMentionsForPath = targetPath;
      return;
    }
    if (wikiIndexHydrationPromise) await wikiIndexHydrationPromise;
    if (!appStore.workspaceIndexReady) throw new Error(appStore.wikiIndexError || "工作区索引仍在构建中，请稍后重试。");
  } catch (error) {
    if (generation !== backlinkRefreshGeneration) return;
    appStore.wikiBacklinks = [];
    appStore.wikiUnlinkedMentions = [];
    appStore.wikiBacklinksError = String(error);
  } finally {
    if (generation === backlinkRefreshGeneration) appStore.wikiBacklinksBusy = false;
  }
}

export async function refreshKnowledge() {
  await refreshBacklinks();
}

function scheduleKnowledgeRefresh() {
  if (!appStore.currentWorkspace || !appStore.currentFilePath || typeof window === "undefined") return;
  if (backlinkRefreshTimer) window.clearTimeout(backlinkRefreshTimer);
  backlinkRefreshTimer = window.setTimeout(() => {
    backlinkRefreshTimer = 0;
    void refreshKnowledge();
  }, 250);
}

export function openQuickOpen() {
  closeTransientPalettes("quickOpen");
  appStore.quickOpenQuery = "";
  appStore.quickOpenActiveIndex = 0;
  appStore.quickOpenOpen = true;
}

export function closeQuickOpen() {
  appStore.quickOpenOpen = false;
}

export function openHeadingJump() {
  closeTransientPalettes("headingJump");
  appStore.headingJumpQuery = "";
  appStore.headingJumpActiveIndex = 0;
  appStore.headingJumpOpen = true;
}

export function closeHeadingJump() {
  appStore.headingJumpOpen = false;
}

export function openGoToLine() {
  closeTransientPalettes("goToLine");
  appStore.goToLineOpen = true;
}

export function closeGoToLine() {
  appStore.goToLineOpen = false;
}

export function openCommandPalette() {
  const capture: { target: CapturedEditorTarget | null } = { target: null };
  window.dispatchEvent(new CustomEvent("lightmark:capture-editor-target", { detail: capture }));
  appStore.capturedEditorTarget = capture.target;
  closeTransientPalettes("commandPalette");
  appStore.commandPaletteOpen = true;
}

export function closeCommandPalette() {
  appStore.commandPaletteOpen = false;
}

export function insertSnippetById(snippetId: string) {
  const snippet = appStore.settings.snippets.items.find((item) => item.id === snippetId && item.enabled);
  const target = appStore.capturedEditorTarget;
  const tab = target ? getPaneTab(target.paneId) : null;
  if (!snippet || !target || !tab || tab.id !== target.tabId || tab.documentMode !== target.documentMode) {
    appStore.statusMessage = "插入位置已经变化，请重新打开命令面板。";
    return false;
  }
  window.dispatchEvent(new CustomEvent("lightmark:insert-snippet", { detail: { snippetId, target } }));
  return true;
}

export function openFormulaJump() {
  if (appStore.documentMode === "large") {
    appStore.statusMessage = "大文件模式暂不支持公式索引与导航";
    return;
  }
  closeTransientPalettes();
  appStore.formulaJumpQuery = "";
  appStore.formulaJumpActiveIndex = 0;
  appStore.formulaJumpOpen = true;
}

export function closeFormulaJump() {
  appStore.formulaJumpOpen = false;
}

function closeTransientPalettes(except?: "quickOpen" | "headingJump" | "goToLine" | "commandPalette" | "formulaJump") {
  if (except !== "quickOpen") appStore.quickOpenOpen = false;
  if (except !== "headingJump") appStore.headingJumpOpen = false;
  if (except !== "goToLine") appStore.goToLineOpen = false;
  if (except !== "commandPalette") appStore.commandPaletteOpen = false;
  if (except !== "formulaJump") appStore.formulaJumpOpen = false;
  window.dispatchEvent(new CustomEvent("lightmark:close-transient-editor-ui"));
}

export function recordNavigationLocation(location?: Partial<NavigationLocation>) {
  const current = currentNavigationLocation(location);
  if (!current) return;
  pushNavigationLocation(appStore.navigationBackStack, current);
  appStore.navigationForwardStack = [];
}

export async function goBackNavigation() {
  const target = appStore.navigationBackStack.pop();
  if (!target) {
    appStore.statusMessage = "没有可后退的位置";
    return false;
  }
  const current = currentNavigationLocation();
  try {
    await openFile(target.path, { recordNavigation: false, paneId: target.paneId });
    requestEditorPositionRestore(target.position);
    if (current) pushNavigationLocation(appStore.navigationForwardStack, current);
    appStore.statusMessage = "";
    return true;
  } catch (error) {
    appStore.navigationBackStack.push(target);
    appStore.statusMessage = `无法后退到上一个位置：${error}`;
    return false;
  }
}

export async function goForwardNavigation() {
  const target = appStore.navigationForwardStack.pop();
  if (!target) {
    appStore.statusMessage = "没有可前进的位置";
    return false;
  }
  const current = currentNavigationLocation();
  try {
    await openFile(target.path, { recordNavigation: false, paneId: target.paneId });
    requestEditorPositionRestore(target.position);
    if (current) pushNavigationLocation(appStore.navigationBackStack, current);
    appStore.statusMessage = "";
    return true;
  } catch (error) {
    appStore.navigationForwardStack.push(target);
    appStore.statusMessage = `无法前进到下一个位置：${error}`;
    return false;
  }
}

export async function saveCurrentFile() {
  syncActiveTabFromProjection();
  const context = captureSaveContext();
  if (!context) return false;
  if (context.kind === "large") {
    const paneId = appStore.splitLayout.activePaneId;
    return await saveLargeFileForTab(context.tab, paneId);
  }
  return saveTransactionQueue.enqueue(context.tab, () => runSaveTransaction(context));
}

async function runSaveTransaction(context: SaveContext) {
  setCapturedSaveState(context, "saving");
  try {
    const saved = await saveNormalFileForContext(context);
    if (isCapturedTabActive(context)) {
      const dirty = tabHasUnsavedWork(context.tab);
      appStore.saveState = saved ? "saved" : dirty ? "dirty" : "saved";
      appStore.isDirty = dirty;
    }
    return saved;
  } catch (error) {
    publishSaveNotice(context.tabId, "failure", formatLargeTransactionEvidence(error));
    if (isCapturedTabActive(context)) appStore.saveState = "failed";
    throw error;
  }
}

async function flushLargePendingInputForTab(tab: DocumentTab, reason: SnapshotReason) {
  const session = documentSessionForTab(tab.id);
  if (!session) return null;
  const expectedSession = session;
  const result = await flushDocumentSessionPendingEdits(tab.id, reason);
  if (!result || result.session !== expectedSession || !isTabRegistered(tab)) {
    throw new LargeSessionStaleError("大文件输入 flush 期间编辑器会话已变化。");
  }
  return result;
}

/** Flush the editor mounted in a pane before that pane is projected to a new tab. */
export type PaneFlushResult = Pick<DocumentSessionFlushResult, "session" | "afterRevision" | "afterToken">;

async function flushPanePendingEdits(paneId: EditorPaneId, reason: SnapshotReason): Promise<PaneFlushResult | null> {
  const tab = getPaneTab(paneId);
  if (!tab) return null;
  if (tab.documentMode === "large") {
    return await flushLargePendingInputForTab(toRaw(tab) as DocumentTab, reason);
  }
  const result = await flushDocumentSnapshotWithReceipt(tab.id, reason);
  const session = documentSessionForTab(tab.id);
  if (!session) return null;
  return {
    session,
    afterRevision: session.revision,
    afterToken: result.flushReceipt?.after ?? session.mutationToken?.() ?? null,
  };
}

export function largePaneForTab(tab: DocumentTab): EditorPaneId {
  const raw = toRaw(tab) as DocumentTab;
  for (const paneId of ["main", "secondary"] as const) {
    const paneTab = getPaneTab(paneId);
    if (paneTab && toRaw(paneTab) === raw) return paneId;
  }
  return appStore.splitLayout.activePaneId;
}

async function saveLargeFileForTab(tab: DocumentTab, paneId: EditorPaneId) {
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured || captured.tab !== toRaw(tab)) return false;
  const largeFile = captured.tab.largeFile;
  if (!largeFile) return false;
  if (captured.tab.id === appStore.activeTabId) appStore.saveState = "saving";
  let committedReceipt: LargeSaveReceipt | null = null;
  try {
    appStore.statusMessage = "正在保存大文件...";
    await flushLargePendingInputForTab(captured.tab, "save");
    const queue = largeQueueFor(captured.tab);
    await queue.idle();
    if (!largeTabObjectStillCurrent(captured)) return false;
    const outbox = largeOutboxFor(captured.tab);
    if (outbox.length > 0) {
      if (captured.tab.id === appStore.activeTabId) {
        appStore.isDirty = true;
        appStore.saveState = "failed";
        appStore.statusMessage = "大文件仍有未提交输入，请显式重试后再保存。";
      }
      return false;
    }
    let current = currentLargeSessionIdentity(captured);
    if (!current?.tab.largeFile) return false;
    let saveAsTarget: LargeSaveAsTarget | null = null;
    const targetPath = current.tab.largeFile.targetPath !== undefined
      ? current.tab.largeFile.targetPath
      : current.tab.path || null;
    if (!targetPath) {
      saveAsTarget = await chooseLargeSaveAsTarget(captured);
      if (!saveAsTarget) return false;
      await flushLargePendingInputForTab(captured.tab, "saveAs");
      await queue.idle();
      if (!largeTabObjectStillCurrent(captured)) return false;
      current = currentLargeSessionIdentity(captured);
      if (!current?.tab.largeFile || largeOutboxFor(captured.tab).length > 0) return false;
    }
    // Capture the draft owner after the final input flush.  This context is
    // tied to the raw tab and is deliberately kept across pane switches.
    const draftCleanup = captureDraftCleanupContext(captured.tab);
    const receipt = await queue.enqueue(
      saveAsTarget ? "saveAs" : "save",
      captured,
      () => currentLargeSessionIdentity(captured),
      async (_captured, queuedCurrent) => {
        if (largeOutboxFor(queuedCurrent.tab).some((item) => item.failed)) {
          throw new Error("大文件存在失败的待处理编辑，已阻止保存时隐式重放。");
        }
        const queuedTarget = queuedCurrent.tab.largeFile?.targetPath !== undefined
          ? queuedCurrent.tab.largeFile.targetPath
          : queuedCurrent.tab.path || null;
        if (saveAsTarget) {
          const nextReceipt = await invoke<LargeSaveReceipt>("save_large_file_as", {
            sessionId: queuedCurrent.sessionId,
            targetPath: saveAsTarget.path,
            expectedRevision: queuedCurrent.revision,
            coordinateSpace: LARGE_COORDINATE_SPACE,
            expectedTargetFingerprint: saveAsTarget.expectedTargetFingerprint,
          });
          // Validate and project the backend acknowledgement while the
          // operation still owns this queue slot.  Retargeting the UI tab is
          // deferred until after the queue's identity fence has completed.
          applyLargeSaveReceipt(queuedCurrent, nextReceipt);
          return nextReceipt;
        }
        if (!queuedTarget) throw new LargeSessionStaleError("恢复的大文件必须先另存为。");
        const nextReceipt = await invoke<LargeSaveReceipt>("save_large_file", {
          sessionId: queuedCurrent.sessionId,
          expectedRevision: queuedCurrent.revision,
          coordinateSpace: LARGE_COORDINATE_SPACE,
        });
        applyLargeSaveReceipt(queuedCurrent, nextReceipt);
        return nextReceipt;
      },
    );
    // Keep the native acknowledgement outside the queue scope so failures in
    // the post-commit tree/config synchronization can still distinguish a
    // written disk version from a failed write.  The queue task has already
    // applied the receipt to the captured raw session before it resolves.
    committedReceipt = receipt;
    // The queue task has already acknowledged the receipt against the raw
    // session.  This second call only accepts that projected receipt and
    // performs the optional UI retarget after the queue fence.
    commitLargeSaveReceipt(captured, receipt, { retarget: false });
    let hasNewUnsavedWork = tabHasUnsavedWork(captured.tab) || largeOutboxFor(captured.tab).length > 0;
    let cleanupFailed = false;
    if (!hasNewUnsavedWork) {
      const cleanupReceipt = captureDraftCleanupReceipt(captured.tab);
      if (draftCleanup && !await clearCapturedDraft(draftCleanup, { receipt: cleanupReceipt })) {
        cleanupFailed = true;
      }
      // Clearing a recovery record waits on its own transaction.  Input can
      // arrive during that await, so never reuse the pre-cleanup snapshot to
      // decide whether this save may mark the tab clean.
      hasNewUnsavedWork = largeSaveHasUnsavedWork(captured.tab);
    }
    if (saveAsTarget && receipt.path && captured.tab.path !== receipt.path) {
      retargetLargeTabForSaveAs(captured.tab, receipt.path);
    }
    hasNewUnsavedWork = largeSaveHasUnsavedWork(captured.tab);
    if (receipt.isDirty || hasNewUnsavedWork) {
      if (captured.tab.id === appStore.activeTabId) {
        appStore.isDirty = true;
        appStore.saveState = "dirty";
        appStore.statusMessage = "大文件仍有未保存修改。";
      }
      return false;
    }
    if (cleanupFailed) {
      if (captured.tab.id === appStore.activeTabId) {
        appStore.isDirty = false;
        appStore.saveState = "saved";
        appStore.statusMessage = formatTransactionNotice(
          "大文件已保存，但草稿清理失败，请稍后重试。",
          receipt.cleanupWarning,
          receipt.recoveryArtifact,
        );
      }
      return false;
    }
    if (captured.tab.id === appStore.activeTabId) {
      appStore.isDirty = false;
      appStore.saveState = "saved";
      appStore.statusMessage = formatTransactionNotice(
        "大文件已保存",
        receipt.cleanupWarning,
        receipt.recoveryArtifact,
      );
    }
    rememberRecentFile(receipt.path);
    await refreshFileTree();
    if (!largeSaveTargetStillCurrent(captured, receipt)) return false;
    hasNewUnsavedWork = largeSaveHasUnsavedWork(captured.tab);
    if (hasNewUnsavedWork) {
      markLargeSaveNewInput(captured.tab);
      return false;
    }
    await persistConfig();
    // Config persistence is another asynchronous boundary.  Recheck the
    // captured raw tab after it returns so input that arrived during either
    // synchronization step cannot be reported as part of the saved version.
    if (!largeSaveTargetStillCurrent(captured, receipt)) return false;
    hasNewUnsavedWork = largeSaveHasUnsavedWork(captured.tab);
    if (hasNewUnsavedWork) {
      markLargeSaveNewInput(captured.tab);
      return false;
    }
    return true;
  } catch (error) {
    if (committedReceipt && largeSaveCommitKnown(captured, committedReceipt)) {
      const hasNewUnsavedWork = tabHasUnsavedWork(captured.tab) || largeOutboxFor(captured.tab).length > 0;
      if (captured.tab.id === appStore.activeTabId) {
        appStore.isDirty = hasNewUnsavedWork;
        appStore.saveState = hasNewUnsavedWork ? "dirty" : "saved";
        appStore.statusMessage = formatTransactionNotice(
          hasNewUnsavedWork
            ? "大文件已写入，但仍有新的未保存修改；保存后状态同步失败"
            : "大文件已写入，但保存后状态同步失败",
          committedReceipt.cleanupWarning,
          committedReceipt.recoveryArtifact,
        ) + `：${formatLargeTransactionEvidence(error)}`;
      }
    } else if (captured.tab.id === appStore.activeTabId) {
      appStore.saveState = "failed";
      appStore.isDirty = true;
      appStore.statusMessage = formatLargeTransactionEvidence(error);
    }
    throw error;
  }
}

type LargeSaveAsTarget = {
  path: string;
  expectedTargetFingerprint: LargeFileFingerprint | null;
};

async function chooseLargeSaveAsTarget(captured: LargeSessionIdentity) {
  if (!currentLargeSessionIdentity(captured)?.tab.largeFile) return null;
  const targetPath = await invoke<string | null>("save_markdown_file_dialog", {
    defaultFileName: defaultMarkdownFileName(captured.tab.name),
  });
  if (!targetPath || !currentLargeSessionIdentity(captured)) return null;
  const expectedTargetFingerprint = await invoke<LargeFileFingerprint | null>("get_large_file_fingerprint", {
    path: targetPath,
  });
  if (!currentLargeSessionIdentity(captured)) return null;
  return { path: targetPath, expectedTargetFingerprint } satisfies LargeSaveAsTarget;
}

function applyLargeSaveReceipt(current: LargeSessionIdentity, receipt: LargeSaveReceipt) {
  if (receipt.outcome !== "committed" || receipt.diskWritten !== "yes") {
    throw new Error(formatLargeSaveReceiptFailure(receipt));
  }
  if (receipt.sessionId !== current.sessionId
    || receipt.coordinateSpace !== LARGE_COORDINATE_SPACE
    || receipt.currentRevision !== receipt.requestedRevision
    || (receipt.requestedRevision !== current.revision && receipt.currentRevision !== current.revision)) {
    throw new LargeSessionStaleError("大文件保存回执与当前会话版本不一致。");
  }
  const largeFile = reactive(current.tab).largeFile;
  if (!largeFile) throw new LargeSessionStaleError();
  largeRemotePendingCounts.set(current.tab, receipt.pendingEditCount);
  largeFile.revision = receipt.currentRevision;
  largeFile.savedRevision = receipt.savedRevision;
  largeFile.baseFingerprint = receipt.baseFingerprint;
  largeFile.diskFingerprint = receipt.diskFingerprint;
  largeFile.coordinateSpace = receipt.coordinateSpace;
  largeFile.sizeBytes = receipt.baseFingerprint.sizeBytes;
  largeFile.targetPath = receipt.path || null;
  syncLargeOutboxProjection(current.tab);
}

function commitLargeSaveReceipt(
  captured: LargeSessionIdentity,
  receipt: LargeSaveReceipt,
  options: { retarget?: boolean } = {},
) {
  const current = currentLargeSessionIdentity(captured);
  if (!current?.tab.largeFile) throw new LargeSessionStaleError();
  if (receipt.outcome !== "committed" || receipt.diskWritten !== "yes"
    || current.revision < receipt.currentRevision
    || current.tab.largeFile.revision < receipt.currentRevision) {
    throw new Error(formatLargeSaveReceiptFailure(receipt));
  }
  if (current.revision === receipt.currentRevision
    && (current.tab.largeFile.savedRevision !== receipt.savedRevision
      || current.tab.largeFile.baseFingerprint.sha256 !== receipt.baseFingerprint.sha256)) {
    throw new LargeSessionStaleError("大文件保存回执已经被后续版本取代。");
  }
  if (options.retarget !== false && receipt.path && current.tab.path !== receipt.path) {
    retargetLargeTabForSaveAs(current.tab, receipt.path);
  }
  syncLargeOutboxProjection(current.tab);
  if (current.tab.id === appStore.activeTabId) {
    appStore.isDirty = current.tab.isDirty;
    appStore.saveState = current.tab.isDirty ? "dirty" : "saved";
  }
}

function largeSaveTargetStillCurrent(captured: LargeSessionIdentity, receipt: LargeSaveReceipt) {
  const tab = captured.tab;
  return isTabRegistered(tab)
    && tab.documentMode === "large"
    && tab.largeFile?.sessionId === captured.sessionId
    && tab.path === receipt.path;
}

function largeSaveCommitKnown(captured: LargeSessionIdentity, receipt: LargeSaveReceipt) {
  const largeFile = captured.tab.largeFile;
  return isTabRegistered(captured.tab)
    && captured.tab.documentMode === "large"
    && largeFile?.sessionId === captured.sessionId
    && receipt.sessionId === captured.sessionId
    && receipt.coordinateSpace === LARGE_COORDINATE_SPACE
    && receipt.outcome === "committed"
    && receipt.diskWritten === "yes"
    && largeFile.revision >= receipt.currentRevision
    && largeFile.savedRevision >= receipt.savedRevision;
}

function largeSaveHasUnsavedWork(tab: DocumentTab) {
  return tabHasUnsavedWork(tab) || largeOutboxFor(tab).length > 0;
}

function markLargeSaveNewInput(tab: DocumentTab) {
  if (tab.id !== appStore.activeTabId) return;
  appStore.isDirty = true;
  appStore.saveState = "dirty";
  appStore.statusMessage = "大文件已保存，但保存期间又发生了新输入，仍有未保存修改。";
}

async function saveNormalFileForContext(context: SaveContext) {
  if (!isSaveIntentCurrent(context)) return staleSaveResult(context);

  let version = await captureSaveVersion(context, "save");
  if (!version) return staleSaveResult(context);

  if (!context.path) {
    const target = await chooseSaveAsTargetForContext(context);
    if (!target) return false;
    version = await captureSaveVersion(context, "saveAs");
    if (!version) return staleSaveResult(context);
    return await writeCapturedVersion(context, version, target, true);
  }

  const plan = await prepareNormalFileSave(context, version);
  if (!plan) return false;
  if (plan.retarget) {
    version = await captureSaveVersion(context, "saveAs");
    if (!version) return staleSaveResult(context);
  }
  return await writeCapturedVersion(context, version, plan.target, plan.retarget);
}

async function prepareNormalFileSave(
  context: SaveContext,
  version: FrozenSaveVersion,
) {
  const baseline = context.tab.fileSnapshot ?? context.fileSnapshot;
  if (!baseline?.exists) return { target: context.path, retarget: false };
  const currentSnapshot = await getFileSnapshotWithFingerprint(context.path);
  if (snapshotsMatch(baseline, currentSnapshot)) {
    return { target: context.path, retarget: false };
  }

  if (!currentSnapshot.exists) {
    const target = await resolveDeletedFileBeforeSave(context);
    return target ? { target, retarget: true } : null;
  }
  const target = await resolveChangedFileBeforeSave(context, version);
  return target ? { target, retarget: true } : null;
}

async function resolveDeletedFileBeforeSave(context: SaveContext) {
  const result = await showDialog({
    title: "文件已被外部删除",
    message: "当前文件路径已经不存在。为避免误写入，请选择另存为，或取消保存。",
    cancelId: "cancel",
    defaultId: "saveAs",
    tone: "danger",
    buttons: [
      { id: "cancel", label: "取消", variant: "secondary" },
      { id: "saveAs", label: "另存为", variant: "primary" },
    ],
  });
  if (result !== "saveAs") return null;
  return await chooseSaveAsTargetForContext(context, context.path);
}

async function resolveChangedFileBeforeSave(context: SaveContext, version: FrozenSaveVersion) {
  const diff = await conflictDiffDetails(context.path, version.markdown);
  const result = await showDialog({
    title: "文件已在外部修改",
    message: "磁盘上的文件已经被其他程序修改。直接保存会覆盖外部修改。",
    details: diff,
    cancelId: "cancel",
    defaultId: "cancel",
    tone: "danger",
    buttons: [
      { id: "cancel", label: "取消", variant: "secondary" },
      { id: "reload", label: "重载磁盘版本", variant: "danger" },
      { id: "conflictCopy", label: "保存冲突副本", variant: "primary" },
      { id: "saveAs", label: "另存为副本", variant: "primary" },
    ],
  });
  if (result === "reload") {
    await reloadCapturedFileFromDisk(context, version);
    return null;
  }
  if (result === "saveAs") return await chooseSaveAsTargetForContext(context, context.path);
  if (result === "conflictCopy") {
    await saveConflictCopyForContext(context, version);
  }
  return null;
}

async function conflictDiffDetails(path: string, markdown: string) {
  const disk = await readTextFileSnapshot(path).then((snapshot) => snapshot.content).catch(() => "");
  return buildTextDiffSummary(markdown, disk);
}

async function chooseSaveAsTargetForContext(context: SaveContext, avoidPath?: string) {
  if (!isSaveContextBound(context)) return null;
  const selected = await invoke<string | null>("save_markdown_file_dialog", {
    defaultFileName: defaultMarkdownFileName(context.tab.name),
  });
  if (!selected) return null;
  if (avoidPath && isSamePath(selected, avoidPath)) {
    await alertDialog({
      title: "请选择不同文件名",
      message: "另存为副本不能使用已经发生外部修改的原文件路径。",
      tone: "danger",
    });
    return null;
  }
  const existing = findFileTab(selected);
  if (existing && existing !== context.tab) {
    await alertDialog({
      title: "目标文件已打开",
      message: "另存为目标已经在其他标签页打开，请选择其他文件名。",
      tone: "danger",
    });
    return null;
  }
  return selected;
}

async function writeCapturedVersion(
  context: SaveContext,
  version: FrozenSaveVersion,
  targetPath: string,
  retarget: boolean,
) {
  if (retarget) {
    const existing = findFileTab(targetPath);
    if (existing && existing !== context.tab) {
      if (isCapturedTabActive(context)) appStore.statusMessage = "另存为目标已经在其他标签页打开。";
      return false;
    }
  }
  const expectedTargetFingerprint = await expectedFingerprintForWriteTarget(
    targetPath,
    retarget ? undefined : context.fileSnapshot?.fingerprint,
  );
  if (!isFrozenSaveVersionCurrent(version)) return staleSaveResult(context);
  let committed: { tab: DocumentTab; epoch: number; session: DocumentSessionAdapter | null } | null = null;
  const savedHistory = documentHistoryForTab(context.tabId);
  let writeReceipt: TextFileWriteReceipt | null = null;
  let ownWriteLease: ReturnType<DocumentDiskWriteFence['begin']> | null = null;
  let outcome: Awaited<ReturnType<typeof runVersionedSave<FileSnapshot>>>;
  try {
    outcome = await runVersionedSave({
      isCurrent: () => isFrozenSaveVersionCurrent(version),
      write: async () => {
        ownWriteLease = fileWriteFence.begin(targetPath);
        writeReceipt = await invoke<TextFileWriteReceipt>("write_text_file", {
          path: targetPath,
          content: version.markdown,
          expectedTargetFingerprint,
        });
        assertCommittedTextWrite(writeReceipt);
        if (!retarget && targetPath === context.path) savedHistory.markSaved(version.markdown);
      },
      stat: async () => {
        const fileSnapshot = await getFileSnapshot(targetPath);
        return writeReceipt?.targetFingerprint ? fileSnapshotFromFingerprint(writeReceipt.targetFingerprint) : fileSnapshot;
      },
      commit: (fileSnapshot) => {
        committed = retarget
          ? commitCapturedSaveAs(context, version, targetPath, fileSnapshot)
          : commitCapturedSave(context, version, targetPath, fileSnapshot);
        return committed !== null;
      },
      afterCommit: async () => {
        await refreshFileTree();
        void syncExternalFileWatches();
        await persistConfig();
      },
      isStable: () => {
        if (!committed) return false;
        const currentSession = documentSessionForTab(committed.tab.id);
        const sessionStable = retarget
          ? currentSession?.hasPendingEdits?.() !== true
          : currentSession === committed.session && currentSession?.hasPendingEdits?.() !== true;
        return committed.tab.id === (retarget ? tabIdForPath(targetPath) : context.tabId)
          && committed.tab.path === targetPath
          && !committed.tab.isDirty
          && appStore.tabs.includes(committed.tab)
          && mutationEpoch(committed.tab) === committed.epoch
          && sessionStable;
      },
    });
  } catch (error) {
    publishSaveNotice(context.tabId, "failure", formatLargeTransactionEvidence(error));
    const completedReceipt = writeReceipt as TextFileWriteReceipt | null;
    const diskWasWritten = completedReceipt?.outcome === "committed"
      && completedReceipt.diskWritten === "yes";
    if (diskWasWritten && completedReceipt) {
      // A post-write stat, tree refresh, or config sync may fail after the
      // native transaction has committed. Keep the installed target as the
      // captured tab's baseline so the next save compares against what was
      // actually written instead of manufacturing a self-conflict.
      rememberWrittenDiskBaseline(context, targetPath, completedReceipt);
      if (completedReceipt.targetFingerprint && isFrozenSaveVersionCurrent(version)) {
        const writtenSnapshot = fileSnapshotFromFingerprint(completedReceipt.targetFingerprint);
        if (retarget) {
          commitCapturedSaveAs(context, version, targetPath, writtenSnapshot);
        } else {
          commitCapturedSave(context, version, targetPath, writtenSnapshot);
        }
      }
    }
    if (isCapturedTabActive(context)) {
      appStore.saveState = "failed";
      appStore.isDirty = tabHasUnsavedWork(context.tab);
      appStore.statusMessage = diskWasWritten && completedReceipt
        ? formatTransactionNotice(
          `文件已写入，但保存状态同步失败：${formatLargeTransactionEvidence(error)}`,
          completedReceipt.cleanupWarning,
          completedReceipt.recoveryArtifact,
        )
        : formatLargeTransactionEvidence(error);
    }
    throw error;
  } finally {
    if (ownWriteLease) {
      fileWriteFence.finish(ownWriteLease);
      void checkOpenFileSnapshots();
    }
  }
  if (outcome.saved) {
    const completedReceipt = writeReceipt as TextFileWriteReceipt | null;
    if (completedReceipt && isCapturedTabActive(context)) {
      appStore.statusMessage = formatTransactionNotice(
        "文件已保存",
        completedReceipt.cleanupWarning,
        completedReceipt.recoveryArtifact,
      );
    }
    return true;
  }
  if (outcome.phase === "after-write" && writeReceipt) {
    // The old captured version may already be on disk while newer input is
    // dirty in the editor. Record only the backend's installed-target fingerprint as
    // the new disk baseline; never run the normal commit path, which would
    // clear that newer input.  A later save can then compare against the
    // actual version we wrote and still detect an external write after it.
    rememberWrittenDiskBaseline(context, targetPath, writeReceipt);
  }
  const staleWriteReceipt = writeReceipt as TextFileWriteReceipt | null;
  const staleMessage = formatTransactionNotice(
    outcome.phase === "before-write"
      ? ""
      : retarget
        ? "旧版本已写入副本，当前仍有未保存修改。"
        : "文件已保存，但当前文档在保存期间又发生了修改。",
    staleWriteReceipt?.cleanupWarning,
    staleWriteReceipt?.recoveryArtifact,
  );
  return staleSaveResult(context, outcome.phase === "before-write"
    ? undefined
    : staleMessage);
}

function rememberWrittenDiskBaseline(
  context: SaveContext,
  targetPath: string,
  receipt: TextFileWriteReceipt,
) {
  // targetFingerprint observes the installed file after the OS replacement.
  // outputFingerprint belongs to an independent recovery copy and can have a
  // different mtime despite identical content; it is never a disk baseline.
  const fingerprint = receipt.targetFingerprint;
  if (receipt.path !== targetPath
    || receipt.outcome !== "committed"
    || receipt.diskWritten !== "yes"
    || !fingerprint
    || !isTabRegistered(context.tab)
    || context.tab.path !== targetPath) return;
  context.tab.fileSnapshot = {
    exists: true,
    mtime: fingerprint.modifiedMillis ?? undefined,
    size: fingerprint.sizeBytes,
    fingerprint,
  };
}

function fileSnapshotFromFingerprint(fingerprint: LargeFileFingerprint): FileSnapshot {
  return {
    exists: true,
    mtime: fingerprint.modifiedMillis ?? undefined,
    size: fingerprint.sizeBytes,
    fingerprint,
  };
}

function captureSaveContext(tab = getActiveTab()): SaveContext | null {
  if (!tab) return null;
  tab = toRaw(tab) as DocumentTab;
  const session = documentSessionForTab(tab.id);
  return {
    tab,
    tabId: tab.id,
    path: tab.path,
    kind: tab.kind,
    session,
    epoch: mutationEpoch(tab),
    revision: documentRuntimeMetadata.get(tab.id)?.revision
      ?? session?.revision
      ?? (tab.documentMode === "large" ? tab.largeFile?.revision ?? null : null),
    pendingVersion: pendingEditVersion(session),
    mutationToken: session?.mutationToken?.() ?? null,
    content: tab.content,
    fileSnapshot: tab.fileSnapshot ? { ...tab.fileSnapshot } : undefined,
  };
}

async function captureSaveVersion(context: SaveContext, reason: SnapshotReason): Promise<FrozenSaveVersion | null> {
  if (!isSaveContextBound(context)) return null;
  if (context.windowCloseExpected
    && !isWindowCloseSavePromptCurrent(context.windowCloseExpected, context.windowCloseFlushReceipt)) return null;
  const flushed = await flushDocumentSnapshotWithReceipt(context.tabId, reason);
  const previousFlushReceipt = context.windowCloseFlushReceipt;
  context.windowCloseFlushReceipt = flushed.flushReceipt;
  if (!isSaveContextBound(context)) return null;
  if (context.windowCloseExpected
    && !isWindowCloseSavePromptCurrent(
      context.windowCloseExpected,
      flushed.flushReceipt,
      previousFlushReceipt,
    )) return null;
  const session = documentSessionForTab(context.tabId);
  if (session?.hasPendingEdits?.()) return null;
  const revision = documentRuntimeMetadata.get(context.tabId)?.revision ?? session?.revision ?? null;
  return {
    tab: context.tab,
    tabId: context.tabId,
    path: context.path,
    epoch: mutationEpoch(context.tab),
    revision,
    session,
    pendingVersion: pendingEditVersion(session),
    mutationToken: session?.mutationToken?.() ?? null,
    flushReceipt: flushed.flushReceipt,
    markdown: context.tab.content,
    dirty: context.tab.isDirty,
  };
}

function isSaveContextBound(context: SaveContext) {
  return isTabRegistered(context.tab)
    && context.tab.id === context.tabId
    && context.tab.path === context.path
    && documentSessionForTab(context.tabId) === context.session;
}

function isSaveIntentCurrent(context: SaveContext) {
  const session = documentSessionForTab(context.tabId);
  const revision = documentRuntimeMetadata.get(context.tabId)?.revision ?? session?.revision ?? null;
  const mutationToken = session?.mutationToken?.() ?? null;
  return isSaveContextBound(context)
    && mutationEpoch(context.tab) === context.epoch
    && revision === context.revision
    && pendingEditVersion(session) === context.pendingVersion
    && (!context.mutationToken
      || (mutationToken != null && documentMutationTokensEqual(context.mutationToken, mutationToken)));
}

function isWindowCloseSavePromptCurrent(
  expected: CloseAuthorization,
  authorizedFlush?: DocumentFlushReceipt,
  previousFlush?: DocumentFlushReceipt,
) {
  if (!isTabRegistered(expected.tab)) return false;
  const current = captureCloseAuthorization(expected.tab);
  if (current.tab !== expected.tab
    || current.tabId !== expected.tabId
    || current.path !== expected.path
    || current.kind !== expected.kind
    || current.documentMode !== expected.documentMode
    || current.session !== expected.session) {
    return false;
  }
  if (!expected.pending) return closeAuthorizationsMatch(current, expected);
  if (authorizedFlush) {
    const startsAtPrompt = expected.mutationToken != null
      && documentMutationTokensEqual(authorizedFlush.before, expected.mutationToken);
    const continuesPromptFlush = previousFlush != null
      && previousFlush.sessionIdentity === expected.session
      && expected.mutationToken != null
      && documentMutationTokensEqual(previousFlush.before, expected.mutationToken)
      && documentMutationTokensEqual(previousFlush.after, authorizedFlush.before);
    return expected.mutationToken != null
      && authorizedFlush.sessionIdentity === expected.session
      && (startsAtPrompt || continuesPromptFlush)
      && current.mutationToken != null
      && documentMutationTokensEqual(current.mutationToken, authorizedFlush.after)
      && authorizedFlush.after.pendingInputVersion === expected.mutationToken.pendingInputVersion;
  }
  // Without a production flush receipt, only a pending flag transition that
  // leaves the captured document revision/content untouched is safe to accept.
  // A new token or any other document mutation is new input and cancels the
  // close operation; Math composition paths that cannot prove this stay open.
  return expected.pendingVersion !== null
    && current.pendingVersion === expected.pendingVersion
    && ((expected.mutationToken == null && current.mutationToken == null)
      || (expected.mutationToken != null && current.mutationToken != null
        && documentMutationTokensEqual(expected.mutationToken, current.mutationToken)))
    && current.epoch === expected.epoch
    && current.revision === expected.revision
    && current.content === expected.content
    && current.dirty === expected.dirty;
}

function isFrozenSaveVersionCurrent(version: FrozenSaveVersion) {
  const session = documentSessionForTab(version.tabId);
  const mutationToken = session?.mutationToken?.() ?? null;
  const receiptCurrent = !version.flushReceipt
    || (
      version.flushReceipt.sessionIdentity === version.session
      && mutationToken != null
      && documentMutationTokensEqual(mutationToken, version.flushReceipt.after)
    );
  return isTabRegistered(version.tab)
    && !session?.hasPendingEdits?.()
    && receiptCurrent
    && saveVersionIsCurrent(version, {
      tab: version.tab,
      tabId: version.tab.id,
      path: version.tab.path,
      epoch: mutationEpoch(version.tab),
      revision: documentRuntimeMetadata.get(version.tabId)?.revision ?? session?.revision ?? null,
      session,
      pendingVersion: pendingEditVersion(session),
      mutationToken,
    });
}

function isTabRegistered(tab: DocumentTab) {
  return appStore.tabs.some((item) => toRaw(item) === tab);
}

function captureCloseAuthorization(tab: DocumentTab): CloseAuthorization {
  tab = toRaw(tab) as DocumentTab;
  const session = documentSessionForTab(tab.id);
  return {
    tab,
    tabId: tab.id,
    path: tab.path,
    kind: tab.kind,
    documentMode: tab.documentMode,
    epoch: mutationEpoch(tab),
    revision: documentRuntimeMetadata.get(tab.id)?.revision
      ?? session?.revision
      ?? (tab.documentMode === "large" ? tab.largeFile?.revision ?? null : null),
    pendingVersion: pendingEditVersion(session),
    session,
    mutationToken: session?.mutationToken?.() ?? null,
    content: tab.content,
    dirty: tab.isDirty,
    pending: session?.hasPendingEdits?.() === true,
    largeFile: tab.largeFile,
    largePendingEdits: JSON.stringify(tab.largeFile?.pendingEdits ?? []),
  };
}

function isCloseAuthorizationCurrent(version: CloseAuthorization) {
  const session = documentSessionForTab(version.tabId);
  return isTabRegistered(version.tab)
    && version.tab.id === version.tabId
    && version.tab.path === version.path
    && version.tab.kind === version.kind
    && version.tab.documentMode === version.documentMode
    && version.tab.content === version.content
    && version.tab.isDirty === version.dirty
    && toRaw(version.tab.largeFile) === toRaw(version.largeFile)
    && JSON.stringify(version.tab.largeFile?.pendingEdits ?? []) === version.largePendingEdits
    && mutationEpoch(version.tab) === version.epoch
    && session === version.session
    && ((version.mutationToken == null && session?.mutationToken?.() == null)
      || (version.mutationToken != null
        && session?.mutationToken?.() != null
        && documentMutationTokensEqual(version.mutationToken, session.mutationToken())))
    && (documentRuntimeMetadata.get(version.tabId)?.revision
      ?? session?.revision
      ?? (version.tab.documentMode === "large" ? version.tab.largeFile?.revision ?? null : null)) === version.revision
    && pendingEditVersion(session) === version.pendingVersion
    && (session?.hasPendingEdits?.() === true) === version.pending;
}

function closeAuthorizationsMatch(left: CloseAuthorization, right: CloseAuthorization) {
  return toRaw(left.tab) === toRaw(right.tab)
    && left.tabId === right.tabId
    && left.path === right.path
    && left.kind === right.kind
    && left.documentMode === right.documentMode
    && left.epoch === right.epoch
    && left.revision === right.revision
    && left.pendingVersion === right.pendingVersion
    && left.session === right.session
    && ((left.mutationToken == null && right.mutationToken == null)
      || (left.mutationToken != null && right.mutationToken != null
        && documentMutationTokensEqual(left.mutationToken, right.mutationToken)))
    && left.content === right.content
    && left.dirty === right.dirty
    && left.pending === right.pending
    && toRaw(left.largeFile) === toRaw(right.largeFile)
    && left.largePendingEdits === right.largePendingEdits;
}

function closePromptIdentityMatches(left: CloseAuthorization, right: CloseAuthorization) {
  return toRaw(left.tab) === toRaw(right.tab)
    && left.tabId === right.tabId
    && left.path === right.path
    && left.kind === right.kind
    && left.documentMode === right.documentMode
    && left.session === right.session
    && toRaw(left.largeFile) === toRaw(right.largeFile)
    && left.largePendingEdits === right.largePendingEdits;
}

export function captureWindowCloseAuthorization(): WindowCloseAuthorization {
  syncActiveTabFromProjection();
  return {
    tabs: appStore.tabs.map((tab) => captureCloseAuthorization(toRaw(tab) as DocumentTab)),
  };
}

/**
 * Close-prompt preparation is a separate boundary from ordinary save.  It
 * gives WYSIWYG sessions one tagged transaction window to finish transient
 * formula UI before a native dialog can move focus away from the editor.
 * Every session and token is checked again before the prompt authorization is
 * captured; a concurrent edit therefore keeps the window open.
 */
export async function prepareWindowClosePrompt() {
  const composingTargets = appStore.tabs.map(item => {
    const tab = toRaw(item) as DocumentTab;
    return { tab, id: tab.id, path: tab.path, session: documentSessionForTab(tab.id) };
  });
  for (const target of composingTargets) if (target.session) await waitForDocumentComposition(target.id, target.session);
  if (appStore.tabs.length !== composingTargets.length || composingTargets.some(target =>
    !isTabRegistered(target.tab) || target.tab.id !== target.id || target.tab.path !== target.path
      || documentSessionForTab(target.id) !== target.session)) throw new Error('等待输入法组合期间文档集合发生变化，已保留窗口。');
  syncActiveTabFromProjection();
  const expectedTabs = appStore.tabs.map((tab) => toRaw(tab) as DocumentTab);
  const records: Array<{
    tab: DocumentTab;
    session: DocumentSessionAdapter | null;
    baseline: CloseAuthorization;
    token: DocumentMutationToken | null;
    editorMode: DocumentTab["editorMode"];
    name: string;
  }> = [];

  const stableTabs = () => {
    const currentTabs = appStore.tabs.map((tab) => toRaw(tab) as DocumentTab);
    if (currentTabs.length !== expectedTabs.length
      || expectedTabs.some((tab, index) => currentTabs[index] !== tab)) return false;
    return records.every((record) => {
      if (!isTabRegistered(record.tab) || documentSessionForTab(record.tab.id) !== record.session) return false;
      return closeAuthorizationsMatch(captureCloseAuthorization(record.tab), record.baseline);
    });
  };

  for (const tab of expectedTabs) {
    const session = documentSessionForTab(tab.id);
    records.push({
      tab,
      session,
      baseline: captureCloseAuthorization(tab),
      token: session?.mutationToken?.() ?? null,
      editorMode: tab.editorMode,
      name: tab.name,
    });
  }
  if (!stableTabs()) throw new Error("关闭提示准备开始前文档或标签页已发生变化。");

  for (const record of records) {
    const { tab, session } = record;
    if (!session?.finalizeClosePrompt) continue;
    if (!stableTabs()) {
      throw new Error("关闭提示准备期间文档或标签页发生了变化。");
    }
    const before = record.token;
    const receipt = await session.finalizeClosePrompt({ expectedToken: before ?? undefined });
    if (documentSessionForTab(tab.id) !== session || !isTabRegistered(tab)) {
      throw new Error("关闭提示准备期间编辑器会话或标签页发生了变化。");
    }
    const after = session.mutationToken?.() ?? null;
    if (receipt) {
      if (receipt.sessionIdentity !== session
        || (before && !documentMutationTokensEqual(receipt.before, before))
        || (after && !documentMutationTokensEqual(receipt.after, after))) {
        throw new Error("关闭提示准备返回了无法验证的编辑器版本回执。");
      }
    } else if (before || after) {
      if (!before || !after || !documentMutationTokensEqual(before, after)) {
        throw new Error("关闭提示准备期间文档版本发生了变化。");
      }
    }
    const afterAuthorization = captureCloseAuthorization(tab);
    if (!closePromptIdentityMatches(record.baseline, afterAuthorization)
      || tab.editorMode !== record.editorMode
      || tab.name !== record.name) {
      throw new Error("关闭提示准备期间标签页身份发生了变化。");
    }
    record.token = after;
    record.baseline = afterAuthorization;
    if (!stableTabs()) throw new Error("关闭提示准备完成后文档版本仍在变化。");
  }
  if (!stableTabs()) throw new Error("关闭提示准备完成后文档版本仍在变化。");
  return captureWindowCloseAuthorization();
}

/**
 * Check the complete tab object set after every asynchronous close step.
 * Save receipts authorize the expected id/path change from SaveAs; draft
 * receipts authorize only the revision change caused by flushing the prompt's
 * already captured pending buffer.
 */
export function isWindowCloseAuthorizationCurrent(
  authorization: WindowCloseAuthorization,
  saveReceipts: readonly WindowCloseSaveReceipt[] = [],
  draftReceipts: readonly WindowCloseDraftReceipt[] = [],
) {
  const currentTabs = appStore.tabs.map((tab) => toRaw(tab) as DocumentTab);
  if (currentTabs.length !== authorization.tabs.length) return false;
  const saveByTab = new Map(saveReceipts.map((receipt) => [toRaw(receipt.tab), receipt]));
  const draftByTab = new Map(draftReceipts.map((receipt) => [toRaw(receipt.tab), receipt]));
  for (const expected of authorization.tabs) {
    const currentTab = currentTabs.find((tab) => tab === expected.tab);
    if (!currentTab) return false;
    const current = captureCloseAuthorization(currentTab);
    const saveReceipt = saveByTab.get(expected.tab);
    if (saveReceipt) {
      if (saveReceipt.tab !== expected.tab
        || !closeAuthorizationsMatch(saveReceipt.before, expected)
        || !closeAuthorizationsMatch(current, saveReceipt.after)) {
        return false;
      }
      continue;
    }
    const draftReceipt = draftByTab.get(expected.tab);
    if (draftReceipt) {
      if (draftReceipt.tab !== expected.tab
        || draftReceipt.tabId !== expected.tabId
        || draftReceipt.path !== expected.path
        || current.kind !== expected.kind
        || current.documentMode !== expected.documentMode
        || draftReceipt.session !== expected.session
        || draftReceipt.beforeEpoch !== expected.epoch
        || draftReceipt.beforeRevision !== expected.revision
        || draftReceipt.beforePendingVersion !== expected.pendingVersion
        || draftReceipt.beforePending !== expected.pending
        || !mutationTokensMatch(draftReceipt.beforeMutationToken, expected.mutationToken)
        || current.tab !== expected.tab
        || current.tabId !== draftReceipt.tabId
        || current.path !== draftReceipt.path
        || current.session !== draftReceipt.session
        || current.epoch !== draftReceipt.afterEpoch
        || current.revision !== draftReceipt.afterRevision
        || current.pendingVersion !== draftReceipt.afterPendingVersion
        || current.pending !== draftReceipt.afterPending
        || !mutationTokensMatch(current.mutationToken, draftReceipt.afterMutationToken)
        || current.largeFile !== expected.largeFile
        || current.largePendingEdits !== expected.largePendingEdits
        || current.content !== draftReceipt.content
        || current.dirty !== draftReceipt.dirty) {
        return false;
      }
      if (expected.pending && !draftReceipt.flushReceipt && !draftReceipt.largeFlush) return false;
      if (draftReceipt.flushReceipt
        && (!draftReceipt.beforeMutationToken
          || !draftReceipt.afterMutationToken
          || draftReceipt.flushReceipt.sessionIdentity !== draftReceipt.session
          || !documentMutationTokensEqual(draftReceipt.flushReceipt.before, draftReceipt.beforeMutationToken)
          || !documentMutationTokensEqual(draftReceipt.flushReceipt.after, draftReceipt.afterMutationToken))) {
        return false;
      }
      if (draftReceipt.largeFlush
        && (draftReceipt.largeFlush.session !== expected.session
          || draftReceipt.largeFlush.beforeRevision !== expected.revision
          || draftReceipt.largeFlush.afterRevision !== current.revision
          || !mutationTokensMatch(draftReceipt.largeFlush.beforeToken, expected.mutationToken)
          || !mutationTokensMatch(draftReceipt.largeFlush.afterToken, current.mutationToken))) {
        return false;
      }
      continue;
    }
    if (!isCloseAuthorizationCurrent(expected)) return false;
  }
  return true;
}

function mutationTokensMatch(left: DocumentMutationToken | null, right: DocumentMutationToken | null) {
  if (left == null || right == null) return left == null && right == null;
  return documentMutationTokensEqual(left, right);
}

async function saveTabForClose(tab: DocumentTab) {
  if (!isTabRegistered(tab)) return false;
  if (tab.documentMode === "large") return await saveLargeTabForClose(tab);
  const context = captureSaveContext(tab);
  if (!context) return false;
  return await saveTransactionQueue.enqueue(context.tab, () => runSaveTransaction(context));
}

async function saveTabForWindowClose(tab: DocumentTab, expected: CloseAuthorization) {
  if (!isTabRegistered(tab) || !isWindowCloseSavePromptCurrent(expected)) return false;
  if (tab.documentMode === "large") return await saveLargeTabForClose(tab);
  const context = captureSaveContext(tab);
  if (!context) return false;
  context.windowCloseExpected = expected;
  return await saveTransactionQueue.enqueue(context.tab, () => runSaveTransaction(context));
}

async function saveLargeTabForClose(tab: DocumentTab) {
  if (!tab.largeFile || tab.documentMode !== "large") return false;
  return saveLargeFileForTab(toRaw(tab) as DocumentTab, largePaneForTab(tab));
}

function pendingEditVersion(session: DocumentSessionAdapter | null) {
  const value = session?.pendingEditVersion?.();
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isCapturedTabActive(context: SaveContext) {
  return appStore.activeTabId === context.tab.id && appStore.tabs.includes(context.tab);
}

function setCapturedSaveState(context: SaveContext, state: "dirty" | "saving" | "saved" | "failed") {
  if (isCapturedTabActive(context)) appStore.saveState = state;
}

function publishSaveNotice(tabId: string, state: 'failure' | 'success', message = '') {
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(`lightmark:save-${state}`, { detail: { tabId, message } }));
  }
}

function commitCapturedSave(
  context: SaveContext,
  version: FrozenSaveVersion,
  targetPath: string,
  fileSnapshot: FileSnapshot,
) {
  if (!isFrozenSaveVersionCurrent(version) || targetPath !== context.path) return null;
  const tab = reactive(context.tab);
  tab.content = version.markdown;
  tab.isDirty = false;
  documentHistoryForTab(tab.id).markSaved(version.markdown);
  publishSaveNotice(tab.id, 'success');
  tab.fileSnapshot = fileSnapshot;
  clearTabExternalState(tab);
  if (isCapturedTabActive(context)) {
    appStore.currentContent = version.markdown;
    appStore.currentFilePath = targetPath;
    appStore.isDirty = false;
    appStore.saveState = "saved";
  }
  rememberRecentFile(targetPath);
  return {
    tab: context.tab,
    epoch: mutationEpoch(context.tab),
    session: documentSessionForTab(tab.id),
  };
}

function commitCapturedSaveAs(
  context: SaveContext,
  version: FrozenSaveVersion,
  targetPath: string,
  fileSnapshot: FileSnapshot,
) {
  if (!isFrozenSaveVersionCurrent(version)) return null;
  const tab = reactive(context.tab);
  const previousTabId = tab.id;
  const wasActive = isCapturedTabActive(context);
  tab.content = version.markdown;
  tab.isDirty = false;
  advanceMutationEpoch(context.tab);
  tab.id = tabIdForPath(targetPath);
  rebindDocumentRuntime(previousTabId, tab.id);
  documentHistoryForTab(tab.id).markSaved(version.markdown);
  publishSaveNotice(previousTabId, 'success');
  publishSaveNotice(tab.id, 'success');
  tab.kind = "normal";
  tab.path = targetPath;
  tab.name = fileNameFromPath(targetPath);
  tab.fileSnapshot = fileSnapshot;
  clearTabExternalState(tab);
  appStore.splitLayout = replaceTabIdInSplitLayout(appStore.splitLayout, previousTabId, tab.id, tabIds());
  if (wasActive) {
    appStore.activeTabId = tab.id;
    appStore.currentFilePath = targetPath;
    appStore.currentContent = version.markdown;
    appStore.isDirty = false;
    appStore.saveState = "saved";
  }
  rememberRecentFile(targetPath);
  return {
    tab: context.tab,
    epoch: mutationEpoch(context.tab),
    session: documentSessionForTab(tab.id),
  };
}

function replaceTabIdInSplitLayout(layout: SplitLayoutState, previousTabId: string, nextTabId: string, ids: string[]) {
  const replace = (value: string) => value === previousTabId ? nextTabId : value;
  return normalizeSplitLayout(
    {
      ...layout,
      mainTabId: replace(layout.mainTabId),
      secondaryTabId: replace(layout.secondaryTabId),
      mainTabIds: layout.mainTabIds.map(replace),
      secondaryTabIds: layout.secondaryTabIds.map(replace),
    },
    ids,
    nextTabId,
  );
}

function staleSaveResult(context: SaveContext, message?: string) {
  if (isCapturedTabActive(context)) {
    const dirty = tabHasUnsavedWork(context.tab);
    appStore.isDirty = dirty;
    appStore.saveState = dirty ? "dirty" : "saved";
    if (message) appStore.statusMessage = message;
  }
  return false;
}

function tabHasUnsavedWork(tab: DocumentTab) {
  return tab.isDirty || documentSessionForTab(tab.id)?.hasPendingEdits?.() === true;
}

async function reloadCapturedFileFromDisk(context: SaveContext, version: FrozenSaveVersion) {
  if (!isFrozenSaveVersionCurrent(version)) return false;
  const textSnapshot = await readTextFileSnapshot(context.path);
  const content = textSnapshot.content;
  const snapshot = fileSnapshotFromTextSnapshot(textSnapshot);
  if (!isFrozenSaveVersionCurrent(version)) {
    staleSaveResult(context, "当前文档在重载期间发生了修改，已保留新输入。");
    return false;
  }
  await replaceCapturedTabContent(context.tab, content, false);
  context.tab.fileSnapshot = snapshot;
  clearTabExternalState(context.tab);
  if (isCapturedTabActive(context)) {
    appStore.isDirty = false;
    appStore.saveState = "saved";
    appStore.statusMessage = "已重载磁盘版本";
  }
  return true;
}

async function replaceCapturedTabContent(tab: DocumentTab, content: string, dirty: boolean) {
  const session = documentSessionForTab(tab.id);
  if (session) await session.replaceMarkdown(content);
  advanceMutationEpoch(tab);
  tab.content = content;
  tab.isDirty = dirty;
  if (appStore.activeTabId === tab.id) {
    appStore.currentContent = content;
    appStore.isDirty = dirty;
    appStore.saveState = dirty ? "dirty" : "saved";
  }
  scheduleKnowledgeRefresh();
  scheduleWikiIndexEntryRefresh(tab.path, content);
}

async function saveConflictCopyForContext(context: SaveContext, version: FrozenSaveVersion) {
  if (!isFrozenSaveVersionCurrent(version)) return false;
  const target = conflictCopyPath(context.path);
  const expectedTargetFingerprint = await expectedFingerprintForWriteTarget(target);
  if (!isFrozenSaveVersionCurrent(version)) return false;
  const receipt = await invoke<TextFileWriteReceipt>("write_text_file", {
    path: target,
    content: version.markdown,
    expectedTargetFingerprint,
  });
  assertCommittedTextWrite(receipt);
  if (!isFrozenSaveVersionCurrent(version)) {
    staleSaveResult(context, "旧版本已写入冲突副本，当前仍有未保存修改。");
    return false;
  }
  rememberRecentFile(target);
  await refreshFileTree();
  await persistConfig();
  if (!isFrozenSaveVersionCurrent(version)) {
    staleSaveResult(context, "旧版本已写入冲突副本，当前仍有未保存修改。");
    return false;
  }
  if (isCapturedTabActive(context)) {
    appStore.statusMessage = formatTransactionNotice(
      `已保存冲突副本：${fileNameFromPath(target)}`,
      receipt.cleanupWarning,
      receipt.recoveryArtifact,
    );
  }
  return true;
}

function getFileSnapshot(path: string) {
  return invoke<FileSnapshot>("get_file_snapshot", { path });
}

async function readTextFileSnapshot(path: string) {
  return invoke<TextFileSnapshot>("read_text_file_snapshot", { path });
}

function fileSnapshotFromTextSnapshot(snapshot: TextFileSnapshot): FileSnapshot {
  return {
    exists: true,
    mtime: snapshot.fingerprint.modifiedMillis ?? undefined,
    size: snapshot.fingerprint.sizeBytes,
    fingerprint: snapshot.fingerprint,
  };
}

async function expectedFingerprintForWriteTarget(
  path: string,
  captured?: LargeFileFingerprint,
) {
  if (captured) return captured;
  return await invoke<LargeFileFingerprint | null>("get_large_file_fingerprint", { path });
}

async function getFileSnapshotWithFingerprint(path: string) {
  const snapshot = await getFileSnapshot(path);
  if (snapshot.exists) {
    const fingerprint = await invoke<LargeFileFingerprint | null>("get_large_file_fingerprint", { path });
    if (!fingerprint) {
      throw new Error("无法取得目标文件 fingerprint，已阻止覆盖。");
    }
    snapshot.fingerprint = fingerprint;
  }
  return snapshot;
}

function assertCommittedTextWrite(receipt: TextFileWriteReceipt) {
  if (receipt.outcome === "committed" && receipt.diskWritten === "yes") return;
  throw new Error(formatTextWriteReceiptFailure(receipt));
}

function formatTextWriteReceiptFailure(receipt: TextFileWriteReceipt) {
  const details = [
    `outcome=${receipt.outcome}`,
    `diskWritten=${receipt.diskWritten}`,
    receipt.recoveryArtifact ? `recoveryArtifact=${receipt.recoveryArtifact}` : "",
    receipt.cleanupWarning ? `cleanupWarning=${receipt.cleanupWarning}` : "",
  ].filter(Boolean).join(", ");
  return `文件保存未确认：${details}`;
}

function formatTransactionNotice(prefix: string, cleanupWarning?: string, recoveryArtifact?: string) {
  const details = [
    cleanupWarning ? `清理提示：${cleanupWarning}` : "",
    recoveryArtifact ? `恢复材料：${recoveryArtifact}` : "",
  ].filter(Boolean).join("；");
  return details ? `${prefix}；${details}` : prefix;
}

function snapshotsMatch(left: FileSnapshot, right: FileSnapshot) {
  if (left.fingerprint && right.fingerprint) {
    return left.fingerprint.sha256 === right.fingerprint.sha256
      && left.fingerprint.sizeBytes === right.fingerprint.sizeBytes
      && left.fingerprint.modifiedMillis === right.fingerprint.modifiedMillis;
  }
  return left.exists === right.exists && left.mtime === right.mtime && left.size === right.size;
}

export function startExternalFileMonitor() {
  stopExternalFileMonitor();
  if (typeof window === "undefined") return;
  externalFileWatcherRunning = true;
  externalFileWatcherAvailable = true;
  window.addEventListener("focus", checkOpenFileSnapshotsOnEvent);
  document.addEventListener("visibilitychange", checkOpenFileSnapshotsWhenVisible);
  void syncExternalFileWatches();
  void checkOpenFileSnapshots();
}

export function stopExternalFileMonitor() {
  disableExternalFileFallbackPolling();
  if (typeof window === "undefined") return;
  window.removeEventListener("focus", checkOpenFileSnapshotsOnEvent);
  document.removeEventListener("visibilitychange", checkOpenFileSnapshotsWhenVisible);
  externalFileWatcherRunning = false;
  externalFileWatcherAvailable = true;
  watchedFilePaths.clear();
  void invoke("unwatch_all_markdown_files").catch(() => {});
}

export async function checkOpenFileSnapshots() {
  if (externalFileCheckInFlight) { externalFileCheckQueued = true; return; }
  externalFileCheckInFlight = true;
  try {
    for (const tab of appStore.tabs) {
      if (tab.kind !== "normal" || !tab.path || !tab.fileSnapshot?.exists) continue;
      const path = tab.path, baseline = tab.fileSnapshot, readFence = fileWriteFence.capture(path);
      if (readFence.active) continue;
      const snapshot = await getFileSnapshot(path).catch((): FileSnapshot => ({ exists: false }));
      if (!appStore.tabs.includes(tab) || tab.path !== path || tab.fileSnapshot !== baseline || !fileWriteFence.canPublish(readFence)) {
        externalFileCheckQueued = true;
        continue;
      }
      updateTabExternalState(tab, snapshot);
      if (tab.externalState === "deleted") {
        tab.relocationCandidates = await findSimilarFileCandidates(tab);
      }
    }
  } finally {
    externalFileCheckInFlight = false;
    if (externalFileCheckQueued) {
      externalFileCheckQueued = false;
      queueMicrotask(() => { void checkOpenFileSnapshots(); });
    }
  }
}

export async function syncExternalFileWatches() {
  if (!externalFileWatcherRunning || !externalFileWatcherAvailable) return;
  const next = new Map<string, string>();
  for (const tab of appStore.tabs) {
    if (tab.kind !== "normal" || !tab.path || !tab.fileSnapshot?.exists) continue;
    next.set(normalizePathKey(tab.path), tab.path);
  }

  try {
    for (const [key, path] of watchedFilePaths) {
      if (next.has(key)) continue;
      await invoke("unwatch_markdown_file", { path });
      watchedFilePaths.delete(key);
    }
    for (const [key, path] of next) {
      if (watchedFilePaths.has(key)) continue;
      await invoke("watch_markdown_file", { path });
      watchedFilePaths.set(key, path);
    }
    if (watchedFilePaths.size > 0) disableExternalFileFallbackPolling();
  } catch (error) {
    externalFileWatcherAvailable = false;
    watchedFilePaths.clear();
    enableExternalFileFallbackPolling();
    appStore.statusMessage = `文件监听不可用，已切换为轮询检测：${error}`;
  }
}

export async function reloadCurrentFileFromDisk() {
  syncActiveTabFromProjection();
  const tab = getActiveTab();
  const context = tab && tab.kind === "normal" && tab.path ? captureSaveContext(tab) : null;
  if (!context) return false;
  return saveTransactionQueue.enqueue(context.tab, async () => {
    const version = await captureSaveVersion(context, "externalDiff");
    if (!version) return staleSaveResult(context, "当前文档在重载前发生了变化，已保留新输入。");
    const reloaded = await reloadCapturedFileFromDisk(context, version);
    if (!reloaded) return false;
    await refreshFileTree();
    void syncExternalFileWatches();
    await persistConfig();
    return true;
  });
}

export async function saveCurrentFileAsExternalCopy() {
  syncActiveTabFromProjection();
  const tab = getActiveTab();
  const context = tab && tab.documentMode === "normal" ? captureSaveContext(tab) : null;
  if (!context) return false;
  return saveTransactionQueue.enqueue(context.tab, async () => {
    const target = await chooseSaveAsTargetForContext(context, context.path);
    if (!target) return false;
    const version = await captureSaveVersion(context, "saveAs");
    if (!version) return staleSaveResult(context);
    const expectedTargetFingerprint = await expectedFingerprintForWriteTarget(target);
    if (!isFrozenSaveVersionCurrent(version)) return staleSaveResult(context);
    const receipt = await invoke<TextFileWriteReceipt>('write_text_file', { path: target, content: version.markdown, expectedTargetFingerprint });
    assertCommittedTextWrite(receipt);
    rememberRecentFile(target);
    if (isCapturedTabActive(context)) appStore.statusMessage = `已保存副本：${fileNameFromPath(target)}`;
    return true;
  });
}

export async function saveConflictCopyForCurrentFile() {
  syncActiveTabFromProjection();
  const tab = getActiveTab();
  const context = tab && tab.kind === "normal" && tab.path ? captureSaveContext(tab) : null;
  if (!context) return false;
  return saveTransactionQueue.enqueue(context.tab, async () => {
    const version = await captureSaveVersion(context, "saveAs");
    if (!version) return staleSaveResult(context);
    return saveConflictCopyForContext(context, version);
  });
}

export async function showCurrentFileDiffSummary() {
  syncActiveTabFromProjection();
  const tab = getActiveTab();
  const context = tab && tab.kind === "normal" && tab.path ? captureSaveContext(tab) : null;
  if (!context) return false;
  return saveTransactionQueue.enqueue(context.tab, async () => {
    const version = await captureSaveVersion(context, "externalDiff");
    if (!version) return staleSaveResult(context);
    const details = await conflictDiffDetails(context.path, version.markdown);
    await alertDialog({
      title: "外部修改差异摘要",
      message: "以下是当前内存内容与磁盘内容的简化行级差异。",
      details,
    });
    return true;
  });
}

export async function rebindCurrentFileToCandidate(path: string, targetTabId = appStore.activeTabId) {
  const tab = appStore.tabs.find(item => item.id === targetTabId);
  if (!tab || !path) return false;
  const existing = findFileTab(path);
  if (existing && existing.id !== tab.id) {
    appStore.statusMessage = "候选文件已在其他标签页打开";
    return false;
  }
  const previousPath = tab.path;
  const previousTabId = tab.id;
  const ownsSource = () => tab.id === previousTabId && tab.path === previousPath && appStore.tabs.includes(tab);
  const snapshot = tab.documentMode === "large"
    ? await getFileSnapshot(path)
    : await readRelocationSnapshot(path, tab.fileSnapshot?.fingerprint?.sha256);
  if (!snapshot.exists || !ownsSource() || findFileTab(path)) return false;
  if (tab.documentMode === "normal" && documentSessionForTab(previousTabId)) {
    await flushDocumentSnapshot(previousTabId, "externalDiff");
    if (!ownsSource() || findFileTab(path)) return false;
  }
  const isActive = appStore.activeTabId === previousTabId;
  advanceMutationEpoch(tab);
  tab.id = tabIdForPath(path);
  rebindDocumentRuntime(previousTabId, tab.id);
  tab.path = path;
  tab.name = fileNameFromPath(path);
  tab.fileSnapshot = snapshot;
  clearTabExternalState(tab);
  if (isActive) {
    appStore.activeTabId = tab.id;
    appStore.currentFilePath = path;
  }
  appStore.splitLayout = replaceTabIdInSplitLayout(appStore.splitLayout, previousTabId, tab.id, tabIds());
  rememberRecentFile(path);
  await refreshFileTree();
  void syncExternalFileWatches();
  await persistConfig();
  appStore.statusMessage = `已将标签从 ${fileNameFromPath(previousPath)} 重新绑定到 ${fileNameFromPath(path)}`;
  return true;
}

export function dismissCurrentExternalFileState() {
  const tab = getActiveTab();
  if (!tab) return;
  dismissTabExternalState(tab);
}

async function readRelocationSnapshot(path: string, expectedSha256?: string) {
  const fingerprint = await invoke<LargeFileFingerprint>("read_relocated_markdown_fingerprint", { path, expectedSha256 });
  return fileSnapshotFromFingerprint(fingerprint);
}

function checkOpenFileSnapshotsOnEvent() {
  void checkOpenFileSnapshots();
}

function checkOpenFileSnapshotsWhenVisible() {
  if (document.visibilityState === "visible") void checkOpenFileSnapshots();
}

function enableExternalFileFallbackPolling() {
  if (typeof window === "undefined" || externalFileFallbackTimer) return;
  externalFileFallbackTimer = window.setInterval(() => {
    void checkOpenFileSnapshots();
  }, EXTERNAL_FILE_CHECK_INTERVAL_MS);
}

function disableExternalFileFallbackPolling() {
  if (!externalFileFallbackTimer || typeof window === "undefined") return;
  window.clearInterval(externalFileFallbackTimer);
  externalFileFallbackTimer = 0;
}

function updateTabExternalState(tab: DocumentTab, snapshot: FileSnapshot) {
  const nextState = externalStateForSnapshot(tab.fileSnapshot, snapshot);
  if (nextState === "clean") {
    clearTabExternalState(tab);
    return;
  }
  if (tab.externalDismissedKey === snapshotKey(snapshot)) return;
  tab.externalState = nextState;
  tab.externalSnapshot = snapshot;
  tab.externalDetectedAt = Date.now();
}

function externalStateForSnapshot(baseline: FileSnapshot | undefined, current: FileSnapshot): ExternalFileState {
  if (!baseline?.exists) return "clean";
  if (!current.exists) return "deleted";
  return snapshotsMatch(baseline, current) ? "clean" : "modified";
}

function clearTabExternalState(tab: DocumentTab) {
  tab.externalState = "clean";
  tab.externalSnapshot = undefined;
  tab.relocationCandidates = undefined;
  tab.externalDetectedAt = undefined;
  tab.externalDismissedKey = undefined;
}

function snapshotKey(snapshot: FileSnapshot | undefined) {
  if (!snapshot?.exists) return "missing";
  return `${snapshot.mtime ?? "unknown"}:${snapshot.size ?? "unknown"}`;
}

function dismissTabExternalState(tab: DocumentTab) {
  tab.externalDismissedKey = snapshotKey(tab.externalSnapshot);
  tab.externalState = "clean";
  tab.externalSnapshot = undefined;
  tab.relocationCandidates = undefined;
  tab.externalDetectedAt = undefined;
}

export function createUntitledTab(
  content = "",
  dirty = false,
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
) {
  syncActiveTabFromProjection();
  const tab = createTab({
    path: "",
    kind: "untitled",
    content,
    documentMode: "normal",
    editorMode: appStore.settings.editor.defaultMode,
    largeFile: null,
    isDirty: dirty,
  });
  appStore.tabs.push(tab);
  projectTabInPane(tab, paneId);
  void persistConfig();
  return tab;
}

/**
 * User initiated new-tab creation.  The synchronous primitive above remains
 * available for startup/bootstrap callers; UI entry points must first settle
 * the pane's mounted editor and then verify that the same raw tab/session is
 * still mapped to that pane before replacing it with a new document.
 */
export async function createUntitledTabAfterFlush(
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
  content = "",
  dirty = false,
) {
  if (!await setActivePane(paneId)) return null;
  const activation = await preparePaneActivation(paneId, "tabSwitch");
  // Keep the post-flush fence at the consumer boundary as well as inside the
  // helper.  This closes the microtask gap before the synchronous projection
  // replaces the pane with the new tab.
  if (!activation || !paneActivationFenceStillCurrent(activation.fence, activation.flushed)) {
    appStore.statusMessage = "新标签页创建期间当前文档或编辑器会话发生了变化，已保留当前输入。";
    return null;
  }
  return createUntitledTab(content, dirty, paneId);
}

/** Open a dedicated untitled target for a future Rust-owned large draft. */
export function createRecoveredLargeTab(
  receipt: LargeDraftOpenReceipt,
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
) {
  syncActiveTabFromProjection();
  const session = receipt.session;
  const tab = createTab({
    path: "",
    kind: "large",
    content: "",
    documentMode: "large",
    editorMode: "source",
    largeFile: {
      sessionId: session.sessionId,
      sizeBytes: session.sizeBytes,
      totalLines: session.totalLines,
      loadedRanges: [],
      pendingEdits: [],
      outline: session.outline,
      revision: session.revision,
      savedRevision: session.savedRevision,
      pendingEditCount: session.pendingEditCount,
      baseFingerprint: session.baseFingerprint,
      diskFingerprint: session.diskFingerprint,
      coordinateSpace: session.coordinateSpace,
      targetPath: null,
      originPath: receipt.originPath,
      recoveryDraftId: receipt.recoveryDraftId,
    },
    // The recovered remote view is intentionally dirty until the user saves
    // it to a new target path, even if the snapshot opened with no edit batch.
    isDirty: true,
  });
  initializeLargeSession(tab);
  appStore.tabs.push(tab);
  projectTabInPane(tab, paneId);
  appStore.isDirty = true;
  appStore.saveState = "dirty";
  appStore.statusMessage = `已恢复大文件草稿${receipt.originPath ? `：${fileNameFromPath(receipt.originPath)}` : ""}，请另存为。`;
  void persistConfig();
  return tab;
}

export function ensureDefaultTab() {
  if (appStore.tabs.length > 0) return;
  createUntitledTab("", false);
}

export type PaneActivationFence = {
  paneId: EditorPaneId;
  tab: DocumentTab | null;
  tabId: string;
  session: DocumentSessionAdapter | null;
  revision: number | null;
  mutationToken: DocumentMutationToken | null;
  documentMode: DocumentTab["documentMode"] | null;
  content: string | null;
  dirty: boolean | null;
};

export function capturePaneActivationFence(paneId: EditorPaneId): PaneActivationFence {
  const candidate = getPaneTab(paneId);
  const tab = candidate ? toRaw(candidate) as DocumentTab : null;
  const session = tab ? documentSessionForTab(tab.id) : null;
  return {
    paneId,
    tab,
    tabId: tab?.id ?? "",
    session,
    revision: session?.revision ?? null,
    mutationToken: session?.mutationToken?.() ?? null,
    documentMode: tab?.documentMode ?? null,
    // A pane without a mounted adapter has no flush receipt to authorize an
    // intervening projection update, so retain its visible bytes as a small
    // fallback fence. Adapter backed panes validate their own mutation token.
    content: tab && !session ? tab.content : null,
    dirty: tab && !session ? tab.isDirty : null,
  };
}

function paneOwnsRawTab(paneId: EditorPaneId, expected: DocumentTab) {
  const current = getPaneTab(paneId);
  return Boolean(current && toRaw(current) === expected && isTabRegistered(expected));
}

export function paneActivationFenceStillCurrent(fence: PaneActivationFence, flushed: PaneFlushResult | null = null) {
  const candidate = getPaneTab(fence.paneId);
  const tab = candidate ? toRaw(candidate) as DocumentTab : null;
  if (tab !== fence.tab || (tab?.id ?? "") !== fence.tabId) return false;
  if (!tab) return true;
  const session = documentSessionForTab(tab.id);
  const capturedSession = fence.session;
  if (session !== capturedSession) return false;
  if (fence.documentMode !== tab.documentMode) return false;
  if (capturedSession) {
    const currentSession = capturedSession;
    const authorized = flushed?.session === capturedSession;
    const expectedRevision = authorized ? flushed.afterRevision : fence.revision;
    if (expectedRevision !== null && currentSession.revision !== expectedRevision) return false;
    const currentToken = currentSession.mutationToken?.() ?? null;
    const expectedToken = authorized ? flushed.afterToken : fence.mutationToken;
    if (expectedToken || currentToken) {
      return Boolean(expectedToken && currentToken && documentMutationTokensEqual(currentToken, expectedToken));
    }
    return true;
  }
  return tab.content === fence.content && tab.isDirty === fence.dirty;
}

export type PaneActivationBoundary = {
  fence: PaneActivationFence;
  flushed: PaneFlushResult | null;
};

/** Flush a pane and return a post-flush token that authorizes its projection. */
export async function preparePaneActivation(
  paneId: EditorPaneId,
  reason: SnapshotReason,
): Promise<PaneActivationBoundary | null> {
  // An async editor can mount while its first open command is flushing. Wait
  // before capturing the session fence, while still rejecting intervening input.
  const initial = getPaneTab(paneId);
  if (initial && !documentSessionForTab(initial.id)
    && typeof document !== "undefined") {
    const owner = toRaw(initial) as DocumentTab;
    const content = owner.content; const dirty = owner.isDirty; const mode = owner.editorMode;
    const ownerId = owner.id; const ownerPath = owner.path; const ownerEpoch = mutationEpoch(owner);
    try { await waitForDocumentSession(ownerId, mode, 30000); }
    catch (error) { appStore.statusMessage = `编辑器尚未就绪，已保留当前文档：${String(error)}`; return null; }
    if (!paneOwnsRawTab(paneId, owner) || owner.id !== ownerId || owner.path !== ownerPath || mutationEpoch(owner) !== ownerEpoch
      || owner.content !== content || owner.isDirty !== dirty || owner.editorMode !== mode) {
      appStore.statusMessage = "等待编辑器期间文档发生了变化，已保留当前输入。"; return null;
    }
  }
  const fence = capturePaneActivationFence(paneId);
  const flushed = fence.tab ? await flushPanePendingEdits(paneId, reason) : null;
  if (!paneActivationFenceStillCurrent(fence, flushed)) {
    appStore.statusMessage = "文档或编辑器会话在切换期间发生了变化，已保留当前输入。";
    return null;
  }
  return { fence, flushed };
}

export async function activateTab(tabId: string) {
  await activateTabInPane(appStore.splitLayout.activePaneId, tabId);
}

export async function activateTabInPane(paneId: EditorPaneId, tabId: string) {
  if (tabId === appStore.activeTabId && paneId === appStore.splitLayout.activePaneId) return;
  const activation = await preparePaneActivation(paneId, "tabSwitch");
  if (!activation || !paneActivationFenceStillCurrent(activation.fence, activation.flushed)) {
    appStore.statusMessage = "切换标签页期间当前文档或编辑器会话发生了变化，已保留当前输入。";
    return false;
  }
  syncActiveTabFromProjection();
  const candidate = appStore.tabs.find((item) => item.id === tabId);
  const tab = candidate ? toRaw(candidate) as DocumentTab : null;
  if (!tab || !isTabRegistered(tab)) return false;
  if (!paneActivationFenceStillCurrent(activation.fence, activation.flushed)) {
    appStore.statusMessage = "切换标签页期间当前文档或编辑器会话发生了变化，已保留当前输入。";
    return false;
  }
  projectTabInPane(tab, paneId);
  await nextTick();
  if (!paneOwnsRawTab(paneId, tab)) {
    appStore.statusMessage = "标签页切换完成前目标栏位已变化，已保留当前输入。";
    return false;
  }
  let targetSession: DocumentSessionAdapter | null = null;
  if (tab.documentMode === "normal") {
    targetSession = await waitForDocumentSession(tab.id, tab.editorMode);
    if (!paneOwnsRawTab(paneId, tab) || documentSessionForTab(tab.id) !== targetSession) {
      appStore.statusMessage = "标签页编辑器初始化期间文档或会话已变化，已保留当前输入。";
      return false;
    }
  }
  void refreshBacklinks();
  await persistConfig();
  if (!paneOwnsRawTab(paneId, tab)) {
    appStore.statusMessage = "标签页切换期间目标栏位已变化，已保留当前输入。";
    return false;
  }
  return true;
}

export async function setActivePane(paneId: EditorPaneId) {
  const previousActivePaneId = appStore.splitLayout.activePaneId;
  if (paneId === previousActivePaneId) {
    // Pointer activation of the already active split pane is a focus action,
    // not a document transition.  The explicit new-tab/recovery wrappers own
    // their required flush so this hot path cannot submit a local buffer.
    syncActiveTabFromProjection();
    return true;
  }
  const previousActive = capturePaneActivationFence(previousActivePaneId);
  const previousTarget = capturePaneActivationFence(paneId);
  const flushed = previousActive.tab ? await flushPanePendingEdits(previousActivePaneId, "tabSwitch") : null;
  if (appStore.splitLayout.activePaneId !== previousActivePaneId
    || !paneActivationFenceStillCurrent(previousActive, flushed)
    || !paneActivationFenceStillCurrent(previousTarget)) {
    appStore.statusMessage = "切换栏位期间文档或编辑器会话发生了变化，已保留当前输入。";
    return false;
  }
  if (paneId === previousActivePaneId) {
    syncActiveTabFromProjection();
    return true;
  }
  syncActiveTabFromProjection();
  const nextTabId = paneTabId(appStore.splitLayout, paneId) || appStore.activeTabId;
  const tab = appStore.tabs.find((item) => item.id === nextTabId) ?? getActiveTab();
  appStore.splitLayout = normalizeSplitLayout({ ...appStore.splitLayout, activePaneId: paneId }, tabIds(), tab?.id ?? "");
  if (tab) projectTab(tab);
  dispatchWritingModesChanged();
  await persistConfig();
  return true;
}

export async function toggleSplitLayout() {
  if (appStore.splitLayout.enabled) {
    const mainFence = capturePaneActivationFence("main");
    const secondaryFence = capturePaneActivationFence("secondary");
    const mainFlushed = mainFence.tab ? await flushPanePendingEdits("main", "tabSwitch") : null;
    if (!paneActivationFenceStillCurrent(mainFence, mainFlushed)) {
      appStore.statusMessage = "关闭分屏期间主栏文档或编辑器会话发生了变化，已保留当前输入。";
      return false;
    }
    const secondaryFlushed = secondaryFence.tab ? await flushPanePendingEdits("secondary", "tabSwitch") : null;
    // The first pane is checked again after the second await: a new input
    // event can arrive while the other editor is flushing, and disabling the
    // split must not unload that newer buffer.
    if (appStore.splitLayout.enabled !== true
      || !paneActivationFenceStillCurrent(mainFence, mainFlushed)
      || !paneActivationFenceStillCurrent(secondaryFence, secondaryFlushed)) {
      appStore.statusMessage = "关闭分屏期间文档或编辑器会话发生了变化，已保留当前输入。";
      return false;
    }
    appStore.splitLayout = disableSplitLayout(appStore.splitLayout);
  } else {
    appStore.splitLayout = enableSplitLayout(appStore.splitLayout, tabIds());
    ensureSecondarySplitTab();
  }
  const tab = appStore.tabs.find((item) => item.id === paneTabId(appStore.splitLayout, appStore.splitLayout.activePaneId)) ?? getActiveTab();
  if (tab) projectTab(tab);
  await persistConfig();
}

export function setSplitRatio(ratio: number) {
  appStore.splitLayout = normalizeSplitLayout({ ...appStore.splitLayout, ratio }, tabIds(), appStore.activeTabId);
  void persistConfig();
}

export async function closeTab(tabId: string) {
  await closeTabInternal(tabId, { ensureDefault: true });
  void syncExternalFileWatches();
  await persistConfig();
}

export async function closeOtherTabs(tabId: string) {
  const keep = appStore.tabs.find((tab) => tab.id === tabId);
  if (!keep) return;
  const targets = appStore.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id);
  let interrupted = false;
  for (const id of targets) {
    const closed = await closeTabInternal(id, { ensureDefault: false, nextActiveId: tabId });
    if (!closed) {
      interrupted = true;
      break;
    }
  }
  if (!interrupted && appStore.tabs.some((tab) => tab.id === tabId)) {
    await activateTab(tabId);
  }
  await persistConfig();
  void syncExternalFileWatches();
}

export async function closeAllTabs() {
  for (const id of appStore.tabs.map((tab) => tab.id)) {
    const closed = await closeTabInternal(id, { ensureDefault: false });
    if (!closed) break;
  }
  if (appStore.tabs.length === 0) {
    resetOpenDocument();
    ensureDefaultTab();
  }
  await persistConfig();
  void syncExternalFileWatches();
}

export async function reopenLastClosedTab() {
  while (appStore.closedTabs.length > 0) {
    const record = appStore.closedTabs.shift();
    if (!record?.path) continue;
    const existing = findFileTab(record.path);
    if (existing) {
      await activateTab(existing.id);
      await persistConfig();
      return true;
    }
    try {
      await openFile(record.path);
      const tab = findFileTab(record.path);
      if (tab) {
        tab.editorMode = record.editorMode;
        projectTab(tab);
      }
      await persistConfig();
      return true;
    } catch (error) {
      appStore.statusMessage = `无法恢复最近关闭的标签：${error}`;
    }
  }
  appStore.statusMessage = "没有可恢复的最近关闭标签";
  return false;
}

export async function moveTab(tabId: string, targetIndex: number) {
  syncActiveTabFromProjection();
  const fromIndex = appStore.tabs.findIndex((tab) => tab.id === tabId);
  if (fromIndex < 0) return;
  const [tab] = appStore.tabs.splice(fromIndex, 1);
  const nextIndex = Math.max(0, Math.min(targetIndex, appStore.tabs.length));
  appStore.tabs.splice(nextIndex, 0, tab);
  await persistConfig();
}

export function getDirtyTabs() {
  syncActiveTabFromProjection();
  const dirtyTabs = appStore.tabs.filter((tab) => tab.isDirty || documentSessionForTab(tab.id)?.hasPendingEdits?.() === true);
  const active = getActiveTab();
  if (active && dirtyTabs.includes(active)) {
    appStore.isDirty = true;
    appStore.saveState = "dirty";
  }
  return dirtyTabs;
}

/**
 * Save the versions authorized by a window-close confirmation.  This path
 * intentionally does not activate background tabs: mounting a different
 * editor can replace the captured session and invalidate the very version the
 * user just authorized.
 */
export async function saveAllDirtyTabsForClose(
  authorization: WindowCloseAuthorization,
): Promise<{ saved: boolean; receipts: WindowCloseSaveReceipt[]; error?: unknown }> {
  const receipts: WindowCloseSaveReceipt[] = [];
  const dirty = authorization.tabs.filter((version) => version.dirty || version.pending);
  for (const version of dirty) {
    if (!isWindowCloseAuthorizationCurrent(authorization, receipts)) {
      return { saved: false, receipts, error: new Error("保存全部期间文档或标签页发生了变化。") };
    }
    try {
      const saved = await saveTabForWindowClose(version.tab, version);
      if (!saved) {
        return { saved: false, receipts, error: new Error(`“${version.tab.name}”未能保存当前版本。`) };
      }
      const after = captureCloseAuthorization(version.tab);
      if (after.dirty || after.pending) {
        return { saved: false, receipts, error: new Error(`“${version.tab.name}”保存后仍有未保存修改。`) };
      }
      receipts.push({
        tab: version.tab,
        before: version,
        after,
        retargeted: version.tabId !== after.tabId || version.path !== after.path,
      });
      if (!isWindowCloseAuthorizationCurrent(authorization, receipts)) {
        return { saved: false, receipts, error: new Error("保存全部期间文档或标签页发生了变化。") };
      }
    } catch (error) {
      return { saved: false, receipts, error };
    }
  }
  if (getDirtyTabs().length > 0 || !isWindowCloseAuthorizationCurrent(authorization, receipts)) {
    return { saved: false, receipts, error: new Error("仍有未保存修改，未准备关闭窗口。") };
  }
  return { saved: true, receipts };
}

export async function saveAllDirtyTabs() {
  const dirtyTabs = getDirtyTabs();
  for (const tab of dirtyTabs) {
    let saved: boolean;
    if (tab.kind === "large") {
      await activateTab(tab.id);
      saved = await saveCurrentFile();
    } else {
      await activateTab(tab.id);
      const context = appStore.tabs.includes(tab) ? captureSaveContext(tab) : null;
      saved = context
        ? await saveTransactionQueue.enqueue(tab, () => runSaveTransaction(context))
        : false;
    }
    if (!saved) return false;
  }
  return getDirtyTabs().length === 0;
}

export async function createNewFile() {
  if (!appStore.currentWorkspace) {
    await openWorkspace();
    if (!appStore.currentWorkspace) return;
  }
  const base = `未命名-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
  const path = await invoke<string>("create_markdown_file", {
    folder: appStore.currentWorkspace,
    name: base,
    renameOnConflict: true,
  });
  await refreshFileTree();
  await openFile(path);
}

export async function switchMode(mode: EditorMode, paneId: EditorPaneId = appStore.splitLayout.activePaneId) {
  const tab = getPaneTab(paneId);
  if (!tab) return;
  if (tab.documentMode === "large") {
    tab.editorMode = "source";
    if (paneId === appStore.splitLayout.activePaneId) appStore.editorMode = "source";
    return;
  }
  if (mode === tab.editorMode) return;
  const owner = toRaw(tab), originalMode = tab.editorMode;
  const markdown = await flushDocumentSnapshot(tab.id, 'modeSwitch');
  if (toRaw(getPaneTab(paneId)) !== owner || tab.editorMode !== originalMode || !appStore.tabs.some(candidate => toRaw(candidate) === owner)) return;
  const originalSession = documentSessionForTab(tab.id);
  const originalRevision = originalSession?.revision;
  let sourceBookmark: { anchor: number; head: number } | null = null;
  if (originalSession?.captureHistoryRoot && originalSession.captureHistoryBookmark) {
    const { historySourceBookmark } = await import('../editor/historySource');
    sourceBookmark = await historySourceBookmark({ root: originalSession.captureHistoryRoot(), bookmark: originalSession.captureHistoryBookmark() }, markdown);
    if (toRaw(getPaneTab(paneId)) !== owner || documentSessionForTab(tab.id) !== originalSession || originalSession.revision !== originalRevision || originalSession.hasPendingEdits?.()) return;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("lightmark:capture-mode-cursor", {
        detail: { from: tab.editorMode, to: mode, paneId },
      }),
    );
  }
  if (sourceBookmark) setPanePendingModeCursor(paneId, { targetMode: mode, markdownAnchor: sourceBookmark.anchor, markdownHead: sourceBookmark.head, reason: 'mode-switch' });
  tab.editorMode = mode;
  if (paneId === appStore.splitLayout.activePaneId || tab.id === appStore.activeTabId) {
    appStore.editorMode = mode;
    syncActiveTabFromProjection();
  }
  dispatchWritingModesChanged();
  await nextTick();
  const nextSession = await waitForDocumentSession(tab.id, mode);
  if (sourceBookmark && toRaw(getPaneTab(paneId)) === owner) await nextSession.restoreSourceBookmark?.(markdown, sourceBookmark);
}

function dispatchWritingModesChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("lightmark:writing-modes-changed"));
  }
}

function writingModesAvailable() {
  const tab = getPaneTab(appStore.splitLayout.activePaneId);
  if (tab?.documentMode !== "large") return true;
  appStore.statusMessage = "大文件模式暂不支持专注模式与打字机模式。";
  return false;
}

export async function toggleFocusMode(force?: boolean) {
  if (!writingModesAvailable()) return false;
  const enabled = force ?? !appStore.settings.editor.focusMode;
  appStore.settings.editor.focusMode = enabled;
  dispatchWritingModesChanged();
  appStore.statusMessage = `专注模式已${enabled ? "开启" : "关闭"}`;
  await persistConfig();
  return true;
}

export async function toggleTypewriterMode(force?: boolean) {
  if (!writingModesAvailable()) return false;
  const enabled = force ?? !appStore.settings.editor.typewriterMode;
  appStore.settings.editor.typewriterMode = enabled;
  dispatchWritingModesChanged();
  appStore.statusMessage = `打字机模式已${enabled ? "开启" : "关闭"}`;
  await persistConfig();
  return true;
}

export function toggleDistractionFreeMode(force?: boolean) {
  const enabled = force ?? !appStore.distractionFreeMode;
  appStore.distractionFreeMode = enabled;
  window.clearTimeout(distractionHintTimer);
  appStore.distractionHintVisible = enabled;
  if (enabled) {
    appStore.wordCountOpen = false;
    closeTransientPalettes();
    distractionHintTimer = window.setTimeout(() => {
      appStore.distractionHintVisible = false;
    }, 2200);
  }
  appStore.statusMessage = `无干扰模式已${enabled ? "开启" : "关闭"}`;
  dispatchWritingModesChanged();
  return enabled;
}

class LargeOutboxBlockedError extends Error {
  readonly code = "large-outbox-blocked" as const;

  constructor() {
    super("前一个大文件编辑尚未成功，已保留后续输入等待显式重试。");
    this.name = "LargeOutboxBlockedError";
  }
}

export async function readLargeFileChunk(
  startLine: number,
  lineCount: number,
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
) {
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  return largeQueueFor(captured.tab).enqueue(
    "read",
    captured,
    () => currentLargeSessionIdentity(captured),
    async (_captured, current) => {
      const chunk = await invoke<FileChunk>("read_file_chunk", {
        sessionId: current.sessionId,
        startLine,
        lineCount,
        expectedRevision: current.revision,
        coordinateSpace: LARGE_COORDINATE_SPACE,
      });
      if (chunk.sessionId !== current.sessionId || chunk.coordinateSpace !== LARGE_COORDINATE_SPACE) {
        throw new LargeSessionStaleError("大文件读取返回了错误的会话或坐标空间。");
      }
      const largeFile = reactive(current.tab).largeFile;
      if (!largeFile) throw new LargeSessionStaleError();
      largeFile.revision = chunk.revision;
      largeFile.coordinateSpace = chunk.coordinateSpace;
      largeFile.loadedRanges = mergeLoadedRanges(largeFile.loadedRanges, {
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
      return chunk;
    },
  );
}

/** Bounded UTF-8 range reads share the edit/save session queue. */
export async function readLargeFileRange(range: LargeRangeRequest, paneId: EditorPaneId = appStore.splitLayout.activePaneId) {
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  return largeQueueFor(captured.tab).enqueue("range-read", captured,
    () => currentLargeSessionIdentity(captured),
    async (_captured, current) => readLargeSourceRange(current, range));
}

const largeHistoryOutbox = new WeakMap<DocumentTab, { operationId: string; direction: "undo" | "redo"; revision: number }>();
export async function moveLargeFileHistory(direction: "undo" | "redo", paneId: EditorPaneId = appStore.splitLayout.activePaneId) {
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  let operation = largeHistoryOutbox.get(captured.tab);
  if (operation && operation.direction !== direction) throw new Error("前一次撤销或重做尚未确认，请先重试相同操作。");
  if (!operation) {
    operation = { operationId: crypto.randomUUID(), direction, revision: captured.revision };
    largeHistoryOutbox.set(captured.tab, operation);
  }
  const { operationId, revision } = operation;
  return largeQueueFor(captured.tab).enqueue("history", captured,
    () => currentLargeSessionIdentity(captured), async (_captured, current) => {
      if (largeOutboxFor(current.tab).length) throw new LargeOutboxBlockedError();
      const state = await invokeLargeSource<DirtyState & { operationId: string; totalLines?: number }>("move_large_history", {
        sessionId: current.sessionId, expectedRevision: revision,
        coordinateSpace: LARGE_COORDINATE_SPACE, direction, operationId,
      });
      if (state.operationId !== operationId || state.coordinateSpace !== LARGE_COORDINATE_SPACE
        || state.revision < current.revision) throw new LargeSessionStaleError("大文件历史回执不匹配。");
      setLargeBackendState(current.tab, state);
      if (state.totalLines != null && current.tab.largeFile) current.tab.largeFile.totalLines = state.totalLines;
      syncLargeOutboxProjection(current.tab);
      largeHistoryOutbox.delete(captured.tab);
      return state;
    });
}

export async function exportLargeFileRange(range: LargeRangeRequest, path: string, paneId: EditorPaneId = appStore.splitLayout.activePaneId) {
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  return largeQueueFor(captured.tab).enqueue("range-export", captured,
    () => currentLargeSessionIdentity(captured), async (_captured, current) => {
      const receipt = await invokeLargeSource<{ sessionId: string; revision: number; path: string; byteLength: number }>("export_large_range", {
        sessionId: current.sessionId, expectedRevision: current.revision, coordinateSpace: LARGE_COORDINATE_SPACE,
        startLine: range.start.line, startColumn: range.start.column,
        endLine: range.end?.line, endColumn: range.end?.column, path,
      });
      if (receipt.sessionId !== current.sessionId || receipt.revision !== current.revision || receipt.path !== path) {
        throw new LargeSessionStaleError("选区导出回执不匹配。");
      }
      return receipt;
    });
}

/** Capture a full large-file draft through the same per-tab queue as edits. */
export async function captureLargeFileDraftSnapshot(
  draftId: string,
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
) {
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  return largeQueueFor(captured.tab).enqueue(
    "draft",
    captured,
    () => currentLargeSessionIdentity(captured),
    async (_captured, current) => {
      const receipt = await invoke<LargeDraftCaptureReceipt>("capture_large_file_draft", {
        sessionId: current.sessionId,
        draftId,
        expectedRevision: current.revision,
        coordinateSpace: LARGE_COORDINATE_SPACE,
      });
      if (receipt.sessionId !== current.sessionId
        || receipt.requestedRevision !== current.revision
        || receipt.currentRevision !== receipt.requestedRevision
        || receipt.snapshot.coordinateSpace !== LARGE_COORDINATE_SPACE
        || receipt.snapshot.draftId !== draftId) {
        throw new LargeSessionStaleError("大文件草稿回执与当前会话版本不一致。");
      }
      return receipt;
    },
  );
}

export async function applyLargeFileEdits(
  edits: TextEdit[],
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
) {
  if (edits.length === 0) return;
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  if (largeHistoryOutbox.has(captured.tab)) throw new Error("前一次历史操作尚未确认，请先重试相同撤销或重做。");
  const batch: LargeOutboxBatch = {
    id: `large-edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    edits: edits.map((edit) => ({ ...edit })),
    expectedRevision: captured.revision,
    sessionId: captured.sessionId,
  };
  const outbox = largeOutboxFor(captured.tab);
  outbox.push(batch);
  syncLargeOutboxProjection(captured.tab);
  const queue = largeQueueFor(captured.tab);
  try {
    const state = await queue.enqueue(
      "apply",
      captured,
      () => currentLargeSessionIdentity(captured),
      async (_captured, current) => {
        const index = outbox.indexOf(batch);
        if (index < 0) throw new LargeSessionStaleError("大文件编辑已从待处理队列移除。");
        if (outbox.slice(0, index).some((item) => item.failed)) throw new LargeOutboxBlockedError();
        if (batch.sessionId !== current.sessionId || batch.expectedRevision !== current.revision) {
          throw new LargeOutboxStaleError();
        }
        const nextState = await invokeLargeSource<DirtyState & { operationId: string }>("apply_file_operation", {
          sessionId: current.sessionId,
          edits: batch.edits,
          expectedRevision: current.revision,
          coordinateSpace: LARGE_COORDINATE_SPACE,
          operationId: batch.id,
        });
        if (nextState.operationId !== batch.id || nextState.coordinateSpace !== LARGE_COORDINATE_SPACE
          || nextState.revision < current.revision) {
          throw new LargeSessionStaleError("大文件编辑回执缺少有效的会话版本，已保留输入。");
        }
        setLargeBackendState(current.tab, nextState);
        outbox.splice(index, 1);
        syncLargeOutboxProjection(current.tab);
        return nextState;
      },
    );
    appStore.statusMessage = `待保存编辑：${currentLargeSessionIdentity(captured)?.tab.largeFile?.pendingEditCount ?? 0}`;
    return state;
  } catch (error) {
    if (!(error instanceof LargeOutboxBlockedError)) batch.failed = error;
    syncLargeOutboxProjection(captured.tab);
    if (captured.tab.id === appStore.activeTabId) {
      appStore.isDirty = true;
      appStore.saveState = "failed";
      appStore.statusMessage = `大文件编辑未提交，输入已保留：${formatLargeTransactionEvidence(error)}`;
    }
    throw error;
  }
}

export function formatLargeTransactionEvidence(value: unknown) {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "大文件事务失败";
    const details = [
      typeof record.code === "string" ? `code=${record.code}` : "",
      typeof record.outcome === "string" ? `outcome=${record.outcome}` : "",
      typeof record.diskWritten === "string" ? `diskWritten=${record.diskWritten}` : "",
      typeof record.recoveryArtifact === "string" ? `recoveryArtifact=${record.recoveryArtifact}` : "",
      typeof record.cleanupWarning === "string" ? `cleanupWarning=${record.cleanupWarning}` : "",
    ].filter(Boolean).join(", ");
    return details ? `${message}（${details}）` : message;
  }
  return String(value);
}

function formatLargeSaveReceiptFailure(receipt: LargeSaveReceipt) {
  const details = [
    `outcome=${receipt.outcome}`,
    `diskWritten=${receipt.diskWritten}`,
    receipt.recoveryArtifact ? `recoveryArtifact=${receipt.recoveryArtifact}` : "",
    receipt.cleanupWarning ? `cleanupWarning=${receipt.cleanupWarning}` : "",
  ].filter(Boolean).join(", ");
  return `大文件保存未确认：${details}`;
}

class LargeOutboxStaleError extends Error {
  readonly code = "large-outbox-stale" as const;

  constructor() {
    super("大文件编辑坐标对应的版本已变化，已保留输入，请显式重试。");
    this.name = "LargeOutboxStaleError";
  }
}

/**
 * Explicitly rebase one failed outbox batch to the caller's current view.
 * The caller must provide fresh coordinates; the old batch is never replayed
 * automatically after a revision change.
 */
export async function retryLargeFileEdits(
  edits: TextEdit[],
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
) {
  if (edits.length === 0) return;
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  const outbox = largeOutboxFor(captured.tab);
  const failed = outbox.find((item) => item.failed !== undefined);
  if (!failed) throw new Error("没有可显式重试的大文件编辑。");
  if (failed.sessionId !== captured.sessionId) throw new LargeSessionStaleError();
  if (JSON.stringify(edits) !== JSON.stringify(failed.edits)) {
    throw new LargeSessionStaleError('重试必须使用原 operationId 的相同输入；当前输入已保留。');
  }
  failed.failed = undefined;
  syncLargeOutboxProjection(captured.tab);
  try {
    return await largeQueueFor(captured.tab).enqueue(
      "retry-apply",
      captured,
      () => currentLargeSessionIdentity(captured),
      async (_captured, current) => {
        const index = outbox.indexOf(failed);
        if (index < 0 || index !== outbox.findIndex((item) => item === failed)) throw new LargeSessionStaleError();
        if (outbox.slice(0, index).some((item) => item.failed)) throw new LargeOutboxBlockedError();
        if (failed.sessionId !== current.sessionId) {
          throw new LargeOutboxStaleError();
        }
        const state = await invokeLargeSource<DirtyState & { operationId: string }>("apply_file_operation", {
          sessionId: current.sessionId,
          edits: failed.edits,
          expectedRevision: failed.expectedRevision,
          coordinateSpace: LARGE_COORDINATE_SPACE,
          operationId: failed.id,
        });
        if (state.operationId !== failed.id || state.coordinateSpace !== LARGE_COORDINATE_SPACE
          || state.revision < current.revision) {
          throw new LargeSessionStaleError("大文件编辑回执缺少有效的会话版本，已保留输入。");
        }
        setLargeBackendState(current.tab, state);
        outbox.splice(index, 1);
        syncLargeOutboxProjection(current.tab);
        return state;
      },
    );
  } catch (error) {
    failed.failed = error;
    syncLargeOutboxProjection(captured.tab);
    throw error;
  }
}

export async function searchLargeFile(
  query: string,
  options: LargeFindOptions,
  startLine = 0,
  limit = 5000,
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
  signal?: AbortSignal,
) {
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  return largeQueueFor(captured.tab).enqueue(
    "search",
    captured,
    () => currentLargeSessionIdentity(captured),
    async (_captured, current) => {
      throwIfLargeSearchAborted(signal);
      if (largeOutboxFor(current.tab).some((item) => item.failed)) throw new LargeOutboxBlockedError();
      const result = await runLargeSourceJob<LargeFindResult>(current, "search", {
        query,
        options,
        startLine,
        limit,
      }, signal);
      if (result.revision !== current.revision || result.coordinateSpace !== LARGE_COORDINATE_SPACE) {
        throw new LargeSessionStaleError("大文件查找返回了错误的版本或坐标空间。");
      }
      return result;
    },
  );
}

export async function replaceLargeFileMatches(
  query: string,
  replacement: string,
  options: LargeFindOptions,
  currentMatch: LargeFindMatch | null,
  paneId: EditorPaneId = appStore.splitLayout.activePaneId,
) {
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured) throw new Error("未打开大文件。");
  if (largeHistoryOutbox.has(captured.tab)) throw new Error("前一次历史操作尚未确认，请先重试相同撤销或重做。");
  return largeQueueFor(captured.tab).enqueue(
    "replace",
    captured,
    () => currentLargeSessionIdentity(captured),
    async (_captured, current) => {
      if (largeOutboxFor(current.tab).some((item) => item.failed)) throw new LargeOutboxBlockedError();
      const state = await runLargeSourceJob<DirtyState>(current, "replace", { query, replacement, options, currentMatch });
      setLargeBackendState(current.tab, state);
      syncLargeOutboxProjection(current.tab);
      return state;
    },
  );
}

async function closeTabInternal(
  tabId: string,
  options: { ensureDefault: boolean; nextActiveId?: string },
) {
  const initialTab = appStore.tabs.find((item) => item.id === tabId);
  if (!initialTab) return false;
  const target = toRaw(initialTab) as DocumentTab;
  if (target.id === appStore.activeTabId) {
    syncActiveTabFromProjection();
  }
  if (!isTabRegistered(target)) return false;
  // Finish local editor presentation before the dialog moves focus. Otherwise
  // a normal textarea blur can invalidate the authorization being confirmed.
  const promptSession = documentSessionForTab(target.id);
  let closePreparationError = '';
  if (promptSession) await waitForDocumentComposition(target.id, promptSession);
  if (promptSession?.finalizeClosePrompt) {
    const promptIdentity = { id: target.id, path: target.path, session: promptSession };
    try {
      await waitForDocumentComposition(target.id, promptSession);
      const before = promptSession.mutationToken?.();
      const receipt = await promptSession.finalizeClosePrompt({ expectedToken: before });
      const after = promptSession.mutationToken?.();
      if (!isTabRegistered(target) || target.id !== promptIdentity.id || target.path !== promptIdentity.path
        || documentSessionForTab(target.id) !== promptSession
        || receipt && (receipt.sessionIdentity !== promptSession
          || before && !documentMutationTokensEqual(before, receipt.before)
          || after && !documentMutationTokensEqual(after, receipt.after))) {
        appStore.statusMessage = "关闭提示准备期间文档身份发生了变化，未关闭。";
        return false;
      }
    } catch (error) {
      if (!isTabRegistered(target) || target.id !== promptIdentity.id || target.path !== promptIdentity.path
        || documentSessionForTab(target.id) !== promptSession) return false;
      closePreparationError = error instanceof Error ? error.message : String(error);
      appStore.statusMessage = closePreparationError;
    }
  }
  const authorization = captureCloseAuthorization(target);
  const draftAtPrompt = captureDraftCleanupContext(target);
  let finalAuthorization: CloseAuthorization | null = null;
  let closeDisposition: "saved" | "discard" = "discard";
  if (tabHasUnsavedWork(target) || closePreparationError) {
    const action = await requestSaveDiscardCancel({
      title: "关闭未保存的标签页？",
      message: `“${target.name}”有未保存的修改。`,
      saveLabel: "保存并关闭",
      discardLabel: "不保存",
      details: closePreparationError ? [closePreparationError, '选择“不保存”将丢弃此标签页的未确认输入。'] : undefined,
    });
    if (action === "cancel") return false;
    if (action === "save") {
      try {
        const saved = await saveTabForClose(target);
        if (!saved) return false;
        closeDisposition = "saved";
        const savedAuthorization = captureCloseAuthorization(target);
        if (savedAuthorization.dirty || savedAuthorization.pending) {
          appStore.statusMessage = "保存后文档仍有未保存修改，未关闭。";
          return false;
        }
        const saveReceipt = captureDraftCleanupReceipt(target);
        const currentDraft = captureDraftCleanupContext(target);
        if (currentDraft && !await clearCapturedDraft(currentDraft, { receipt: saveReceipt })) return false;
        if (draftAtPrompt && draftAtPrompt.id !== currentDraft?.id) {
          if (!await clearCapturedDraft(draftAtPrompt, { receipt: saveReceipt })) return false;
        }
        finalAuthorization = savedAuthorization;
      } catch (error) {
        appStore.statusMessage = formatLargeTransactionEvidence(error);
        await showSaveFailure(error);
        return false;
      }
    } else {
      if (!isCloseAuthorizationCurrent(authorization)) {
        appStore.statusMessage = "确认期间文档发生了变化，未关闭。";
        return false;
      }
      if (draftAtPrompt && !await clearCapturedDraft(draftAtPrompt)) return false;
      finalAuthorization = authorization;
    }
  } else if (draftAtPrompt) {
    if (!await clearCapturedDraft(draftAtPrompt)) return false;
    finalAuthorization = authorization;
  } else {
    finalAuthorization = authorization;
  }

  if (!finalAuthorization || !isCloseAuthorizationCurrent(finalAuthorization)) {
    appStore.statusMessage = "关闭期间文档发生了变化，未关闭。";
    return false;
  }
  const closingIndexLease = target.path && target.documentMode === 'normal' && appStore.workspaceIndexReady
    ? { path: target.path, epoch: documentRuntimeIdentity(target.id).epoch, revision: documentSessionForTab(target.id)?.revision ?? documentRuntimeMetadata.get(target.id)?.revision ?? 0, workspace: currentWorkspaceView() }
    : null;
  if (!isCloseAuthorizationCurrent(finalAuthorization)) {
    appStore.statusMessage = "关闭期间文档发生了变化，未关闭。";
    return false;
  }
  let largeSessionClosed = false;
  if (target.documentMode === "large") {
    if (!await closeLargeFileSessionForTab(target, closeDisposition)) return false;
    // closeLargeFileSessionForTab has already performed the final pane/session
    // fence and clears the native session projection on success.  The close
    // authorization's largeFile identity therefore cannot be rechecked after
    // that deliberate cleanup; the tab object is removed synchronously below.
    largeSessionClosed = true;
  } else if (!isCloseAuthorizationCurrent(finalAuthorization)) {
    appStore.statusMessage = "关闭期间文档发生了变化，未关闭。";
    return false;
  }
  const closingTabId = target.id;
  const index = appStore.tabs.findIndex((item) => toRaw(item) === target);
  if (index < 0 || (!largeSessionClosed && !isCloseAuthorizationCurrent(finalAuthorization))) return false;
  rememberClosedTab(target);
  appStore.tabs.splice(index, 1);
  documentSnapshotCoordinator.cancel(closingTabId);
  documentRuntimeMetadata.delete(closingTabId);
  delete appStore.runtimeDerivedByTab[closingTabId];
  clearDocumentRuntimeState(closingTabId);
  if (closingIndexLease) {
    void workspaceIndexClient.releaseOpenDocument(closingIndexLease.path, closingIndexLease.epoch, closingIndexLease.revision).catch(error => {
      if (ownsWorkspace(closingIndexLease.workspace)) appStore.wikiIndexError = `释放工作区文档索引失败：${error}`;
    });
  }
  appStore.splitLayout = resolveClosedTabSplitLayout(appStore.splitLayout, closingTabId, tabIds());

  if (appStore.tabs.length === 0) {
    resetOpenDocument();
    if (options.ensureDefault) ensureDefaultTab();
    return true;
  }

  const activeStill = appStore.tabs.find((item) => item.id === appStore.activeTabId);
  const preferred = options.nextActiveId ? appStore.tabs.find((item) => item.id === options.nextActiveId) : null;
  const paneNext = appStore.tabs.find((item) => item.id === paneTabId(appStore.splitLayout, appStore.splitLayout.activePaneId));
  const next = preferred ?? activeStill ?? paneNext ?? appStore.tabs[Math.max(0, Math.min(index, appStore.tabs.length - 1))];
  projectTabInPane(next, appStore.splitLayout.activePaneId);
  return true;
}

function rememberClosedTab(tab: DocumentTab) {
  if (!tab.path || (tab.kind !== "normal" && tab.kind !== "large")) return;
  const record: ClosedTabRecord = {
    path: tab.path,
    kind: tab.kind === "large" ? "large" : "normal",
    editorMode: tab.editorMode,
    closedAt: Date.now(),
  };
  appStore.closedTabs = [record, ...appStore.closedTabs.filter((item) => !isSamePath(item.path, tab.path))].slice(0, 20);
}

export async function setTheme(theme: ThemeMode) {
  appStore.theme = theme;
  appStore.settings.appearance.theme = theme;
  applyTheme();
  await persistConfig();
}

export function applyTheme() {
  const activeTheme = normalizeTheme(appStore.theme);
  appStore.activeTheme = activeTheme;
  document.documentElement.classList.toggle("dark", activeTheme === "dark");
  applyAppearance();
}

function normalizeTheme(theme: ThemeMode | undefined) {
  if (theme === "light" || theme === "dark") return theme;
  return currentSystemTheme();
}

export async function updateSettings(settings: AppSettings) {
  const previousMathNumbering = appStore.settings.markdown.mathNumbering;
  const previousFocusMode = appStore.settings.editor.focusMode;
  const previousTypewriterMode = appStore.settings.editor.typewriterMode;
  appStore.settings = normalizeSettings({ recentFiles: appStore.recentFiles, settings });
  appStore.theme = appStore.settings.appearance.theme;
  applyTheme();
  await persistConfig();
  if (previousMathNumbering !== appStore.settings.markdown.mathNumbering) {
    window.dispatchEvent(new CustomEvent("lightmark:math-settings-changed"));
  }
  if (
    previousFocusMode !== appStore.settings.editor.focusMode ||
    previousTypewriterMode !== appStore.settings.editor.typewriterMode
  ) {
    dispatchWritingModesChanged();
  }
}

export async function resetSettings() {
  await updateSettings(defaultSettings());
  appStore.statusMessage = "设置已重置";
}

export function startExportStatus(targetId: ExportTargetId, targetLabel: string) {
  appStore.exportStatus = {
    status: "running",
    targetId,
    targetLabel,
    message: `正在导出 ${targetLabel}`,
    startedAt: Date.now(),
  };
}

export function completeExportStatus(path: string) {
  appStore.exportStatus = {
    ...appStore.exportStatus,
    status: "success",
    path,
    message: "导出完成",
    completedAt: Date.now(),
  };
}

export function failExportStatus(error: unknown) {
  appStore.exportStatus = {
    ...appStore.exportStatus,
    status: "error",
    message: "导出失败",
    error: error instanceof Error ? error.message : String(error),
    completedAt: Date.now(),
  };
}

export function clearExportStatus() {
  appStore.exportStatus = {
    status: "idle",
    message: "",
  };
}

export function defaultSettings(): AppSettings {
  return {
    general: {
      launchBehavior: "blank",
      restoreLastFile: false,
      recentFilesLimit: 10,
      autoSave: false,
      autoSaveIntervalMinutes: 5,
      language: "system",
      spellcheck: false,
      spellcheckLanguage: "en-US",
    },
    editor: {
      defaultMode: "wysiwyg",
      autoPairBrackets: true,
      autoPairMarkdownSyntax: true,
      pasteMarkdownAsPlainText: false,
      focusMode: false,
      typewriterMode: false,
      showWordCount: true,
    },
    markdown: {
      strictMode: false,
      inlineHtml: true,
      blockHtml: true,
      math: true,
      mathNumbering: "none",
      mermaid: true,
      footnotes: true,
      toc: true,
      taskList: true,
      githubAlerts: true,
      yamlFrontMatter: true,
      smartPunctuation: true,
      subscript: true,
      superscript: true,
      highlight: true,
    },
    image: {
      insertBehavior: "reference" as ImageInsertBehavior,
      useRelativePath: true,
      ensureDotSlash: false,
      escapePath: true,
      assetFolder: "assets",
      rootUrl: "",
      pasteCompressionEnabled: true,
      pasteCompressionThresholdBytes: 2 * 1024 * 1024,
      pasteCompressionMaxDimension: 2560,
      pasteCompressionQuality: 85,
      pastedImageNaming: "preserve",
    },
    appearance: {
      theme: "system",
      editorWidth: 720,
      fontFamily: `"Microsoft YaHei", "PingFang SC", system-ui, sans-serif`,
      fontSize: 17,
      lineHeight: 1.75,
      paragraphSpacing: 0.8,
      codeFontFamily: `"JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace`,
      showSidebar: true,
      sidebarPreference: "auto",
      showOutline: true,
    },
    export: {
      defaultFolder: "auto",
      customFolder: "",
      htmlTheme: "current",
      htmlIncludeStyles: true,
      includeYamlFrontMatter: false,
      allowYamlOverride: false,
      openFileAfterExport: false,
      openFolderAfterExport: false,
      pandocPath: "",
      preferBundledPandoc: true,
      pdfEngine: "xelatex",
      pdfPaperSize: "a4",
      pdfMargin: "20mm",
      docxReferenceDoc: "",
      epubCoverImage: "",
      epubCss: "",
      customPandocFormat: "",
      customPandocExtension: ".html",
      customPandocArgs: "",
    },
    shortcuts: {
      customKeybindings: false,
    },
    advanced: {
      debugMode: false,
      experimentalFeatures: false,
    },
    snippets: { items: [] },
  };
}

function currentSystemTheme(): Exclude<ThemeMode, "system"> {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function normalizeSettings(config: AppConfig) {
  const defaults = defaultSettings();
  const source = config.settings ?? ({} as Partial<AppSettings>);
  const migratedTheme = config.settings?.appearance?.theme ?? config.theme;
  return {
    ...defaults,
    ...source,
    general: {
      ...defaults.general,
      ...source.general,
      recentFilesLimit: clampNumber(source.general?.recentFilesLimit, 1, 50, defaults.general.recentFilesLimit),
      autoSaveIntervalMinutes: clampNumber(
        source.general?.autoSaveIntervalMinutes,
        1,
        60,
        defaults.general.autoSaveIntervalMinutes,
      ),
    },
    editor: { ...defaults.editor, ...source.editor },
    markdown: {
      ...defaults.markdown,
      ...source.markdown,
      mathNumbering:
        source.markdown?.mathNumbering === "ams-block" || source.markdown?.mathNumbering === "all-display"
          ? source.markdown.mathNumbering
          : "none",
    },
    image: {
      ...defaults.image,
      ...source.image,
      pasteCompressionThresholdBytes: clampNumber(
        source.image?.pasteCompressionThresholdBytes,
        256 * 1024,
        100 * 1024 * 1024,
        defaults.image.pasteCompressionThresholdBytes,
      ),
      pasteCompressionMaxDimension: clampNumber(
        source.image?.pasteCompressionMaxDimension,
        320,
        8192,
        defaults.image.pasteCompressionMaxDimension,
      ),
      pasteCompressionQuality: clampNumber(
        source.image?.pasteCompressionQuality,
        40,
        100,
        defaults.image.pasteCompressionQuality,
      ),
      pastedImageNaming: source.image?.pastedImageNaming === "timestamp" ? "timestamp" : "preserve",
    },
    appearance: {
      ...defaults.appearance,
      ...source.appearance,
      theme: normalizeThemeValue(migratedTheme) ?? defaults.appearance.theme,
      sidebarPreference: source.appearance?.sidebarPreference === "auto" || source.appearance?.sidebarPreference === "shown" || source.appearance?.sidebarPreference === "hidden"
        ? source.appearance.sidebarPreference
        : typeof source.appearance?.showSidebar === "boolean" ? (source.appearance.showSidebar ? "shown" : "hidden") : "auto",
      editorWidth: clampNumber(source.appearance?.editorWidth, 560, 1200, defaults.appearance.editorWidth),
      fontSize: clampNumber(source.appearance?.fontSize, 12, 24, defaults.appearance.fontSize),
      lineHeight: clampNumber(source.appearance?.lineHeight, 1.2, 2.4, defaults.appearance.lineHeight),
      paragraphSpacing: clampNumber(source.appearance?.paragraphSpacing, 0, 2, defaults.appearance.paragraphSpacing),
    },
    export: {
      ...defaults.export,
      ...source.export,
      defaultFolder:
        source.export?.defaultFolder === "sameFolder" || source.export?.defaultFolder === "custom"
          ? source.export.defaultFolder
          : defaults.export.defaultFolder,
      htmlTheme:
        source.export?.htmlTheme === "light" || source.export?.htmlTheme === "dark"
          ? source.export.htmlTheme
          : defaults.export.htmlTheme,
      customPandocExtension: normalizeExportExtension(source.export?.customPandocExtension, defaults.export.customPandocExtension),
    },
    shortcuts: { ...defaults.shortcuts, ...source.shortcuts },
    advanced: { ...defaults.advanced, ...source.advanced },
    snippets: { items: normalizeSnippets(source.snippets?.items) },
  } satisfies AppSettings;
}

function normalizeThemeValue(theme: ThemeMode | undefined) {
  return theme === "light" || theme === "dark" || theme === "system" ? theme : undefined;
}

function normalizeExportExtension(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function applyAppearance() {
  const root = document.documentElement;
  const appearance = appStore.settings.appearance;
  root.style.setProperty("--lm-editor-width", `${appearance.editorWidth}px`);
  root.style.setProperty("--lm-editor-font-family", appearance.fontFamily);
  root.style.setProperty("--lm-editor-font-size", `${appearance.fontSize}px`);
  root.style.setProperty("--lm-editor-line-height", String(appearance.lineHeight));
  root.style.setProperty("--lm-editor-paragraph-spacing", `${appearance.paragraphSpacing}em`);
  root.style.setProperty("--lm-editor-code-font-family", appearance.codeFontFamily);
}

function shouldRestoreSession(config: AppConfig) {
  return Boolean(
    config.session?.openTabs?.length &&
      (config.settings?.general?.restoreLastFile || config.settings?.general?.launchBehavior === "restoreLastSession"),
  );
}

async function restoreSession(session: SessionRestoreState | undefined) {
  if (!session?.openTabs?.length) return;
  const restored: DocumentTab[] = [];
  for (const item of session.openTabs) {
    if (!item.path || restored.some((tab) => isSamePath(tab.path, item.path))) continue;
    try {
      const info = await invoke<FileInfo>("get_file_info", { path: item.path });
      if (info.isLarge) {
        const largeSession = await invoke<LargeFileSession>("open_large_file", { path: item.path });
        restored.push(
          createTab({
            path: item.path,
            kind: "large",
            content: "",
            documentMode: "large",
            editorMode: "source",
            largeFile: {
              sessionId: largeSession.sessionId,
              sizeBytes: largeSession.sizeBytes,
              totalLines: largeSession.totalLines,
              loadedRanges: [],
              pendingEdits: [],
              outline: largeSession.outline,
              revision: largeSession.revision,
              savedRevision: largeSession.savedRevision,
              pendingEditCount: largeSession.pendingEditCount,
              baseFingerprint: largeSession.baseFingerprint,
              diskFingerprint: largeSession.diskFingerprint,
              coordinateSpace: largeSession.coordinateSpace,
              targetPath: largeSession.targetPath !== undefined ? largeSession.targetPath : largeSession.path,
              originPath: largeSession.originPath ?? largeSession.path,
              recoveryDraftId: largeSession.recoveryDraftId,
            },
            isDirty: false,
            lastActiveAt: item.lastActiveAt,
            position: normalizeSessionPosition(item.position, "wysiwyg"),
            collapsedOutlineKeys: item.collapsedOutlineKeys,
            collapsedHeadingKeys: item.collapsedHeadingKeys,
          }),
        );
      } else {
        const snapshot = await readTextFileSnapshot(item.path);
        const content = snapshot.content;
        const fileSnapshot = fileSnapshotFromTextSnapshot(snapshot);
        restored.push(
          createTab({
            path: item.path,
            kind: "normal",
            content,
            documentMode: "normal",
            editorMode: normalizeEditorMode(item.editorMode) ?? appStore.settings.editor.defaultMode,
            largeFile: null,
            isDirty: false,
            lastActiveAt: item.lastActiveAt,
            fileSnapshot,
            position: normalizeSessionPosition(item.position, normalizeEditorMode(item.editorMode) ?? appStore.settings.editor.defaultMode),
            collapsedOutlineKeys: item.collapsedOutlineKeys,
            collapsedHeadingKeys: item.collapsedHeadingKeys,
          }),
        );
      }
    } catch {
      // Missing files should not block app startup.
    }
  }
  if (restored.length === 0) return;
  for (const tab of restored) {
    if (tab.documentMode === "large") initializeLargeSession(tab);
  }
  appStore.tabs = restored;
  appStore.splitLayout = restoreSplitLayout(session.splitLayout, restored);
  const active =
    restored.find((tab) => session.activeTabKey && isSamePath(tab.path, session.activeTabKey)) ??
    restored.find((tab) => tab.id === paneTabId(appStore.splitLayout, appStore.splitLayout.activePaneId)) ??
    restored.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  projectTab(active);
  if (active.path) {
    await checkDraftForOpenedFile(active.path);
  }
}

function buildSessionRestoreState(): SessionRestoreState | undefined {
  const openTabs: SessionTabState[] = appStore.tabs
    .filter((tab) => tab.path && (tab.kind === "normal" || tab.kind === "large"))
    .map((tab) => ({
      path: tab.path,
      kind: tab.kind === "large" ? "large" : "normal",
      editorMode: tab.editorMode,
      lastActiveAt: tab.lastActiveAt,
      position: tab.kind === "normal" ? tab.position : undefined,
      collapsedOutlineKeys: tab.collapsedOutlineKeys,
      collapsedHeadingKeys: tab.kind === "normal" ? tab.collapsedHeadingKeys : [],
    }));
  if (openTabs.length === 0) return undefined;
  return {
    openTabs,
    activeTabKey: getActiveTab()?.path || undefined,
    workspacePath: appStore.currentWorkspace || undefined,
    splitLayout: buildSessionSplitLayout(),
  };
}

function buildSessionSplitLayout(): SessionSplitLayoutState {
  const pathForId = (id: string) => appStore.tabs.find((tab) => tab.id === id)?.path || "";
  return {
    enabled: appStore.splitLayout.enabled,
    activePaneId: appStore.splitLayout.activePaneId,
    mainTabKeys: appStore.splitLayout.mainTabIds.map(pathForId).filter(Boolean),
    secondaryTabKeys: appStore.splitLayout.secondaryTabIds.map(pathForId).filter(Boolean),
    mainActiveTabKey: pathForId(appStore.splitLayout.mainTabId) || undefined,
    secondaryActiveTabKey: pathForId(appStore.splitLayout.secondaryTabId) || undefined,
    ratio: appStore.splitLayout.ratio,
  };
}

function restoreSplitLayout(layout: SessionSplitLayoutState | undefined, tabs: DocumentTab[]) {
  const idForPath = (path: string | undefined) => tabs.find((tab) => path && isSamePath(tab.path, path))?.id || "";
  const idsForPaths = (paths: string[] | undefined) => (paths || []).map(idForPath).filter(Boolean);
  return normalizeSplitLayout(
    {
      enabled: layout?.enabled,
      activePaneId: layout?.activePaneId,
      mainTabId: idForPath(layout?.mainActiveTabKey),
      secondaryTabId: idForPath(layout?.secondaryActiveTabKey),
      mainTabIds: idsForPaths(layout?.mainTabKeys),
      secondaryTabIds: idsForPaths(layout?.secondaryTabKeys),
      ratio: layout?.ratio,
    },
    tabs.map((tab) => tab.id),
    idForPath(layout?.mainActiveTabKey) || tabs[0]?.id || "",
  );
}

function createTab(input: {
  path: string;
  kind: DocumentTab["kind"];
  content: string;
  documentMode: DocumentMode;
  editorMode: EditorMode;
  largeFile: LargeFileState | null;
  isDirty: boolean;
  lastActiveAt?: number;
  fileSnapshot?: FileSnapshot;
  position?: EditorPositionSnapshot;
  collapsedOutlineKeys?: string[];
  collapsedHeadingKeys?: string[];
}) {
  const now = Date.now();
  const id = input.path ? tabIdForPath(input.path) : `untitled:${now}:${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    kind: input.kind,
    path: input.path,
    name: input.path ? fileNameFromPath(input.path) : "未命名",
    content: input.content,
    documentMode: input.documentMode,
    largeFile: input.largeFile,
    isDirty: input.isDirty,
    editorMode: input.editorMode,
    pendingModeCursor: null,
    collapsedOutlineKeys: Array.from(new Set(input.collapsedOutlineKeys ?? [])),
    collapsedHeadingKeys: Array.from(new Set(input.collapsedHeadingKeys ?? [])),
    wysiwygFormatHistory: { undo: [], redo: [] },
    position: input.position,
    fileSnapshot: input.fileSnapshot,
    externalState: "clean",
    openedAt: now,
    lastActiveAt: input.lastActiveAt ?? now,
  } satisfies DocumentTab;
}

function ensureEditableTab() {
  if (getActiveTab() || appStore.tabs.length > 0) return;
  const tab = createTab({
    path: "",
    kind: "untitled",
    content: appStore.currentContent,
    documentMode: "normal",
    editorMode: appStore.settings.editor.defaultMode,
    largeFile: null,
    isDirty: appStore.isDirty,
  });
  appStore.tabs.push(tab);
  projectTabInPane(tab, appStore.splitLayout.activePaneId);
}

function ensureSecondarySplitTab() {
  if (!appStore.splitLayout.enabled) return;
  if (appStore.splitLayout.secondaryTabId && appStore.splitLayout.secondaryTabId !== appStore.splitLayout.mainTabId) return;
  const tab = createTab({
    path: "",
    kind: "untitled",
    content: "",
    documentMode: "normal",
    editorMode: appStore.settings.editor.defaultMode,
    largeFile: null,
    isDirty: false,
  });
  appStore.tabs.push(tab);
  projectTabInPane(tab, "secondary");
}

function projectTabInPane(tab: DocumentTab, paneId: EditorPaneId) {
  appStore.splitLayout = splitLayoutForPaneActivation(appStore.splitLayout, paneId, tab.id, tabIds());
  appStore.paneContextLines[paneId] = Math.max(0, (tab.position?.markdownLine ?? 1) - 1);
  appStore.paneOutlineAnchorLines[paneId] = Math.max(0, (tab.position?.markdownLine ?? 1) - 1);
  appStore.paneOutlineAnchorSources[paneId] = "navigation";
  appStore.largeFileViewportLines[paneId] = 0;
  projectTab(tab);
}

function projectTab(tab: DocumentTab) {
  appStore.activeTabId = tab.id;
  tab.lastActiveAt = Date.now();
  appStore.currentFilePath = tab.path;
  appStore.currentContent = tab.content;
  appStore.documentMode = tab.documentMode;
  appStore.largeFile = tab.largeFile;
  appStore.isDirty = tab.isDirty;
  appStore.saveState = tab.isDirty ? "dirty" : "saved";
  appStore.editorMode = tab.documentMode === "large" ? "source" : tab.editorMode;
  appStore.pendingModeCursor = tab.pendingModeCursor;
  requestEditorPositionRestore(tab.position);
  appStore.statusMessage =
    tab.documentMode === "large" && tab.largeFile
      ? `大文件模式：${formatBytes(tab.largeFile.sizeBytes)}，${tab.largeFile.totalLines} 行`
      : "";
}

function syncActiveTabFromProjection() {
  const tab = getActiveTab();
  if (!tab) return;
  tab.path = appStore.currentFilePath;
  tab.name = appStore.currentFilePath ? fileNameFromPath(appStore.currentFilePath) : "未命名";
  tab.content = appStore.currentContent;
  tab.documentMode = appStore.documentMode;
  tab.largeFile = appStore.largeFile;
  tab.isDirty = appStore.isDirty;
  tab.editorMode = appStore.editorMode;
  tab.pendingModeCursor = appStore.pendingModeCursor;
  if (appStore.pendingEditorPosition?.editorMode === tab.editorMode) {
    tab.position = appStore.pendingEditorPosition;
  }
  tab.lastActiveAt = Date.now();
}

function retargetActiveTab(path: string) {
  const tab = getActiveTab();
  if (!tab) return;
  const previousTabId = tab.id;
  advanceMutationEpoch(tab);
  tab.id = tabIdForPath(path);
  rebindDocumentRuntime(previousTabId, tab.id);
  tab.kind = "normal";
  tab.path = path;
  tab.name = fileNameFromPath(path);
  tab.fileSnapshot = undefined;
  clearTabExternalState(tab);
  appStore.activeTabId = tab.id;
  appStore.splitLayout = splitLayoutForPaneActivation(appStore.splitLayout, appStore.splitLayout.activePaneId, tab.id, tabIds());
}

function retargetLargeTabForSaveAs(tab: DocumentTab, path: string) {
  tab = reactive(tab);
  const previousTabId = tab.id;
  if (tab.path === path && tab.largeFile) {
    tab.largeFile.targetPath = path;
    return;
  }
  advanceMutationEpoch(tab);
  tab.id = tabIdForPath(path);
  rebindDocumentRuntime(previousTabId, tab.id);
  tab.path = path;
  tab.name = fileNameFromPath(path);
  tab.kind = "large";
  if (tab.largeFile) tab.largeFile.targetPath = path;
  clearTabExternalState(tab);
  appStore.splitLayout = replaceTabIdInSplitLayout(appStore.splitLayout, previousTabId, tab.id, tabIds());
  if (appStore.activeTabId === previousTabId) {
    appStore.activeTabId = tab.id;
    appStore.currentFilePath = path;
  }
}

function getActiveTab() {
  return appStore.tabs.find((tab) => tab.id === appStore.activeTabId) ?? null;
}

function findFileTab(path: string) {
  return appStore.tabs.find((tab) => tab.path && isSamePath(tab.path, path)) ?? null;
}

function rebindDocumentRuntime(previousTabId: string, nextTabId: string) {
  rebindDocumentSession(previousTabId, nextTabId);
  const metadata = documentRuntimeMetadata.get(previousTabId);
  if (metadata) {
    documentRuntimeMetadata.delete(previousTabId);
    documentRuntimeMetadata.set(nextTabId, metadata);
  }
  documentSnapshotCoordinator.cancel(previousTabId);
  if (metadata) scheduleDocumentSnapshot(nextTabId);
}

function tabIds() {
  return appStore.tabs.map((tab) => tab.id);
}

function tabIdForPath(path: string) {
  return `file:${hashString(normalizePathKey(path))}`;
}

function flattenFileNodes(nodes: FileNode[]) {
  const files: FileNode[] = [];
  const walk = (items: FileNode[]) => {
    for (const item of items) {
      if (item.isDir) {
        walk(item.children);
      } else {
        files.push(item);
      }
    }
  };
  walk(nodes);
  return files;
}

function candidateFromPath(path: string, source: QuickOpenCandidate["source"]): QuickOpenCandidate {
  return {
    name: fileNameFromPath(path),
    path,
    source,
    score: 0,
  };
}

function candidateFromWikiEntry(entry: WikiDocumentEntry): QuickOpenCandidate {
  return {
    name: fileNameFromPath(entry.path),
    path: entry.path,
    source: "workspace",
    score: 0,
  };
}

function filterQuickOpenCandidates(candidates: QuickOpenCandidate[], query: string) {
  const normalizedQuery = normalizeQuickOpenText(query);
  const unique = uniqueCandidates(candidates);
  if (!normalizedQuery) return unique;
  return unique
    .map((candidate) => scoreQuickOpenCandidate(candidate, normalizedQuery))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => (
      left.score - right.score
      || pathDepth(left.path) - pathDepth(right.path)
      || left.path.localeCompare(right.path, "zh-Hans-CN")
    ));
}

function uniqueCandidates(candidates: QuickOpenCandidate[]) {
  const seen = new Set<string>();
  const result: QuickOpenCandidate[] = [];
  for (const candidate of candidates) {
    const key = normalizePathKey(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function scoreQuickOpenCandidate(candidate: QuickOpenCandidate, query: string) {
  const name = normalizeQuickOpenText(candidate.name.replace(/\.(md|markdown)$/i, ""));
  const path = normalizeQuickOpenText(candidate.path);
  const entry = appStore.wikiIndex.entries.find((item) => isSamePath(item.path, candidate.path));
  if (entry) {
    const match = scoreKnowledgeQuickOpenEntry(entry, query);
    return match ? { ...candidate, ...match } : { ...candidate, score: Number.POSITIVE_INFINITY };
  }
  if (name === query) return { ...candidate, score: 0, matchKind: "name" as const };
  const nameScore = subsequenceScore(name, query);
  if (Number.isFinite(nameScore)) return { ...candidate, score: 200 + nameScore, matchKind: "name" as const };
  const pathScore = subsequenceScore(path, query);
  return {
    ...candidate,
    score: Number.isFinite(pathScore) ? 500 + pathScore : Number.POSITIVE_INFINITY,
    matchKind: "path" as const,
  };
}

function subsequenceScore(value: string, query: string) {
  let valueIndex = 0;
  let score = 0;
  let previousMatch = -1;
  for (const char of query) {
    const match = value.indexOf(char, valueIndex);
    if (match < 0) return Number.POSITIVE_INFINITY;
    score += match;
    if (previousMatch >= 0) score += Math.max(0, match - previousMatch - 1);
    previousMatch = match;
    valueIndex = match + 1;
  }
  return score + value.length / 1000;
}

function normalizeQuickOpenText(value: string) {
  return value.replace(/\\/g, "/").toLocaleLowerCase();
}

function pathDepth(path: string) {
  return path.replace(/\\/g, "/").split("/").length;
}

function isMarkdownFilePath(path: string) {
  return /\.(md|markdown)$/i.test(path);
}

function conflictCopyPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const match = name.match(/^(.*?)(\.[^.]+)?$/);
  const stem = match?.[1] || "untitled";
  const extension = match?.[2] || ".md";
  return `${folder}${stem}.conflict-${timestampForFileName()}${extension}`;
}

function timestampForFileName() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function findSimilarFileCandidates(tab: DocumentTab) {
  if (!tab.path || !tab.fileSnapshot?.size) return [];
  return await invoke<SimilarFileCandidate[]>("find_similar_markdown_files", {
    originalPath: tab.path,
    size: tab.fileSnapshot.size,
    mtime: tab.fileSnapshot.mtime,
  }).catch(() => []);
}

function scheduleWikiHeadingJump(target: WikiLinkTarget) {
  if (!target.heading) return;
  const expected = normalizeHeadingText(target.heading);
  const item = extractOutlineWithLines(appStore.currentContent).find((candidate) => {
    return normalizeHeadingText(candidate.text) === expected;
  });
  if (!item) {
    appStore.statusMessage = `未找到标题：${target.heading}`;
    return;
  }
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("lightmark:jump-heading", {
        detail: {
          id: item.id,
          line: item.line,
          text: item.text,
        },
      }),
    );
  }, 0);
}

function recordCurrentNavigationBeforeOpening(nextPath: string) {
  const current = currentNavigationLocation();
  if (!current || isSamePath(current.path, nextPath)) return;
  pushNavigationLocation(appStore.navigationBackStack, current);
  appStore.navigationForwardStack = [];
}

function currentNavigationLocation(overrides: Partial<NavigationLocation> = {}): NavigationLocation | null {
  if (!appStore.currentFilePath) return null;
  const tab = getActiveTab();
  return {
    path: appStore.currentFilePath,
    documentMode: appStore.documentMode,
    editorMode: appStore.editorMode,
    paneId: appStore.splitLayout.activePaneId,
    position: tab?.position,
    recordedAt: Date.now(),
    ...overrides,
  };
}

function requestEditorPositionRestore(position: EditorPositionSnapshot | undefined) {
  if (!position || typeof window === "undefined") return;
  appStore.pendingEditorPosition = position;
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("lightmark:restore-position", { detail: position }));
  }, 0);
}

function normalizeSessionPosition(position: EditorPositionSnapshot | undefined, editorMode: EditorMode) {
  if (!position || position.editorMode !== editorMode) return undefined;
  return mergeEditorPosition(position, position, Number.MAX_SAFE_INTEGER);
}

function pushNavigationLocation(stack: NavigationLocation[], location: NavigationLocation) {
  const previous = stack[stack.length - 1];
  if (previous && isSamePath(previous.path, location.path)) {
    stack[stack.length - 1] = location;
  } else {
    stack.push(location);
  }
  if (stack.length > 100) {
    stack.splice(0, stack.length - 100);
  }
}

function isSamePath(left: string, right: string) {
  return normalizePathKey(left) === normalizePathKey(right);
}

function normalizePathKey(path: string) {
  return path.replace(/\\/g, "/").toLocaleLowerCase();
}

function normalizeHeadingText(value: string) {
  return value.replace(/[#*_`[\]()]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function defaultMarkdownFileName(tabName?: string) {
  const name = (tabName ?? currentFileName.value).trim() || "未命名";
  return name.endsWith(".md") || name.endsWith(".markdown") ? name : `${name}.md`;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeEditorMode(mode: EditorMode | string | undefined) {
  return mode === "wysiwyg" || mode === "source" ? mode : undefined;
}

function rememberRecentFile(path: string) {
  appStore.recentFiles = [path, ...appStore.recentFiles.filter((item) => item !== path)].slice(
    0,
    appStore.settings.general.recentFilesLimit,
  );
}

async function confirmDiscardOrSave(saveMessage = "当前文件有未保存的修改，切换前是否保存？", discardMessage = "不保存并继续切换？") {
  if (!appStore.isDirty) return true;
  const action = await requestSaveDiscardCancel({
    title: saveMessage,
    message: discardMessage,
    saveLabel: "保存",
    discardLabel: "不保存",
  });
  if (action === "save") {
    return await saveCurrentFile();
  }
  return action === "discard";
}

type SaveDiscardCancelAction = "save" | "discard" | "cancel";

async function requestSaveDiscardCancel(options: {
  title: string;
  message: string;
  details?: string[];
  saveLabel?: string;
  discardLabel?: string;
}) {
  const result = await showDialog({
    title: options.title,
    message: options.message,
    details: options.details,
    cancelId: "cancel",
    defaultId: "save",
    buttons: [
      { id: "cancel", label: "取消", variant: "secondary" },
      { id: "discard", label: options.discardLabel ?? "不保存", variant: "danger" },
      { id: "save", label: options.saveLabel ?? "保存", variant: "primary" },
    ],
  });
  return result as SaveDiscardCancelAction;
}

export async function showSaveFailure(error: unknown) {
  await alertDialog({
    title: "保存失败",
    message: formatLargeTransactionEvidence(error),
    tone: "danger",
  });
}

async function closeLargeFileSessionForTab(tab: DocumentTab, disposition: "saved" | "discard") {
  const rawTab = toRaw(tab) as DocumentTab;
  if (!rawTab.largeFile || rawTab.documentMode !== "large") return true;
  const paneId = largePaneForTab(rawTab);
  const captured = captureLargeSessionIdentity(paneId);
  if (!captured || captured.tab !== rawTab) return false;
  const currentView = largeViewIdentityStillCurrent(captured);
  if (!currentView?.tab.largeFile) {
    appStore.statusMessage = "大文件会话已变化，未关闭。";
    return false;
  }
  let receipt: LargeCloseReceipt;
  try {
    receipt = await largeQueueFor(rawTab).enqueue(
      "close",
      captured,
      () => largeViewIdentityStillCurrent(captured),
      async (_captured, current) => await invoke<LargeCloseReceipt>("close_large_file", {
        sessionId: current.sessionId,
        expectedRevision: current.revision,
        coordinateSpace: LARGE_COORDINATE_SPACE,
        disposition,
      }),
      (_captured, current) => Boolean(
        current
          && current.paneId === captured.paneId
          && current.editorIdentity === captured.editorIdentity
          && current.revision === captured.revision,
      ),
    );
  } catch (error) {
    appStore.statusMessage = `大文件关闭失败：${formatLargeTransactionEvidence(error)}`;
    return false;
  }
  if (receipt.sessionId !== captured.sessionId || !receipt.closed) {
    appStore.statusMessage = "大文件关闭回执无效，未关闭。";
    return false;
  }
  if (receipt.cleanupWarning || receipt.recoveryArtifact) {
    appStore.statusMessage = formatTransactionNotice(
      "大文件会话已关闭，但快照清理需处理",
      receipt.cleanupWarning,
      receipt.recoveryArtifact,
    );
  }
  if (!isTabRegistered(rawTab) || documentSessionForTab(rawTab.id) !== captured.editorIdentity) {
    appStore.statusMessage = "大文件关闭期间标签页或会话发生了变化。";
    return false;
  }
  largeOutboxes.delete(rawTab);
  largeRemotePendingCounts.delete(rawTab);
  largeQueues.delete(rawTab);
  rawTab.largeFile = null;
  if (rawTab.id === appStore.activeTabId) appStore.largeFile = null;
  return true;
}

function resetOpenDocument() {
  appStore.currentFilePath = "";
  appStore.currentContent = "";
  appStore.documentMode = "normal";
  appStore.largeFile = null;
  appStore.isDirty = false;
  appStore.saveState = "saved";
  appStore.editorMode = "wysiwyg";
  appStore.activeTabId = "";
  appStore.splitLayout = defaultSplitLayout();
  appStore.pendingModeCursor = null;
  appStore.statusMessage = "";
}

function mergeLoadedRanges(
  ranges: Array<{ startLine: number; endLine: number }>,
  next: { startLine: number; endLine: number },
) {
  return [...ranges, next]
    .sort((a, b) => a.startLine - b.startLine)
    .reduce<Array<{ startLine: number; endLine: number }>>((merged, range) => {
      const last = merged[merged.length - 1];
      if (!last || range.startLine > last.endLine) {
        merged.push({ ...range });
      } else {
        last.endLine = Math.max(last.endLine, range.endLine);
      }
      return merged;
    }, []);
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

if (
  typeof import.meta.env !== "undefined"
  && import.meta.env.VITE_LIGHTMARK_PERF_QA === "1"
  && typeof window !== "undefined"
) {
  const qa = (window as typeof window & { __LIGHTMARK_PERFORMANCE_QA__?: Record<string, unknown> })
    .__LIGHTMARK_PERFORMANCE_QA__;
  if (qa) {
    qa.prepare = async (mode: EditorMode) => {
      if (appStore.splitLayout.enabled) await toggleSplitLayout();
      await setActivePane("main");
      appStore.settings.editor.focusMode = false;
      appStore.settings.editor.typewriterMode = false;
      window.dispatchEvent(new CustomEvent("lightmark:writing-modes-changed"));
      await switchMode(mode, "main");
      const tab = getPaneTab("main");
      if (tab) {
        tab.path = "";
        tab.fileSnapshot = undefined;
      }
      appStore.currentFilePath = "";
      return tab?.id ?? "";
    };
  }
}
