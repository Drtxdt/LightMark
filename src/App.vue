<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, watch } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AppLayout from "./components/layout/AppLayout.vue";
import AppDialog from "./components/dialog/AppDialog.vue";
const CommandPalette = defineAsyncComponent(() => import("./components/command/CommandPalette.vue"));
const GoToLinePalette = defineAsyncComponent(() => import("./components/command/GoToLinePalette.vue"));
const HeadingJumpPalette = defineAsyncComponent(() => import("./components/command/HeadingJumpPalette.vue"));
const FormulaJumpPalette = defineAsyncComponent(() => import("./components/command/FormulaJumpPalette.vue"));
const QuickOpenPalette = defineAsyncComponent(() => import("./components/command/QuickOpenPalette.vue"));
const SettingsDialog = defineAsyncComponent(() => import("./components/settings/SettingsDialog.vue"));
const WordCountPanel = defineAsyncComponent(() => import("./components/plugin/WordCountPanel.vue"));
import { activatePlugins } from "./plugins/registry";
import { wordCountPlugin } from "./plugins/wordCountPlugin";
import {
  appStore,
  applyTheme,
  currentFileName,
  ensureDefaultTab,
  getDirtyTabs,
  goBackNavigation,
  goForwardNavigation,
  checkOpenFileSnapshots,
  loadConfig,
  openCommandPalette,
  openHeadingJump,
  openGoToLine,
  openQuickOpen,
  saveAllDirtyTabs,
  saveCurrentFile,
  scheduleWorkspaceKnowledgeRefresh,
  showSaveFailure,
  startExternalFileMonitor,
  stopExternalFileMonitor,
  stopWorkspaceKnowledgeWatch,
  syncWorkspaceKnowledgeWatch,
  toggleDistractionFreeMode,
  toggleFocusMode,
  toggleTypewriterMode,
} from "./stores/appStore";
import { closeFindPanel, openFindPanel } from "./stores/findReplaceStore";
import { bindShortcut } from "./utils/shortcuts";
import { hasVisibleBlockingOverlay } from "./utils/writingModes";
import { getImageFilesFromClipboard, getImageFilesFromDrop } from "./utils/imageAssets";
import { syncWindowChrome } from "./utils/windowChrome";
import { flushCurrentDraft, recoverStartupDrafts, startDraftAutosave, stopDraftAutosave } from "./stores/draftStore";
import { showDialog } from "./stores/dialogStore";

let unbindSave = () => {};
let unbindPalette = () => {};
let unbindQuickOpen = () => {};
let unbindHeadingJump = () => {};
let unbindGoToLine = () => {};
let unbindNavigationBack = () => {};
let unbindNavigationForward = () => {};
let unbindFind = () => {};
let unbindFocusMode = () => {};
let unbindTypewriterMode = () => {};
let unbindDistractionFreeMode = () => {};
let unbindPreventUiSelectAll = () => {};
let unlistenTauriImageDrop: (() => void) | null = null;
let unlistenCloseRequested: (() => void) | null = null;
let unlistenExternalFileWatch: (() => void) | null = null;
let unlistenWorkspaceWatch: (() => void) | null = null;
let unwatchWindowChrome = () => {};
let unwatchDraftAutosave = () => {};
let closingBypass = false;

onMounted(async () => {
  activatePlugins([wordCountPlugin]);
  await loadConfig().catch((error) => {
    appStore.statusMessage = String(error);
  });
  applyTheme();
  startDraftAutosave();
  startExternalFileMonitor();
  await syncWorkspaceKnowledgeWatch();
  await recoverStartupDrafts();
  ensureDefaultTab();
  unwatchWindowChrome = watch(
    () => [currentFileName.value, appStore.activeTheme] as const,
    ([fileName, theme]) => {
      syncWindowChrome(fileName, theme);
    },
    { immediate: true },
  );
  unwatchDraftAutosave = watch(
    () => [appStore.settings.general.autoSave, appStore.settings.general.autoSaveIntervalMinutes] as const,
    () => {
      startDraftAutosave();
    },
  );
  unbindSave = bindShortcut("ctrl+s", () => {
    saveCurrentFile().catch((error) => (appStore.statusMessage = String(error)));
  });
  unbindPalette = bindShortcut("ctrl+shift+p", () => {
    openCommandPalette();
  });
  unbindQuickOpen = bindShortcut("ctrl+p", () => {
    openQuickOpen();
  });
  unbindHeadingJump = bindShortcut("ctrl+shift+o", () => {
    openHeadingJump();
  });
  unbindGoToLine = bindShortcut("ctrl+g", () => {
    openGoToLine();
  });
  unbindNavigationBack = bindShortcut("alt+arrowleft", () => {
    goBackNavigation().catch((error) => (appStore.statusMessage = String(error)));
  });
  unbindNavigationForward = bindShortcut("alt+arrowright", () => {
    goForwardNavigation().catch((error) => (appStore.statusMessage = String(error)));
  });
  unbindFind = bindShortcut("ctrl+f", () => {
    openFindPanel();
  });
  unbindFocusMode = bindShortcut("f8", () => {
    void toggleFocusMode();
  });
  unbindTypewriterMode = bindShortcut("f9", () => {
    void toggleTypewriterMode();
  });
  unbindDistractionFreeMode = bindShortcut("ctrl+shift+f11", () => {
    if (!appStore.distractionFreeMode) closeFindPanel();
    toggleDistractionFreeMode();
  });
  unbindPreventUiSelectAll = bindShortcut("ctrl+a", (event) => {
    if (isEditableTarget(event.target)) return false;
  });
  window.addEventListener("paste", handleGlobalImagePaste);
  window.addEventListener("dragover", handleGlobalImageDragOver);
  window.addEventListener("drop", handleGlobalImageDrop);
  window.addEventListener("keydown", handleDistractionFreeEscape);
  unlistenCloseRequested = await getCurrentWindow().onCloseRequested(handleCloseRequested);
  unlistenExternalFileWatch = await listen("lightmark-file-watch-event", () => {
    void checkOpenFileSnapshots();
  });
  unlistenWorkspaceWatch = await listen<{ paths?: string[] }>("lightmark-workspace-watch-event", (event) => {
    scheduleWorkspaceKnowledgeRefresh(event.payload?.paths ?? []);
  });
  unlistenTauriImageDrop = await getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    const paths = event.payload.paths || [];
    if (paths.length === 0) return;
    window.dispatchEvent(
      new CustomEvent("lightmark:insert-images", {
        detail: {
          paths,
          position: { x: event.payload.position.x, y: event.payload.position.y },
        },
      }),
    );
  });
});

