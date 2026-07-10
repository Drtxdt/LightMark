<script setup lang="ts">
import { ref } from "vue";
import type { FileNode } from "../../types";
import { appStore } from "../../stores/appStore";
import UiIcon from "../ui/UiIcon.vue";

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
      class="file-node flex items-center gap-1.5"
      :class="{ 'file-node-active': node.path === appStore.currentFilePath, 'font-medium': node.isDir }"
      @click="node.isDir ? (open = !open) : emit('select', node.path)"
    >
      <UiIcon v-if="node.isDir" :name="open ? 'chevron-down' : 'chevron-right'" :size="14" :stroke-width="2" />
      <span v-else class="tree-indent" aria-hidden="true"></span>
      <UiIcon :name="node.isDir ? (open ? 'folder-open' : 'folder') : 'file-text'" :size="15" />
      <span class="min-w-0 flex-1 truncate">{{ node.name }}</span>
      <span v-if="node.path === appStore.currentFilePath && appStore.isDirty" class="tree-dirty" aria-label="未保存"></span>
    </button>
    <div v-if="node.isDir && open" class="tree-children ml-3 pl-2">
      <FileTreeNode v-for="child in node.children" :key="child.path" :node="child" @select="emit('select', $event)" />
    </div>
  </div>
</template>

<style scoped>
.tree-indent { width: 14px; flex: 0 0 14px; }
.tree-children { border-left: 1px solid var(--lm-border); }
.tree-dirty { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--lm-accent); box-shadow: 0 0 0 3px var(--lm-accent-soft); }
</style>
