<script setup lang="ts">
import { computed } from "vue";
import { appStore, getPaneTab, recordNavigationLocation } from "../../stores/appStore";
import { draftStore } from "../../stores/draftStore";
import { getWordStats } from "../../plugins/wordCountPlugin";
import { extractOutlineWithLines, resolveHeadingBreadcrumb, type BreadcrumbItem } from "../../utils/outline";
import UiIcon from "../ui/UiIcon.vue";

const stats = computed(() => (appStore.documentMode === "large" ? null : getWordStats(appStore.currentContent)));
const activePaneId = computed(() => appStore.splitLayout.activePaneId);
const activeTab = computed(() => getPaneTab(activePaneId.value));
const outline = computed(() => {
  if (activeTab.value?.documentMode === "large") return activeTab.value.largeFile?.outline ?? [];
  return extractOutlineWithLines(activeTab.value?.content ?? appStore.currentContent);
});
const contextLine = computed(() => {
  if (activeTab.value?.documentMode === "large") return appStore.largeFileViewportLines[activePaneId.value] ?? 0;
  return appStore.paneContextLines[activePaneId.value] ?? Math.max(0, (activeTab.value?.position?.markdownLine ?? 1) - 1);
});
const breadcrumbs = computed(() => resolveHeadingBreadcrumb(outline.value, contextLine.value));
const breadcrumbTitle = computed(() => {
  const sections = breadcrumbs.value.map((item) => item.text).join(" › ");
  return sections ? `${appStore.currentFilePath || "未打开文件"} · ${sections}` : appStore.currentFilePath || "未打开文件";
});

function jumpToBreadcrumb(item: BreadcrumbItem) {
  recordNavigationLocation();
  if (activeTab.value?.documentMode === "large") {
    window.dispatchEvent(
      new CustomEvent("lightmark:jump-line", {
        detail: { line: item.line, paneId: activePaneId.value },
      }),
    );
    return;
  }
  window.dispatchEvent(new CustomEvent("lightmark:jump-heading", { detail: item }));
}
</script>

<template>
  <footer class="lm-statusbar flex h-8 items-center px-3 text-xs">
    <div class="status-left min-w-0" :title="breadcrumbTitle">
      <nav v-if="breadcrumbs.length" class="status-breadcrumbs" aria-label="当前章节路径">
        <span
          v-for="(item, index) in breadcrumbs"
          :key="`${item.id}-${item.line}`"
          class="breadcrumb-segment"
          :class="{ ancestor: index < breadcrumbs.length - 1, current: index === breadcrumbs.length - 1 }"
        >
          <UiIcon v-if="index > 0" class="breadcrumb-separator" name="chevron-right" :size="12" :stroke-width="1.6" />
          <button
            class="breadcrumb-button"
            :aria-label="`跳转到章节：${item.text}`"
            :title="item.text"
            @click="jumpToBreadcrumb(item)"
          >
            {{ item.text }}
          </button>
        </span>
      </nav>
      <span v-else class="status-path block truncate">{{ appStore.currentFilePath || "未打开文件" }}</span>
    </div>
    <span v-if="appStore.statusMessage" class="status-message min-w-0 flex-1 truncate text-center">{{ appStore.statusMessage }}</span>
    <div class="status-meta ml-auto flex items-center gap-3">
      <span v-if="draftStore.message" class="status-draft">{{ draftStore.message }}</span>
      <span v-if="appStore.settings.editor.showWordCount && stats" class="status-count">{{ stats.words }} 词</span>
      <span v-else-if="appStore.settings.editor.showWordCount" class="status-count">{{ appStore.largeFile?.totalLines ?? 0 }} 行</span>
      <span class="status-mode">{{ appStore.documentMode === "large" ? "大文件" : appStore.editorMode === "wysiwyg" ? "编辑" : "源代码" }}</span>
      <span class="status-save" :class="{ dirty: appStore.isDirty }"><i></i>{{ appStore.isDirty ? "未保存" : "已保存" }}</span>
    </div>
  </footer>
</template>

<style scoped>
.lm-statusbar { border-top: 1px solid var(--lm-border); background: var(--lm-surface-soft); color: var(--lm-ink-muted); }
.status-left { width: min(38vw, 520px); min-width: 80px; flex: 0 1 520px; }
.status-path { color: var(--lm-ink-soft); }
.status-breadcrumbs { display: flex; min-width: 0; align-items: center; overflow: hidden; white-space: nowrap; }
.breadcrumb-segment { display: inline-flex; min-width: 0; align-items: center; }
.breadcrumb-segment.current { flex: 1 1 auto; }
.breadcrumb-separator { flex: 0 0 auto; margin: 0 2px; color: var(--lm-ink-muted); }
.breadcrumb-button {
  min-width: 0;
  overflow: hidden;
  border: 0;
  border-radius: 4px;
  background: transparent;
  padding: 2px 3px;
  color: var(--lm-ink-muted);
  font: inherit;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.breadcrumb-segment.current .breadcrumb-button { color: var(--lm-ink-soft); font-weight: 600; }
.breadcrumb-button:hover { background: var(--lm-accent-soft); color: var(--lm-ink); }
.breadcrumb-button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--lm-focus); color: var(--lm-ink); }
.status-save { display: inline-flex; align-items: center; gap: 6px; }
.status-save i { width: 6px; height: 6px; border-radius: 50%; background: #718060; box-shadow: 0 0 0 3px rgb(113 128 96 / 10%); }
.status-save.dirty i { background: var(--lm-accent); box-shadow: 0 0 0 3px var(--lm-accent-soft); }
.status-mode { color: var(--lm-ink-soft); }
.status-message { color: var(--lm-ink-soft); }

@media (max-width: 860px) {
  .status-left { width: min(32vw, 280px); }
  .breadcrumb-segment.ancestor { display: none; }
  .breadcrumb-segment.current .breadcrumb-separator { display: none; }
  .status-draft { display: none; }
}

@media (max-width: 640px) {
  .status-left { width: min(34vw, 180px); }
  .status-message { text-align: left; }
  .status-count { display: none; }
}
</style>
