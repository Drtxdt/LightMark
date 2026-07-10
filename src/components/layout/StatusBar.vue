<script setup lang="ts">
import { computed } from "vue";
import { appStore } from "../../stores/appStore";
import { draftStore } from "../../stores/draftStore";
import { getWordStats } from "../../plugins/wordCountPlugin";

const stats = computed(() => (appStore.documentMode === "large" ? null : getWordStats(appStore.currentContent)));
</script>

<template>
  <footer class="lm-statusbar flex h-8 items-center gap-3 px-3 text-xs">
    <span class="status-path max-w-[42vw] truncate" :title="appStore.currentFilePath">{{ appStore.currentFilePath || "未打开文件" }}</span>
    <span class="status-save" :class="{ dirty: appStore.isDirty }"><i></i>{{ appStore.isDirty ? "未保存" : "已保存" }}</span>
    <span v-if="draftStore.message">{{ draftStore.message }}</span>
    <span v-if="stats">{{ stats.words }} 词</span>
    <span v-else>{{ appStore.largeFile?.totalLines ?? 0 }} 行</span>
    <span class="status-mode">{{ appStore.documentMode === "large" ? "大文件" : appStore.editorMode === "wysiwyg" ? "编辑" : "源代码" }}</span>
    <span v-if="appStore.statusMessage" class="status-message ml-auto truncate">{{ appStore.statusMessage }}</span>
  </footer>
</template>

<style scoped>
.lm-statusbar { border-top: 1px solid var(--lm-border); background: var(--lm-surface-soft); color: var(--lm-ink-muted); }
.status-path { color: var(--lm-ink-soft); }
.status-save { display: inline-flex; align-items: center; gap: 6px; }
.status-save i { width: 6px; height: 6px; border-radius: 50%; background: #718060; box-shadow: 0 0 0 3px rgb(113 128 96 / 10%); }
.status-save.dirty i { background: var(--lm-accent); box-shadow: 0 0 0 3px var(--lm-accent-soft); }
.status-mode { border: 1px solid var(--lm-border); border-radius: 999px; padding: 2px 7px; color: var(--lm-ink-soft); }
.status-message { color: var(--lm-ink-soft); }
</style>
