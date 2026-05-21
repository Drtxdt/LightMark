<script setup lang="ts">
import Sidebar from "./Sidebar.vue";
import Toolbar from "./Toolbar.vue";
import Outline from "./Outline.vue";
import StatusBar from "./StatusBar.vue";
import EditorShell from "../editor/EditorShell.vue";
</script>

<template>
  <div class="flex h-screen flex-col bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
    <Toolbar />
    <div class="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_240px]">
      <Sidebar />
      <main class="min-w-0 overflow-hidden border-x border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <EditorShell />
      </main>
      <Outline />
    </div>
    <StatusBar />
  </div>
</template>
