import { computed, reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, EditorMode, FileNode, ThemeMode } from "../types";

export const appStore = reactive({
  currentWorkspace: "",
  fileTree: [] as FileNode[],
  currentFilePath: "",
  currentContent: "",
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
  const content = await invoke<string>("read_text_file", { path: selected });
  appStore.currentFilePath = selected;
  appStore.currentContent = content;
  appStore.isDirty = false;
  rememberRecentFile(selected);
  await persistConfig();
}

export async function saveCurrentFile() {
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
  appStore.editorMode = mode;
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
