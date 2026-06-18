import { computed, reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  AppSettings,
  DirtyState,
  DocumentMode,
  EditorMode,
  ImageInsertBehavior,
  FileChunk,
  FileInfo,
  FileNode,
  LargeFileSession,
  LargeFileState,
  PendingModeCursor,
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
  recentFiles: [] as string[],
  theme: "light" as ThemeMode,
  settings: defaultSettings(),
  settingsOpen: false,
  commandPaletteOpen: false,
  wordCountOpen: false,
  pendingModeCursor: null as PendingModeCursor | null,
  statusMessage: "",
});

export const currentFileName = computed(() => {
  if (!appStore.currentFilePath) return "未命名";
  return appStore.currentFilePath.split(/[\\/]/).pop() || appStore.currentFilePath;
});

export function setContent(content: string, dirty = true) {
  if (appStore.documentMode === "large") return;
  appStore.currentContent = content;
  appStore.isDirty = dirty;
}

export async function loadConfig() {
  const config = await invoke<AppConfig>("read_app_config");
  appStore.recentFiles = config.recentFiles ?? [];
  appStore.settings = normalizeSettings(config);
  appStore.theme = appStore.settings.appearance.theme;
  resetOpenDocument();
  appStore.currentWorkspace = "";
  appStore.fileTree = [];
}

export async function persistConfig() {
  const config: AppConfig = {
    recentFiles: appStore.recentFiles,
    settings: appStore.settings,
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
  if (selected !== appStore.currentFilePath && !(await confirmDiscardOrSave())) return;
  await closeLargeFileSession();
  resetOpenDocument();
  const info = await invoke<FileInfo>("get_file_info", { path: selected });
  if (info.isLarge) {
    const session = await invoke<LargeFileSession>("open_large_file", { path: selected });
    appStore.documentMode = "large";
    appStore.editorMode = "wysiwyg";
    appStore.currentContent = "";
    appStore.largeFile = {
      sessionId: session.sessionId,
      sizeBytes: session.sizeBytes,
      totalLines: session.totalLines,
      loadedRanges: [],
      pendingEdits: [],
      outline: session.outline,
    };
    appStore.currentFilePath = selected;
    appStore.isDirty = false;
    appStore.statusMessage = `大文件模式：${formatBytes(session.sizeBytes)}，${session.totalLines} 行`;
  } else {
    const content = await invoke<string>("read_text_file", { path: selected });
    appStore.documentMode = "normal";
    appStore.largeFile = null;
    appStore.currentContent = content;
    appStore.currentFilePath = selected;
    appStore.isDirty = false;
    appStore.editorMode = appStore.settings.editor.defaultMode;
    appStore.statusMessage = "";
  }
  rememberRecentFile(selected);
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
    rememberRecentFile(appStore.currentFilePath);
    await refreshFileTree();
    await persistConfig();
    return;
  }

  if (!appStore.currentFilePath) {
    if (!appStore.currentWorkspace) throw new Error("请先打开一个工作区，再创建文件。");
    const created = await invoke<string>("create_markdown_file", {
      folder: appStore.currentWorkspace,
      name: "未命名.md",
    });
    appStore.currentFilePath = created;
  }
  await invoke("write_text_file", {
    path: appStore.currentFilePath,
    content: appStore.currentContent,
  });
  appStore.isDirty = false;
  rememberRecentFile(appStore.currentFilePath);
  await refreshFileTree();
  await persistConfig();
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
}

export async function setTheme(theme: ThemeMode) {
  appStore.theme = theme;
  appStore.settings.appearance.theme = theme;
  applyTheme();
  await persistConfig();
}

export function applyTheme() {
  const activeTheme = normalizeTheme(appStore.theme);
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
    export: { ...defaults.export, ...source.export },
    shortcuts: { ...defaults.shortcuts, ...source.shortcuts },
    advanced: { ...defaults.advanced, ...source.advanced },
  } satisfies AppSettings;
}

function normalizeThemeValue(theme: ThemeMode | undefined) {
  return theme === "light" || theme === "dark" || theme === "system" ? theme : undefined;
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

function rememberRecentFile(path: string) {
  appStore.recentFiles = [path, ...appStore.recentFiles.filter((item) => item !== path)].slice(
    0,
    appStore.settings.general.recentFilesLimit,
  );
}

async function confirmDiscardOrSave() {
  if (!appStore.isDirty) return true;
  const save = window.confirm("当前文件有未保存的修改，切换前是否保存？");
  if (save) {
    await saveCurrentFile();
    return true;
  }
  return window.confirm("不保存并继续切换？");
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
