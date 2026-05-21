<script setup lang="ts">
import { appStore, openFile, openWorkspace } from "../../stores/appStore";
import FileTreeNode from "./FileTreeNode.vue";

async function selectFile(path: string) {
  await openFile(path);
}
</script>

<template>
  <aside class="min-w-0 overflow-auto bg-slate-100/80 p-3 dark:bg-zinc-900">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">Workspace</h2>
      <button class="btn-small" @click="openWorkspace()">Open</button>
    </div>
    <p v-if="!appStore.currentWorkspace" class="text-sm text-slate-500 dark:text-zinc-400">No folder opened.</p>
    <p v-else class="mb-3 truncate text-xs text-slate-500 dark:text-zinc-400">{{ appStore.currentWorkspace }}</p>
    <FileTreeNode v-for="node in appStore.fileTree" :key="node.path" :node="node" @select="selectFile" />
  </aside>
</template>
