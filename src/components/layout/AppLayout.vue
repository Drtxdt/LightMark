<script setup lang="ts">
import { computed, ref } from "vue";
import { appStore, setActivePane, setSplitRatio } from "../../stores/appStore";
import Sidebar from "./Sidebar.vue";
import Toolbar from "./Toolbar.vue";
import DocumentTabs from "./DocumentTabs.vue";
import ExternalFileNotice from "./ExternalFileNotice.vue";
import StatusBar from "./StatusBar.vue";
import ExportStatusStrip from "./ExportStatusStrip.vue";
import EditorShell from "../editor/EditorShell.vue";
import FindReplacePanel from "../find/FindReplacePanel.vue";
import { findReplaceStore } from "../../stores/findReplaceStore";
import type { EditorPaneId } from "../../types";

const sidebarWidth = ref(280);
const gridColumns = computed(() => {
  return appStore.settings.appearance.showSidebar ? `${sidebarWidth.value}px 4px minmax(0, 1fr)` : "minmax(0, 1fr)";
});
const splitColumns = computed(() => `${appStore.splitLayout.ratio}fr 4px ${1 - appStore.splitLayout.ratio}fr`);

function isActivePane(paneId: EditorPaneId) {
  return appStore.splitLayout.activePaneId === paneId;
}

function activatePane(paneId: EditorPaneId) {
  void setActivePane(paneId);
}

function startResize(event: PointerEvent) {
  const startX = event.clientX;
  const startWidth = sidebarWidth.value;

  const move = (moveEvent: PointerEvent) => {
    sidebarWidth.value = Math.min(480, Math.max(220, startWidth + moveEvent.clientX - startX));
  };

  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
}

function startSplitResize(event: PointerEvent) {
  const startX = event.clientX;
  const startRatio = appStore.splitLayout.ratio;
  const container = (event.currentTarget as HTMLElement).parentElement;
  const width = container?.getBoundingClientRect().width || 1;

  const move = (moveEvent: PointerEvent) => {
    appStore.splitLayout.ratio = Math.min(0.7, Math.max(0.3, startRatio + (moveEvent.clientX - startX) / width));
  };

  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setSplitRatio(appStore.splitLayout.ratio);
  };

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
}
</script>

<template>
  <div class="flex h-screen flex-col bg-paper-50 text-ink-900 dark:bg-paper-950 dark:text-ink-100">
    <Toolbar />
    <div class="grid min-h-0 flex-1" :style="{ gridTemplateColumns: gridColumns }">
      <Sidebar v-if="appStore.settings.appearance.showSidebar" />
      <div
        v-if="appStore.settings.appearance.showSidebar"
        class="cursor-col-resize border-x border-paper-200 bg-paper-100/70 transition-colors hover:bg-paper-200 dark:border-paper-800 dark:bg-paper-900 dark:hover:bg-paper-800"
        @pointerdown="startResize"
      />
      <main class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-paper-50 dark:bg-paper-950">
        <ExportStatusStrip />
        <template v-if="!appStore.splitLayout.enabled">
          <DocumentTabs pane-id="main" />
          <ExternalFileNotice />
          <FindReplacePanel v-if="findReplaceStore.open" />
          <EditorShell class="min-h-0 flex-1" pane-id="main" />
        </template>
        <div v-else class="grid min-h-0 flex-1" :style="{ gridTemplateColumns: splitColumns }">
          <section class="flex min-h-0 min-w-0 flex-col border-r border-paper-200/70 dark:border-paper-800/70" :class="{ 'ring-1 ring-inset ring-amber-500/35': isActivePane('main') }" @pointerdown.capture="activatePane('main')">
            <DocumentTabs pane-id="main" />
            <ExternalFileNotice v-if="isActivePane('main')" />
            <FindReplacePanel v-if="isActivePane('main') && findReplaceStore.open" />
            <EditorShell class="min-h-0 flex-1" pane-id="main" />
          </section>
          <div
            class="cursor-col-resize border-x border-paper-200 bg-paper-100/70 transition-colors hover:bg-paper-200 dark:border-paper-800 dark:bg-paper-900 dark:hover:bg-paper-800"
            @pointerdown="startSplitResize"
          />
          <section class="flex min-h-0 min-w-0 flex-col" :class="{ 'ring-1 ring-inset ring-amber-500/35': isActivePane('secondary') }" @pointerdown.capture="activatePane('secondary')">
            <DocumentTabs pane-id="secondary" />
            <ExternalFileNotice v-if="isActivePane('secondary')" />
            <FindReplacePanel v-if="isActivePane('secondary') && findReplaceStore.open" />
            <EditorShell class="min-h-0 flex-1" pane-id="secondary" />
          </section>
        </div>
      </main>
    </div>
    <StatusBar />
  </div>
</template>
