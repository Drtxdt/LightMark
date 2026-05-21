<script setup lang="ts">
import { appStore, openFile, openWorkspace } from "../../stores/appStore";
import FileTreeNode from "./FileTreeNode.vue";

async function selectFile(path: string) {
  await openFile(path);
}
</script>

<template>
  <aside class="min-w-0 overflow-auto bg-paper-100/60 p-3 dark:bg-paper-900">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 class="text-xs font-medium uppercase tracking-wide text-ink-500 dark:text-ink-300">Workspace</h2>
      <button class="btn-small" @click="openWorkspace()">Open</button>
    </div>
    <p v-if="!appStore.currentWorkspace" class="text-sm text-ink-500 dark:text-ink-300">No folder opened.</p>
    <p v-else class="mb-3 truncate text-xs text-ink-500 dark:text-ink-300">{{ appStore.currentWorkspace }}</p>
    <FileTreeNode v-for="node in appStore.fileTree" :key="node.path" :node="node" @select="selectFile" />
  </aside>
</template>
