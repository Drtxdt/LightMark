<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import AppLayout from "./components/layout/AppLayout.vue";
import CommandPalette from "./components/command/CommandPalette.vue";
import SettingsDialog from "./components/settings/SettingsDialog.vue";
import WordCountPanel from "./components/plugin/WordCountPanel.vue";
import { activatePlugins } from "./plugins/registry";
import { wordCountPlugin } from "./plugins/wordCountPlugin";
import { appStore, applyTheme, currentFileName, loadConfig, saveCurrentFile } from "./stores/appStore";
import { openFindPanel } from "./stores/findReplaceStore";
import { bindShortcut } from "./utils/shortcuts";
import { getImageFilesFromClipboard, getImageFilesFromDrop } from "./utils/imageAssets";
import { syncWindowChrome } from "./utils/windowChrome";
import { recoverStartupDrafts, startDraftAutosave, stopDraftAutosave } from "./stores/draftStore";

let unbindSave = () => {};
let unbindPalette = () => {};
let unbindFind = () => {};
let unbindPreventUiSelectAll = () => {};
let unlistenTauriImageDrop: (() => void) | null = null;
let unwatchWindowChrome = () => {};
let unwatchDraftAutosave = () => {};

onMounted(async () => {
  activatePlugins([wordCountPlugin]);
  await loadConfig().catch((error) => {
    appStore.statusMessage = String(error);
  });
  applyTheme();
  startDraftAutosave();
  await recoverStartupDrafts();
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
    appStore.commandPaletteOpen = true;
  });
  unbindFind = bindShortcut("ctrl+f", () => {
    openFindPanel();
  });
  unbindPreventUiSelectAll = bindShortcut("ctrl+a", (event) => {
    if (isEditableTarget(event.target)) return false;
  });
  window.addEventListener("paste", handleGlobalImagePaste);
  window.addEventListener("dragover", handleGlobalImageDragOver);
  window.addEventListener("drop", handleGlobalImageDrop);
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
  unbindFind();
  unbindPreventUiSelectAll();
  unwatchWindowChrome();
  unwatchDraftAutosave();
  stopDraftAutosave();
  window.removeEventListener("paste", handleGlobalImagePaste);
  window.removeEventListener("dragover", handleGlobalImageDragOver);
  window.removeEventListener("drop", handleGlobalImageDrop);
  unlistenTauriImageDrop?.();
  unlistenTauriImageDrop = null;
});

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], .ProseMirror, .cm-editor"));
}

function handleGlobalImagePaste(event: ClipboardEvent) {
  if (isEditableTarget(event.target)) return;
  const files = getImageFilesFromClipboard(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent("lightmark:insert-images", { detail: { files } }));
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
  window.dispatchEvent(new CustomEvent("lightmark:insert-images", { detail: { files } }));
}
</script>

<template>
  <AppLayout />
  <CommandPalette v-if="appStore.commandPaletteOpen" />
  <SettingsDialog v-if="appStore.settingsOpen" />
  <WordCountPanel v-if="appStore.wordCountOpen" />
</template>
