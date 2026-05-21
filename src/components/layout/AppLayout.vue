<script setup lang="ts">
import { ref } from "vue";
import Sidebar from "./Sidebar.vue";
import Toolbar from "./Toolbar.vue";
import StatusBar from "./StatusBar.vue";
import EditorShell from "../editor/EditorShell.vue";

const sidebarWidth = ref(280);

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
    <div class="grid min-h-0 flex-1" :style="{ gridTemplateColumns: `${sidebarWidth}px 4px minmax(0, 1fr)` }">
      <Sidebar />
      <div
        class="cursor-col-resize border-x border-paper-200 bg-paper-100/70 transition-colors hover:bg-paper-200 dark:border-paper-800 dark:bg-paper-900 dark:hover:bg-paper-800"
        @pointerdown="startResize"
      />
      <main class="min-w-0 overflow-hidden bg-paper-50 dark:bg-paper-950">
        <EditorShell />
      </main>
    </div>
    <StatusBar />
  </div>
</template>
