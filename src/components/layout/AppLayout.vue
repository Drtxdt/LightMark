<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { appStore, setActivePane, setSplitRatio } from "../../stores/appStore";
import Sidebar from "./Sidebar.vue";
import Toolbar from "./Toolbar.vue";
import DocumentTabs from "./DocumentTabs.vue";
import ExternalFileNotice from "./ExternalFileNotice.vue";
import StatusBar from "./StatusBar.vue";
import ExportStatusStrip from "./ExportStatusStrip.vue";
import EditorShell from "../editor/EditorShell.vue";
import FindReplacePanel from "../find/FindReplacePanel.vue";
import { closeFindPanel, findReplaceStore } from "../../stores/findReplaceStore";
import type { EditorPaneId } from "../../types";

const sidebarWidth = ref(280);
const gridColumns = computed(() => {
  return appStore.settings.appearance.showSidebar && !appStore.distractionFreeMode
    ? `${sidebarWidth.value}px 4px minmax(0, 1fr)`
    : "minmax(0, 1fr)";
});
const splitColumns = computed(() => `${appStore.splitLayout.ratio}fr 4px ${1 - appStore.splitLayout.ratio}fr`);

watch(
  () => appStore.distractionFreeMode,
  (enabled) => {
    if (enabled && findReplaceStore.open) closeFindPanel();
  },
);

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
  <div class="lm-app-frame flex h-screen flex-col text-ink-900 dark:text-ink-100">
    <Toolbar v-if="!appStore.distractionFreeMode" />
    <div class="grid min-h-0 flex-1" :style="{ gridTemplateColumns: gridColumns }">
      <Sidebar v-if="appStore.settings.appearance.showSidebar && !appStore.distractionFreeMode" />
      <div
        v-if="appStore.settings.appearance.showSidebar && !appStore.distractionFreeMode"
        class="lm-resize-handle cursor-col-resize"
        @pointerdown="startResize"
      />
      <main class="lm-workspace flex min-h-0 min-w-0 flex-col overflow-hidden">
        <ExportStatusStrip v-if="!appStore.distractionFreeMode" />
        <template v-if="!appStore.splitLayout.enabled">
          <DocumentTabs v-if="!appStore.distractionFreeMode" pane-id="main" />
          <ExternalFileNotice v-if="!appStore.distractionFreeMode" />
          <FindReplacePanel v-if="!appStore.distractionFreeMode && findReplaceStore.open" />
          <EditorShell class="min-h-0 flex-1" pane-id="main" />
        </template>
        <div v-else class="grid min-h-0 flex-1" :style="{ gridTemplateColumns: splitColumns }">
          <section class="lm-editor-pane flex min-h-0 min-w-0 flex-col" :class="{ active: isActivePane('main') }" @pointerdown.capture="activatePane('main')">
            <DocumentTabs v-if="!appStore.distractionFreeMode" pane-id="main" />
            <ExternalFileNotice v-if="!appStore.distractionFreeMode && isActivePane('main')" />
            <FindReplacePanel v-if="!appStore.distractionFreeMode && isActivePane('main') && findReplaceStore.open" />
            <EditorShell class="min-h-0 flex-1" pane-id="main" />
          </section>
          <div
            class="lm-resize-handle cursor-col-resize"
            @pointerdown="startSplitResize"
          />
          <section class="lm-editor-pane flex min-h-0 min-w-0 flex-col" :class="{ active: isActivePane('secondary') }" @pointerdown.capture="activatePane('secondary')">
            <DocumentTabs v-if="!appStore.distractionFreeMode" pane-id="secondary" />
            <ExternalFileNotice v-if="!appStore.distractionFreeMode && isActivePane('secondary')" />
            <FindReplacePanel v-if="!appStore.distractionFreeMode && isActivePane('secondary') && findReplaceStore.open" />
            <EditorShell class="min-h-0 flex-1" pane-id="secondary" />
          </section>
        </div>
      </main>
    </div>
    <StatusBar v-if="!appStore.distractionFreeMode" />
    <Transition name="lm-distraction-hint">
      <div v-if="appStore.distractionHintVisible" class="lm-distraction-hint" role="status">
        无干扰模式 · 按 Esc 退出
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.lm-app-frame { background: var(--lm-canvas); }
.lm-workspace { background: var(--lm-surface); box-shadow: -8px 0 28px rgb(65 46 28 / 4%); }
.lm-resize-handle { border-inline: 1px solid var(--lm-border); background: var(--lm-sidebar); transition: background var(--lm-transition); }
.lm-resize-handle:hover { background: var(--lm-accent-soft); }
.lm-editor-pane { position: relative; border-right: 1px solid var(--lm-border); }
.lm-editor-pane.active::after { position: absolute; inset: 0; border: 1px solid color-mix(in srgb, var(--lm-accent) 32%, transparent); pointer-events: none; content: ""; }
.lm-distraction-hint { position: fixed; z-index: 45; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 8px 14px; border: 1px solid var(--lm-border); border-radius: 999px; background: color-mix(in srgb, var(--lm-surface) 92%, transparent); color: var(--lm-muted); box-shadow: var(--lm-shadow); font-size: 12px; pointer-events: none; }
.lm-distraction-hint-enter-active, .lm-distraction-hint-leave-active { transition: opacity 160ms ease, transform 160ms ease; }
.lm-distraction-hint-enter-from, .lm-distraction-hint-leave-to { opacity: 0; transform: translate(-50%, 6px); }
@media (prefers-reduced-motion: reduce) {
  .lm-distraction-hint-enter-active, .lm-distraction-hint-leave-active { transition: none; }
}
</style>
