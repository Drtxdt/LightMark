<script setup lang="ts">
import { computed } from "vue";
import { appStore } from "../../stores/appStore";
import { getWordStats } from "../../plugins/wordCountPlugin";

const stats = computed(() => (appStore.documentMode === "large" ? null : getWordStats(appStore.currentContent)));
</script>

<template>
  <footer class="flex h-7 items-center gap-4 border-t border-paper-200 bg-paper-100 px-3 text-xs text-ink-500 dark:border-paper-800 dark:bg-paper-900 dark:text-ink-300">
    <span class="max-w-[45vw] truncate">{{ appStore.currentFilePath || "未打开文件" }}</span>
    <span>{{ appStore.isDirty ? "未保存" : "已保存" }}</span>
    <span v-if="stats">{{ stats.words }} 词</span>
    <span v-else>{{ appStore.largeFile?.totalLines ?? 0 }} 行</span>
    <span>{{ appStore.documentMode === "large" ? "大文件" : appStore.editorMode === "wysiwyg" ? "编辑" : "源代码" }}</span>
    <span v-if="appStore.statusMessage" class="ml-auto truncate text-stone-700 dark:text-stone-300">{{ appStore.statusMessage }}</span>
  </footer>
</template>