onUnmounted(() => {
  unbindSave();
  unbindPalette();
  unbindQuickOpen();
  unbindHeadingJump();
  unbindGoToLine();
  unbindNavigationBack();
  unbindNavigationForward();
  unbindFind();
  unbindFocusMode();
  unbindTypewriterMode();
  unbindDistractionFreeMode();
  unbindPreventUiSelectAll();
  unwatchWindowChrome();
  unwatchDraftAutosave();
  stopDraftAutosave();
  stopExternalFileMonitor();
  void stopWorkspaceKnowledgeWatch();
  window.removeEventListener("paste", handleGlobalImagePaste);
  window.removeEventListener("dragover", handleGlobalImageDragOver);
  window.removeEventListener("drop", handleGlobalImageDrop);
  window.removeEventListener("keydown", handleDistractionFreeEscape);
  unlistenCloseRequested?.();
  unlistenCloseRequested = null;
  unlistenExternalFileWatch?.();
  unlistenExternalFileWatch = null;
  unlistenWorkspaceWatch?.();
  unlistenWorkspaceWatch = null;
  unlistenTauriImageDrop?.();
  unlistenTauriImageDrop = null;
});

async function handleCloseRequested(event: { preventDefault: () => void }) {
  if (closingBypass) return;
  event.preventDefault();
  const dirtyTabs = getDirtyTabs();
  if (dirtyTabs.length === 0) {
    await closeWindowNow();
    return;
  }

  const result = await showDialog({
    title: "关闭 LightMark 前保存修改？",
    message: `${dirtyTabs.length} 个文档有未保存的修改。`,
    details: dirtyTabs.map((tab) => tab.name),
    cancelId: "cancel",
    defaultId: "save",
    buttons: [
      { id: "cancel", label: "取消", variant: "secondary" },
      { id: "discard", label: "不保存退出", variant: "danger" },
      { id: "save", label: "保存全部并退出", variant: "primary" },
    ],
  });

  if (result === "cancel") return;
  if (result === "save") {
    try {
      const saved = await saveAllDirtyTabs();
      if (!saved) return;
    } catch (error) {
      appStore.statusMessage = String(error);
      await showSaveFailure(error);
      return;
    }
  }
  await closeWindowNow();
}

async function closeWindowNow() {
  await recoverPendingDraftBeforeClose();
  closingBypass = true;
  const window = getCurrentWindow();
  try {
    await window.close();
  } catch (closeError) {
    try {
      await window.destroy();
    } catch (destroyError) {
      closingBypass = false;
      appStore.statusMessage = `关闭窗口失败：${destroyError || closeError}`;
      await showSaveFailure(destroyError || closeError);
    }
  }
}

async function recoverPendingDraftBeforeClose() {
  try {
    await flushCurrentDraft();
  } catch {
    // Closing should not be blocked by a best-effort autosave failure when the user chose to exit.
  }
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], .ProseMirror, .cm-editor"));
}

function handleDistractionFreeEscape(event: KeyboardEvent) {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    !appStore.distractionFreeMode ||
    hasVisibleBlockingOverlay()
  ) {
    return;
  }
  event.preventDefault();
  toggleDistractionFreeMode(false);
}

function handleGlobalImagePaste(event: ClipboardEvent) {
  if (isEditableTarget(event.target)) return;
  const files = getImageFilesFromClipboard(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent("lightmark:insert-images", { detail: { files, source: "clipboard" } }));
}

function handleGlobalImageDragOver(event: DragEvent) {
  if (isEditableTarget(event.target)) return;
  if (getImageFilesFromDrop(event.dataTransfer).length === 0) return;
  event.preventDefault();
}

function handleGlobalImageDrop(event: DragEvent) {
  if (isEditableTarget(event.target)) return;
  const files = getImageFilesFromDrop(event.dataTransfer);
  if (files.length === 0) return;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent("lightmark:insert-images", { detail: { files, source: "drop" } }));
}
</script>

<template>
  <AppLayout />
  <CommandPalette v-if="appStore.commandPaletteOpen" />
  <QuickOpenPalette v-if="appStore.quickOpenOpen" />
  <HeadingJumpPalette v-if="appStore.headingJumpOpen" />
  <FormulaJumpPalette v-if="appStore.formulaJumpOpen" />
  <GoToLinePalette v-if="appStore.goToLineOpen" />
  <SettingsDialog v-if="appStore.settingsOpen" />
  <WordCountPanel v-if="appStore.wordCountOpen" />
  <AppDialog />
</template>
