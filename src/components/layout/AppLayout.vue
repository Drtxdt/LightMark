<script setup lang="ts">
import { computed, ref } from "vue";
import { appStore } from "../../stores/appStore";
import Sidebar from "./Sidebar.vue";
import Toolbar from "./Toolbar.vue";
import StatusBar from "./StatusBar.vue";
import ExportStatusStrip from "./ExportStatusStrip.vue";
import EditorShell from "../editor/EditorShell.vue";
import FindReplacePanel from "../find/FindReplacePanel.vue";
import { findReplaceStore } from "../../stores/findReplaceStore";

const sidebarWidth = ref(280);
const gridColumns = computed(() => {
  return appStore.settings.appearance.showSidebar ? `${sidebarWidth.value}px 4px minmax(0, 1fr)` : "minmax(0, 1fr)";
});

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
</script>

<template>
  <div class="flex h-screen flex-col bg-paper-50 text-ink-900 dark:bg-paper-950 dark:text-ink-100">
    <Toolbar />
    <ExportStatusStrip />
    <FindReplacePanel v-if="findReplaceStore.open" />
    <div class="grid min-h-0 flex-1" :style="{ gridTemplateColumns: gridColumns }">
      <Sidebar v-if="appStore.settings.appearance.showSidebar" />
      <div
        v-if="appStore.settings.appearance.showSidebar"
        class="cursor-col-resize border-x border-paper-200 bg-paper-100/70 transition-colors hover:bg-paper-200 dark:border-paper-800 dark:bg-paper-900 dark:hover:bg-paper-800"
        @pointerdown="startResize"
      />
      <main class="min-h-0 min-w-0 overflow-hidden bg-paper-50 dark:bg-paper-950">
        <EditorShell />
      </main>
    </div>
    <StatusBar />
  </div>
</template>
