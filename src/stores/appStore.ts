import { computed, reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { checkDraftForOpenedFile, clearActiveDraft, flushCurrentDraft } from "./draftStore";
import { alertDialog, showDialog } from "./dialogStore";
import type {
  AppConfig,
  AppSettings,
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
  NavigationLocation,
  PendingModeCursor,
  QuickOpenCandidate,
  SessionRestoreState,
  SessionSplitLayoutState,
  SessionTabState,
  SimilarFileCandidate,
  SplitLayoutState,
  TextEdit,
  ThemeMode,
} from "../types";
import { buildTextDiffSummary } from "../utils/textDiff";
import { buildMarkdownFormatDiff, formatMarkdown, type MarkdownFormatResult } from "../utils/markdownFormat";
import { mergeEditorPosition } from "../utils/editorPosition";
import { extractOutlineWithLines } from "../utils/outline";
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
  backlinksFromIndex,
  createWikiWorkspaceIndex,
  flattenMarkdownFiles,
  knowledgeTags,
  prepareUnlinkedMentionConversion,
  removeWikiIndexEntry,
  resolveWikiLink,
  scoreKnowledgeQuickOpenEntry,
  unlinkedMentionsForPath,
  updateWikiIndexEntry,
  wikiPageFileName,
  type BacklinkItem,
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
  largeFileViewportLines: { main: 0, secondary: 0 } as Record<EditorPaneId, number>,
  isDirty: false,
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
  theme: "light" as ThemeMode,
  activeTheme: "light" as Exclude<ThemeMode, "system">,
  settings: defaultSettings(),
  settingsOpen: false,
  commandPaletteOpen: false,
  wordCountOpen: false,
  wikiBacklinksOpen: false,
  wikiBacklinks: [] as BacklinkItem[],
  wikiBacklinksForPath: "",
  wikiBacklinksBusy: false,
  wikiBacklinksError: "",
  wikiIndex: createWikiWorkspaceIndex([]) as WikiWorkspaceIndex,
  wikiIndexBusy: false,
  wikiIndexError: "",
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
let externalFileWatcherRunning = false;
let externalFileWatcherAvailable = true;
let backlinkRefreshTimer = 0;
let backlinkRefreshGeneration = 0;
let wikiIndexRefreshTimer = 0;
let wikiIndexGeneration = 0;
let wikiIndexHydrationPromise: Promise<void> | null = null;
let workspaceKnowledgeRefreshTimer = 0;
const pendingWikiIndexUpdates = new Map<string, { path: string; content: string }>();
const workspaceKnowledgePendingPaths = new Set<string>();
const watchedFilePaths = new Map<string, string>();

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

export const workspaceKnowledgeTags = computed(() => knowledgeTags(appStore.wikiIndex));

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
  const source = getPaneContent(paneId);
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

export function setPaneContent(paneId: EditorPaneId, content: string, dirty = true) {
  const tab = getPaneTab(paneId);
  if (tab?.documentMode === "large") return;
  if (!tab && paneId === appStore.splitLayout.activePaneId) ensureEditableTab();
  const target = getPaneTab(paneId);
  if (!target || target.documentMode === "large") return;
  target.content = content;
  target.isDirty = dirty;
  target.documentMode = "normal";
  if (paneId === appStore.splitLayout.activePaneId || target.id === appStore.activeTabId) {
    appStore.currentContent = content;
    appStore.isDirty = dirty;
    appStore.documentMode = target.documentMode;
  }
  scheduleKnowledgeRefresh();
  scheduleWikiIndexEntryRefresh(target.path, content);
}

export function getPaneTab(paneId: EditorPaneId) {
  const id = paneTabId(appStore.splitLayout, paneId);
  return appStore.tabs.find((tab) => tab.id === id) ?? null;
}

export function getPaneEditorMode(paneId: EditorPaneId) {
  const tab = getPaneTab(paneId);
  return tab?.documentMode === "large" ? "wysiwyg" : tab?.editorMode ?? appStore.editorMode;
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

export function updateLargeFileViewportLine(paneId: EditorPaneId, line: number) {
  appStore.largeFileViewportLines[paneId] = Math.max(0, Math.floor(Number.isFinite(line) ? line : 0));
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

export async function loadConfig() {
  const config = await invoke<AppConfig>("read_app_config");
  appStore.recentFiles = config.recentFiles ?? [];
  appStore.settings = normalizeSettings(config);
  appStore.theme = appStore.settings.appearance.theme;
  resetOpenDocument();
  appStore.tabs = [];
  appStore.activeTabId = "";
  appStore.splitLayout = defaultSplitLayout();
  appStore.currentWorkspace = "";
  appStore.fileTree = [];
  if (shouldRestoreSession(config)) {
    if (config.session?.workspacePath) {
      appStore.currentWorkspace = config.session.workspacePath;
      try {
        await refreshFileTree();
      } catch {
        appStore.currentWorkspace = "";
        appStore.fileTree = [];
      }
    }
    await restoreSession(config.session);
  }
}

export async function persistConfig() {
  syncActiveTabFromProjection();
  const config: AppConfig = {
    recentFiles: appStore.recentFiles,
    settings: appStore.settings,
    session: buildSessionRestoreState(),
  };
  await invoke("write_app_config", { config });
}

export async function refreshFileTree() {
  if (!appStore.currentWorkspace) {
    appStore.fileTree = [];
    appStore.wikiIndex = createWikiWorkspaceIndex([]);
    appStore.wikiIndexError = "";
    return;
  }
  appStore.fileTree = await invoke<FileNode[]>("list_markdown_files", {
    folder: appStore.currentWorkspace,
  });
  appStore.wikiIndex = createWikiWorkspaceIndex(appStore.fileTree, appStore.currentWorkspace);
  appStore.wikiIndexError = "";
  const hydration = hydrateWikiWorkspaceIndex();
  wikiIndexHydrationPromise = hydration;
  void hydration.finally(() => {
    if (wikiIndexHydrationPromise === hydration) wikiIndexHydrationPromise = null;
  });
}

async function hydrateWikiWorkspaceIndex() {
  const generation = ++wikiIndexGeneration;
  const index = appStore.wikiIndex;
  appStore.wikiIndexBusy = true;
  appStore.wikiIndexError = "";
  try {
    const entries = [...index.entries];
    for (let offset = 0; offset < entries.length; offset += 12) {
      if (generation !== wikiIndexGeneration || index !== appStore.wikiIndex) return;
      const batch = entries.slice(offset, offset + 12);
      const contents = await Promise.all(batch.map(async (entry) => [entry.path, await contentForWikiIndex(entry.path)] as const));
      for (const [path, content] of contents) updateWikiIndexEntry(index, path, content);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    scheduleKnowledgeRefresh();
  } catch (error) {
    if (generation === wikiIndexGeneration) appStore.wikiIndexError = String(error);
  } finally {
    if (generation === wikiIndexGeneration) appStore.wikiIndexBusy = false;
  }
}

async function contentForWikiIndex(path: string) {
  const tab = appStore.tabs.find((item) => item.path && isSamePath(item.path, path));
  if (tab?.kind === "normal") return tab.content;
  return await invoke<string>("read_text_file", { path }).catch(() => "");
}

function scheduleWikiIndexEntryRefresh(path: string, content: string) {
  if (!path || typeof window === "undefined") return;
  pendingWikiIndexUpdates.set(normalizePathKey(path), { path, content });
  if (wikiIndexRefreshTimer) window.clearTimeout(wikiIndexRefreshTimer);
  wikiIndexRefreshTimer = window.setTimeout(() => {
    wikiIndexRefreshTimer = 0;
    const updates = [...pendingWikiIndexUpdates.values()];
    pendingWikiIndexUpdates.clear();
    for (const update of updates) {
      updateWikiIndexEntry(appStore.wikiIndex, update.path, update.content);
    }
    scheduleKnowledgeRefresh();
  }, 250);
}

export async function openWorkspace(folder?: string) {
  const selected = folder ?? (await invoke<string | null>("open_folder_dialog"));
  if (!selected) return;
  await stopWorkspaceKnowledgeWatch();
  appStore.currentWorkspace = selected;
  await refreshFileTree();
  await syncWorkspaceKnowledgeWatch();
  void refreshKnowledge();
  await persistConfig();
}

export async function refreshKnowledgeIndex() {
  await refreshFileTree();
  void refreshKnowledge();
}

export async function syncWorkspaceKnowledgeWatch() {
  await invoke("unwatch_markdown_workspace").catch(() => {});
  if (!appStore.currentWorkspace) return;
  await invoke("watch_markdown_workspace", { path: appStore.currentWorkspace }).catch((error) => {
    appStore.wikiIndexError = `工作区监听不可用：${error}`;
  });
}

export async function stopWorkspaceKnowledgeWatch() {
  if (workspaceKnowledgeRefreshTimer && typeof window !== "undefined") {
    window.clearTimeout(workspaceKnowledgeRefreshTimer);
    workspaceKnowledgeRefreshTimer = 0;
  }
  workspaceKnowledgePendingPaths.clear();
  await invoke("unwatch_markdown_workspace").catch(() => {});
}

export function scheduleWorkspaceKnowledgeRefresh(paths: string[] = []) {
  if (!appStore.currentWorkspace || typeof window === "undefined") return;
  for (const path of paths) {
    if (isMarkdownFilePath(path)) workspaceKnowledgePendingPaths.add(path);
  }
  if (workspaceKnowledgeRefreshTimer) window.clearTimeout(workspaceKnowledgeRefreshTimer);
  const expectedWorkspace = appStore.currentWorkspace;
  workspaceKnowledgeRefreshTimer = window.setTimeout(() => {
    workspaceKnowledgeRefreshTimer = 0;
    const pendingPaths = [...workspaceKnowledgePendingPaths];
    workspaceKnowledgePendingPaths.clear();
    void refreshChangedKnowledgePaths(pendingPaths, expectedWorkspace);
  }, 250);
}

async function refreshChangedKnowledgePaths(paths: string[], expectedWorkspace: string) {
  if (!isSamePath(appStore.currentWorkspace, expectedWorkspace)) return;
  const generation = wikiIndexGeneration;
  const index = appStore.wikiIndex;
  appStore.wikiIndexBusy = true;
  appStore.wikiIndexError = "";
  try {
    const nextTree = await invoke<FileNode[]>("list_markdown_files", { folder: expectedWorkspace });
    if (generation !== wikiIndexGeneration || index !== appStore.wikiIndex || !isSamePath(appStore.currentWorkspace, expectedWorkspace)) return;
    appStore.fileTree = nextTree;
    const nextPaths = flattenMarkdownFiles(nextTree);
    const nextKeys = new Set(nextPaths.map(normalizePathKey));
    for (const entry of [...index.entries]) {
      if (!nextKeys.has(normalizePathKey(entry.path))) removeWikiIndexEntry(index, entry.path);
    }
    const changedKeys = new Set(paths.filter(isMarkdownFilePath).map(normalizePathKey));
    const targets = nextPaths.filter((path) => {
      const existing = index.entries.find((entry) => isSamePath(entry.path, path));
      return !existing?.indexed || changedKeys.size === 0 || changedKeys.has(normalizePathKey(path));
    });
    for (let offset = 0; offset < targets.length; offset += 12) {
      const batch = targets.slice(offset, offset + 12);
      const contents = await Promise.all(batch.map(async (path) => [path, await contentForWikiIndex(path)] as const));
      if (generation !== wikiIndexGeneration || index !== appStore.wikiIndex) return;
      contents.forEach(([path, content]) => updateWikiIndexEntry(index, path, content));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    scheduleKnowledgeRefresh();
  } catch (error) {
    if (generation === wikiIndexGeneration) appStore.wikiIndexError = String(error);
  } finally {
    if (generation === wikiIndexGeneration) appStore.wikiIndexBusy = false;
  }
}

export async function openFile(path?: string, options: { recordNavigation?: boolean; paneId?: EditorPaneId } = {}) {
  const selected = path ?? (await invoke<string | null>("open_file_dialog"));
  if (!selected) return;
  const paneId = options.paneId ?? appStore.splitLayout.activePaneId;
  const shouldRecordNavigation = options.recordNavigation !== false;
  if (shouldRecordNavigation) {
    recordCurrentNavigationBeforeOpening(selected);
  }
  await flushCurrentDraft();
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
  let tab: DocumentTab;
  if (info.isLarge) {
    const session = await invoke<LargeFileSession>("open_large_file", { path: selected });
    tab = createTab({
      path: selected,
      kind: "large",
      content: "",
      documentMode: "large",
      editorMode: "wysiwyg",
      largeFile: {
      sessionId: session.sessionId,
      sizeBytes: session.sizeBytes,
      totalLines: session.totalLines,
      loadedRanges: [],
      pendingEdits: [],
      outline: session.outline,
      },
      isDirty: false,
    });
    appStore.statusMessage = `大文件模式：${formatBytes(session.sizeBytes)}，${session.totalLines} 行`;
  } else {
    const content = await invoke<string>("read_text_file", { path: selected });
    const fileSnapshot = await getFileSnapshot(selected);
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
  if (!appStore.splitLayout.enabled) {
    appStore.splitLayout = enableSplitLayout(appStore.splitLayout, tabIds());
  }
  const paneId = otherPaneId(sourcePaneId);
  await openFile(path, { paneId });
}

export async function activateTabInOtherPane(tabId: string) {
  const sourcePaneId = appStore.splitLayout.activePaneId;
  if (!appStore.splitLayout.enabled) {
    appStore.splitLayout = enableSplitLayout(appStore.splitLayout, tabIds());
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
    if (appStore.wikiIndexBusy && wikiIndexHydrationPromise) await wikiIndexHydrationPromise;
    const backlinks = backlinksFromIndex(targetPath, appStore.wikiIndex);
    const mentions = unlinkedMentionsForPath(targetPath, appStore.wikiIndex);
    if (generation !== backlinkRefreshGeneration || !isSamePath(appStore.currentFilePath, targetPath)) return;
    appStore.wikiBacklinks = backlinks.sort((left, right) => {
      return left.sourceName.localeCompare(right.sourceName, "zh-Hans-CN") || left.line - right.line;
    });
    appStore.wikiUnlinkedMentions = mentions;
    appStore.wikiMentionsForPath = targetPath;
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
  closeTransientPalettes("commandPalette");
  appStore.commandPaletteOpen = true;
}

export function closeCommandPalette() {
  appStore.commandPaletteOpen = false;
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
  if (appStore.documentMode === "large" && appStore.largeFile) {
    appStore.statusMessage = "正在保存大文件...";
    const state = await invoke<DirtyState>("save_large_file", {
      sessionId: appStore.largeFile.sessionId,
    });
    appStore.largeFile.pendingEdits = [];
    appStore.isDirty = state.isDirty;
    appStore.statusMessage = "大文件已保存";
    await clearActiveDraft();
    rememberRecentFile(appStore.currentFilePath);
    syncActiveTabFromProjection();
    await refreshFileTree();
    await persistConfig();
    return true;
  }

  if (!appStore.currentFilePath) {
    const selected = await invoke<string | null>("save_markdown_file_dialog", {
      defaultFileName: defaultMarkdownFileName(),
    });
    if (!selected) return false;
    appStore.currentFilePath = selected;
    retargetActiveTab(selected);
  }
  const tab = getActiveTab();
  if (!(await prepareNormalFileSave(tab))) return false;
  await invoke("write_text_file", {
    path: appStore.currentFilePath,
    content: appStore.currentContent,
  });
  appStore.isDirty = false;
  await refreshActiveFileSnapshot();
  await clearActiveDraft();
  rememberRecentFile(appStore.currentFilePath);
  syncActiveTabFromProjection();
  void syncExternalFileWatches();
  await refreshFileTree();
  await persistConfig();
  return true;
}

async function prepareNormalFileSave(tab: DocumentTab | null) {
  if (!tab || !appStore.currentFilePath || !tab.fileSnapshot?.exists) return true;
  const currentSnapshot = await getFileSnapshot(appStore.currentFilePath);
  if (snapshotsMatch(tab.fileSnapshot, currentSnapshot)) return true;

  if (!currentSnapshot.exists) {
    return await resolveDeletedFileBeforeSave();
  }
  return await resolveChangedFileBeforeSave(appStore.currentFilePath);
}

async function resolveDeletedFileBeforeSave() {
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
  if (result !== "saveAs") return false;
  return await chooseSaveAsTarget();
}

async function resolveChangedFileBeforeSave(originalPath: string) {
  const diff = await conflictDiffDetails(originalPath);
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
    await reloadActiveFileFromDisk(originalPath);
    return false;
  }
  if (result === "saveAs") {
    return await chooseSaveAsTarget(originalPath);
  }
  if (result === "conflictCopy") {
    await saveConflictCopyForCurrentFile();
  }
  return false;
}

async function conflictDiffDetails(path: string) {
  const disk = await invoke<string>("read_text_file", { path }).catch(() => "");
  return buildTextDiffSummary(appStore.currentContent, disk);
}

async function chooseSaveAsTarget(avoidPath?: string) {
  const selected = await invoke<string | null>("save_markdown_file_dialog", {
    defaultFileName: defaultMarkdownFileName(),
  });
  if (!selected) return false;
  if (avoidPath && isSamePath(selected, avoidPath)) {
    await alertDialog({
      title: "请选择不同文件名",
      message: "另存为副本不能使用已经发生外部修改的原文件路径。",
      tone: "danger",
    });
    return false;
  }
  appStore.currentFilePath = selected;
  retargetActiveTab(selected);
  return true;
}

async function reloadActiveFileFromDisk(path: string) {
  const content = await invoke<string>("read_text_file", { path });
  const snapshot = await getFileSnapshot(path);
  appStore.currentContent = content;
  appStore.isDirty = false;
  const tab = getActiveTab();
  if (tab) {
    tab.content = content;
    tab.isDirty = false;
    tab.fileSnapshot = snapshot;
    clearTabExternalState(tab);
  }
  await clearActiveDraft();
  appStore.statusMessage = "已重载磁盘版本";
}

async function refreshActiveFileSnapshot() {
  const tab = getActiveTab();
  if (!tab || !appStore.currentFilePath) return;
  tab.fileSnapshot = await getFileSnapshot(appStore.currentFilePath);
  clearTabExternalState(tab);
}

function getFileSnapshot(path: string) {
  return invoke<FileSnapshot>("get_file_snapshot", { path });
}

function snapshotsMatch(left: FileSnapshot, right: FileSnapshot) {
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
  if (externalFileCheckInFlight) return;
  externalFileCheckInFlight = true;
  try {
    for (const tab of appStore.tabs) {
      if (tab.kind !== "normal" || !tab.path || !tab.fileSnapshot?.exists) continue;
      const snapshot = await getFileSnapshot(tab.path).catch((): FileSnapshot => ({ exists: false }));
      updateTabExternalState(tab, snapshot);
      if (tab.externalState === "deleted") {
        tab.relocationCandidates = await findSimilarFileCandidates(tab);
      }
    }
  } finally {
    externalFileCheckInFlight = false;
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
  const tab = getActiveTab();
  if (!tab?.path || tab.kind !== "normal") return;
  await reloadActiveFileFromDisk(tab.path);
  syncActiveTabFromProjection();
  void syncExternalFileWatches();
  await persistConfig();
}

export async function saveCurrentFileAsExternalCopy() {
  const tab = getActiveTab();
  if (!tab?.path) return false;
  if (!(await chooseSaveAsTarget(tab.path))) return false;
  return await saveCurrentFile();
}

export async function saveConflictCopyForCurrentFile() {
  if (!appStore.currentFilePath) return false;
  const target = conflictCopyPath(appStore.currentFilePath);
  await invoke("write_text_file", {
    path: target,
    content: appStore.currentContent,
  });
  rememberRecentFile(target);
  await refreshFileTree();
  await persistConfig();
  appStore.statusMessage = `已保存冲突副本：${fileNameFromPath(target)}`;
  return true;
}

export async function showCurrentFileDiffSummary() {
  const tab = getActiveTab();
  if (!tab?.path) return;
  const details = await conflictDiffDetails(tab.path);
  await alertDialog({
    title: "外部修改差异摘要",
    message: "以下是当前内存内容与磁盘内容的简化行级差异。",
    details,
  });
}

export async function rebindCurrentFileToCandidate(path: string) {
  const tab = getActiveTab();
  if (!tab || !path) return false;
  const existing = findFileTab(path);
  if (existing && existing.id !== tab.id) {
    appStore.statusMessage = "候选文件已在其他标签页打开";
    return false;
  }
  const snapshot = await getFileSnapshot(path);
  const previousPath = appStore.currentFilePath;
  tab.id = tabIdForPath(path);
  tab.path = path;
  tab.name = fileNameFromPath(path);
  tab.fileSnapshot = snapshot;
  clearTabExternalState(tab);
  appStore.activeTabId = tab.id;
  appStore.currentFilePath = path;
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

export function createUntitledTab(content = "", dirty = false, paneId: EditorPaneId = appStore.splitLayout.activePaneId) {
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

export function ensureDefaultTab() {
  if (appStore.tabs.length > 0) return;
  createUntitledTab("", false);
}

export async function activateTab(tabId: string) {
  await activateTabInPane(appStore.splitLayout.activePaneId, tabId);
}

export async function activateTabInPane(paneId: EditorPaneId, tabId: string) {
  if (tabId === appStore.activeTabId && paneId === appStore.splitLayout.activePaneId) return;
  syncActiveTabFromProjection();
  const tab = appStore.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  projectTabInPane(tab, paneId);
  void refreshBacklinks();
  await persistConfig();
}

export async function setActivePane(paneId: EditorPaneId) {
  if (paneId === appStore.splitLayout.activePaneId) return;
  syncActiveTabFromProjection();
  const nextTabId = paneTabId(appStore.splitLayout, paneId) || appStore.activeTabId;
  const tab = appStore.tabs.find((item) => item.id === nextTabId) ?? getActiveTab();
  appStore.splitLayout = normalizeSplitLayout({ ...appStore.splitLayout, activePaneId: paneId }, tabIds(), tab?.id ?? "");
  if (tab) projectTab(tab);
  await persistConfig();
}

export async function toggleSplitLayout() {
  syncActiveTabFromProjection();
  if (appStore.splitLayout.enabled) {
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
  return appStore.tabs.filter((tab) => tab.isDirty);
}

export async function saveAllDirtyTabs() {
  const dirtyTabs = getDirtyTabs();
  for (const tab of dirtyTabs) {
    await activateTab(tab.id);
    const saved = await saveCurrentFile();
    if (!saved) return false;
  }
  return true;
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
  });
  await refreshFileTree();
  await openFile(path);
}

export function switchMode(mode: EditorMode, paneId: EditorPaneId = appStore.splitLayout.activePaneId) {
  const tab = getPaneTab(paneId);
  if (!tab) return;
  if (tab.documentMode === "large") {
    tab.editorMode = "wysiwyg";
    if (paneId === appStore.splitLayout.activePaneId) appStore.editorMode = "wysiwyg";
    return;
  }
  if (mode === tab.editorMode) return;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("lightmark:capture-mode-cursor", {
        detail: { from: tab.editorMode, to: mode, paneId },
      }),
    );
  }
  tab.editorMode = mode;
  if (paneId === appStore.splitLayout.activePaneId || tab.id === appStore.activeTabId) {
    appStore.editorMode = mode;
    syncActiveTabFromProjection();
  }
}

export async function readLargeFileChunk(startLine: number, lineCount: number) {
  if (!appStore.largeFile) throw new Error("未打开大文件。");
  const chunk = await invoke<FileChunk>("read_file_chunk", {
    sessionId: appStore.largeFile.sessionId,
    startLine,
    lineCount,
  });
  appStore.largeFile.loadedRanges = mergeLoadedRanges(appStore.largeFile.loadedRanges, {
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  });
  return chunk;
}

export async function applyLargeFileEdits(edits: TextEdit[]) {
  if (!appStore.largeFile || edits.length === 0) return;
  const state = await invoke<DirtyState>("apply_file_edits", {
    sessionId: appStore.largeFile.sessionId,
    edits,
  });
  appStore.largeFile.pendingEdits.push(...edits);
  appStore.isDirty = state.isDirty;
  appStore.statusMessage = `待保存编辑：${state.pendingEditCount}`;
  syncActiveTabFromProjection();
}

async function closeTabInternal(
  tabId: string,
  options: { ensureDefault: boolean; nextActiveId?: string },
) {
  const tab = appStore.tabs.find((item) => item.id === tabId);
  if (!tab) return false;
  if (tab.id !== appStore.activeTabId) {
    await activateTab(tab.id);
  } else {
    syncActiveTabFromProjection();
  }
  if (appStore.isDirty) {
    const action = await requestSaveDiscardCancel({
      title: "关闭未保存的标签页？",
      message: `“${currentFileName.value}”有未保存的修改。`,
      saveLabel: "保存并关闭",
      discardLabel: "不保存",
    });
    if (action === "cancel") return false;
    if (action === "save") {
      try {
        const saved = await saveCurrentFile();
        if (!saved) return false;
      } catch (error) {
        appStore.statusMessage = String(error);
        await showSaveFailure(error);
        return false;
      }
    }
  }

  const closingTab = getActiveTab();
  const index = appStore.tabs.findIndex((item) => item.id === tabId);
  if (index < 0 || !closingTab) return false;
  rememberClosedTab(closingTab);
  await closeLargeFileSession();
  appStore.tabs.splice(index, 1);
  appStore.splitLayout = resolveClosedTabSplitLayout(appStore.splitLayout, tabId, tabIds());

  if (appStore.tabs.length === 0) {
    resetOpenDocument();
    if (options.ensureDefault) ensureDefaultTab();
    return true;
  }

  const preferred = options.nextActiveId ? appStore.tabs.find((item) => item.id === options.nextActiveId) : null;
  const paneNext = appStore.tabs.find((item) => item.id === paneTabId(appStore.splitLayout, appStore.splitLayout.activePaneId));
  const next = preferred ?? paneNext ?? appStore.tabs[Math.max(0, Math.min(index, appStore.tabs.length - 1))];
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
  appStore.settings = normalizeSettings({ recentFiles: appStore.recentFiles, settings });
  appStore.theme = appStore.settings.appearance.theme;
  applyTheme();
  await persistConfig();
  if (previousMathNumbering !== appStore.settings.markdown.mathNumbering) {
    window.dispatchEvent(new CustomEvent("lightmark:math-settings-changed"));
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
    },
    appearance: {
      theme: "system",
      editorWidth: 860,
      fontFamily: `"Open Sans", "Clear Sans", "Helvetica Neue", Helvetica, Arial, sans-serif`,
      fontSize: 16,
      lineHeight: 1.6,
      paragraphSpacing: 0.8,
      codeFontFamily: `"JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace`,
      showSidebar: true,
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
    image: { ...defaults.image, ...source.image },
    appearance: {
      ...defaults.appearance,
      ...source.appearance,
      theme: normalizeThemeValue(migratedTheme) ?? defaults.appearance.theme,
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
            editorMode: "wysiwyg",
            largeFile: {
              sessionId: largeSession.sessionId,
              sizeBytes: largeSession.sizeBytes,
              totalLines: largeSession.totalLines,
              loadedRanges: [],
              pendingEdits: [],
              outline: largeSession.outline,
            },
            isDirty: false,
            lastActiveAt: item.lastActiveAt,
            position: normalizeSessionPosition(item.position, "wysiwyg"),
          }),
        );
      } else {
        const content = await invoke<string>("read_text_file", { path: item.path });
        const fileSnapshot = await getFileSnapshot(item.path);
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
          }),
        );
      }
    } catch {
      // Missing files should not block app startup.
    }
  }
  if (restored.length === 0) return;
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
  appStore.editorMode = tab.documentMode === "large" ? "wysiwyg" : tab.editorMode;
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
  tab.id = tabIdForPath(path);
  tab.kind = "normal";
  tab.path = path;
  tab.name = fileNameFromPath(path);
  tab.fileSnapshot = undefined;
  clearTabExternalState(tab);
  appStore.activeTabId = tab.id;
  appStore.splitLayout = splitLayoutForPaneActivation(appStore.splitLayout, appStore.splitLayout.activePaneId, tab.id, tabIds());
}

function getActiveTab() {
  return appStore.tabs.find((tab) => tab.id === appStore.activeTabId) ?? null;
}

function findFileTab(path: string) {
  return appStore.tabs.find((tab) => tab.path && isSamePath(tab.path, path)) ?? null;
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

function defaultMarkdownFileName() {
  const name = currentFileName.value.trim() || "未命名";
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
    message: error instanceof Error ? error.message : String(error),
    tone: "danger",
  });
}

async function closeLargeFileSession() {
  if (!appStore.largeFile) return;
  const sessionId = appStore.largeFile.sessionId;
  appStore.largeFile = null;
  await invoke("close_large_file", { sessionId }).catch(() => {});
}

function resetOpenDocument() {
  appStore.currentFilePath = "";
  appStore.currentContent = "";
  appStore.documentMode = "normal";
  appStore.largeFile = null;
  appStore.isDirty = false;
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
