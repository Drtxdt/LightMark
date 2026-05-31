import { computed, reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  DirtyState,
  DocumentMode,
  EditorMode,
  FileChunk,
  FileInfo,
  FileNode,
  LargeFileSession,
  LargeFileState,
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
  theme: "system" as ThemeMode,
  commandPaletteOpen: false,
  wordCountOpen: false,
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
  appStore.theme = config.theme ?? "system";
  if (config.lastWorkspace) {
    appStore.currentWorkspace = config.lastWorkspace;
    await refreshFileTree();
  }
}

export async function persistConfig() {
  const config: AppConfig = {
    recentFiles: appStore.recentFiles,
    lastWorkspace: appStore.currentWorkspace || null,
    theme: appStore.theme,
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
  const info = await invoke<FileInfo>("get_file_info", { path: selected });
  appStore.currentFilePath = selected;
  appStore.isDirty = false;
  appStore.statusMessage = "";
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
    appStore.statusMessage = `大文件模式：${formatBytes(session.sizeBytes)}，${session.totalLines} 行`;
  } else {
    const content = await invoke<string>("read_text_file", { path: selected });
    appStore.documentMode = "normal";
    appStore.largeFile = null;
    appStore.currentContent = content;
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
  applyTheme();
  await persistConfig();
}

export function applyTheme() {
  const dark =
    appStore.theme === "dark" ||
    (appStore.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function rememberRecentFile(path: string) {
  appStore.recentFiles = [path, ...appStore.recentFiles.filter((item) => item !== path)].slice(0, 10);
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
