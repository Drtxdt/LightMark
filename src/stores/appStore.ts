import { computed, reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { checkDraftForOpenedFile, clearActiveDraft, flushCurrentDraft } from "./draftStore";
import { alertDialog, showDialog } from "./dialogStore";
import type {
  AppConfig,
  AppSettings,
  DirtyState,
  DocumentTab,
  DocumentMode,
  EditorMode,
  ExportStatus,
  ExportTargetId,
  ImageInsertBehavior,
  FileChunk,
  FileInfo,
  FileNode,
  LargeFileSession,
  LargeFileState,
  PendingModeCursor,
  SessionRestoreState,
  SessionTabState,
  TextEdit,
  ThemeMode,
} from "../types";

export const appStore = reactive({
  currentWorkspace: "",
  fileTree: [] as FileNode[],
  currentFilePath: "",
  currentContent: "",
  documentMode: "normal" as DocumentMode,
  largeFile: null as LargeFileState | null,
  isDirty: false,
  editorMode: "wysiwyg" as EditorMode,
  tabs: [] as DocumentTab[],
  activeTabId: "",
  recentFiles: [] as string[],
  theme: "light" as ThemeMode,
  activeTheme: "light" as Exclude<ThemeMode, "system">,
  settings: defaultSettings(),
  settingsOpen: false,
  commandPaletteOpen: false,
  wordCountOpen: false,
  pendingModeCursor: null as PendingModeCursor | null,
  exportStatus: {
    status: "idle",
    message: "",
  } as ExportStatus,
  statusMessage: "",
});

export const currentFileName = computed(() => {
  const tab = getActiveTab();
  if (tab) return tab.name;
  if (!appStore.currentFilePath) return "未命名";
  return appStore.currentFilePath.split(/[\\/]/).pop() || appStore.currentFilePath;
});

export function setContent(content: string, dirty = true) {
  if (appStore.documentMode === "large") return;
  ensureEditableTab();
  appStore.currentContent = content;
  appStore.isDirty = dirty;
  syncActiveTabFromProjection();
}

export async function loadConfig() {
  const config = await invoke<AppConfig>("read_app_config");
  appStore.recentFiles = config.recentFiles ?? [];
  appStore.settings = normalizeSettings(config);
  appStore.theme = appStore.settings.appearance.theme;
  resetOpenDocument();
  appStore.tabs = [];
  appStore.activeTabId = "";
  appStore.currentWorkspace = "";
  appStore.fileTree = [];
  if (shouldRestoreSession(config)) {
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
    return;
  }
  appStore.fileTree = await invoke<FileNode[]>("list_markdown_files", {
    folder: appStore.currentWorkspace,
  });
}

export async function openWorkspace(folder?: string) {
  const selected = folder ?? (await invoke<string | null>("open_folder_dialog"));
  if (!selected) return;
  appStore.currentWorkspace = selected;
  await refreshFileTree();
  await persistConfig();
}

export async function openFile(path?: string) {
  const selected = path ?? (await invoke<string | null>("open_file_dialog"));
  if (!selected) return;
  await flushCurrentDraft();
  syncActiveTabFromProjection();
  const existing = findFileTab(selected);
  if (existing) {
    await activateTab(existing.id);
    await checkDraftForOpenedFile(selected);
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
    tab = createTab({
      path: selected,
      kind: "normal",
      content,
      documentMode: "normal",
      editorMode: appStore.settings.editor.defaultMode,
      largeFile: null,
      isDirty: false,
    });
    appStore.statusMessage = "";
  }
  appStore.tabs.push(tab);
  projectTab(tab);
  rememberRecentFile(selected);
  await checkDraftForOpenedFile(selected);
  await persistConfig();
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
  await invoke("write_text_file", {
    path: appStore.currentFilePath,
    content: appStore.currentContent,
  });
  appStore.isDirty = false;
  await clearActiveDraft();
  rememberRecentFile(appStore.currentFilePath);
  syncActiveTabFromProjection();
  await refreshFileTree();
  await persistConfig();
  return true;
}

export function createUntitledTab(content = "", dirty = false) {
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
  projectTab(tab);
  void persistConfig();
  return tab;
}

export function ensureDefaultTab() {
  if (appStore.tabs.length > 0) return;
  createUntitledTab("", false);
}

export async function activateTab(tabId: string) {
  if (tabId === appStore.activeTabId) return;
  syncActiveTabFromProjection();
  const tab = appStore.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  projectTab(tab);
  await persistConfig();
}

export async function closeTab(tabId: string) {
  const tab = appStore.tabs.find((item) => item.id === tabId);
  if (!tab) return;
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
    if (action === "cancel") return;
    if (action === "save") {
      try {
        const saved = await saveCurrentFile();
        if (!saved) return;
      } catch (error) {
        appStore.statusMessage = String(error);
        await showSaveFailure(error);
        return;
      }
    }
  }
  const index = appStore.tabs.findIndex((item) => item.id === tab.id);
  await closeLargeFileSession();
  appStore.tabs.splice(index, 1);
  if (appStore.tabs.length === 0) {
    resetOpenDocument();
    ensureDefaultTab();
  } else {
    const next = appStore.tabs[Math.max(0, Math.min(index, appStore.tabs.length - 1))];
    projectTab(next);
  }
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

export function switchMode(mode: EditorMode) {
  if (appStore.documentMode === "large") {
    appStore.editorMode = "wysiwyg";
    return;
  }
  if (mode === appStore.editorMode) return;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("lightmark:capture-mode-cursor", {
        detail: { from: appStore.editorMode, to: mode },
      }),
    );
  }
  appStore.editorMode = mode;
  syncActiveTabFromProjection();
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
  appStore.settings = normalizeSettings({ recentFiles: appStore.recentFiles, settings });
  appStore.theme = appStore.settings.appearance.theme;
  applyTheme();
  await persistConfig();
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
    markdown: { ...defaults.markdown, ...source.markdown },
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
          }),
        );
      } else {
        const content = await invoke<string>("read_text_file", { path: item.path });
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
          }),
        );
      }
    } catch {
      // Missing files should not block app startup.
    }
  }
  if (restored.length === 0) return;
  appStore.tabs = restored;
  const active =
    restored.find((tab) => session.activeTabKey && isSamePath(tab.path, session.activeTabKey)) ??
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
    }));
  if (openTabs.length === 0) return undefined;
  return {
    openTabs,
    activeTabKey: getActiveTab()?.path || undefined,
  };
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
  tab.lastActiveAt = Date.now();
}

function retargetActiveTab(path: string) {
  const tab = getActiveTab();
  if (!tab) return;
  tab.id = tabIdForPath(path);
  tab.kind = "normal";
  tab.path = path;
  tab.name = fileNameFromPath(path);
  appStore.activeTabId = tab.id;
}

function getActiveTab() {
  return appStore.tabs.find((tab) => tab.id === appStore.activeTabId) ?? null;
}

function findFileTab(path: string) {
  return appStore.tabs.find((tab) => tab.path && isSamePath(tab.path, path)) ?? null;
}

function tabIdForPath(path: string) {
  return `file:${hashString(normalizePathKey(path))}`;
}

function isSamePath(left: string, right: string) {
  return normalizePathKey(left) === normalizePathKey(right);
}

function normalizePathKey(path: string) {
  return path.replace(/\\/g, "/").toLocaleLowerCase();
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
