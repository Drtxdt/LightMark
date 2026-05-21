<script setup lang="ts">
import { computed } from "vue";
import { appStore } from "../../stores/appStore";
import { getWordStats } from "../../plugins/wordCountPlugin";

const stats = computed(() => getWordStats(appStore.currentContent));
</script>

<template>
  <footer class="flex h-7 items-center gap-4 border-t border-slate-200 bg-slate-100 px-3 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
    <span class="max-w-[45vw] truncate">{{ appStore.currentFilePath || "No file" }}</span>
    <span>{{ appStore.isDirty ? "Unsaved" : "Saved" }}</span>
    <span>{{ stats.words }} words</span>
    <span>{{ appStore.editorMode }}</span>
    <span v-if="appStore.statusMessage" class="ml-auto truncate text-red-600 dark:text-red-400">{{ appStore.statusMessage }}</span>
  </footer>
</template>
