<script setup lang="ts">
import { ref } from "vue";
import type { FileNode } from "../../types";
import { appStore } from "../../stores/appStore";

defineProps<{
  node: FileNode;
}>();

const emit = defineEmits<{
  select: [path: string];
}>();

const open = ref(true);
</script>

<template>
  <div class="select-none">
    <button
      class="file-node"
      :class="{ 'file-node-active': node.path === appStore.currentFilePath, 'font-medium': node.isDir }"
      @click="node.isDir ? (open = !open) : emit('select', node.path)"
    >
      {{ node.isDir ? (open ? "▾" : "▸") : "•" }} {{ node.name }}<span v-if="node.path === appStore.currentFilePath && appStore.isDirty"> *</span>
    </button>
    <div v-if="node.isDir && open" class="ml-3 border-l border-slate-200 pl-2 dark:border-zinc-800">
      <FileTreeNode v-for="child in node.children" :key="child.path" :node="child" @select="emit('select', $event)" />
    </div>
  </div>
</template>
