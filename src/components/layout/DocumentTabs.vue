<script setup lang="ts">
import { computed } from "vue";
import { appStore, activateTab, closeTab, createUntitledTab } from "../../stores/appStore";

const visibleTabs = computed(() => appStore.tabs);

function tabTitle(path: string) {
  return path || "未命名文档";
}

function externalTitle(state: string) {
  if (state === "deleted") return "文件已被外部删除";
  if (state === "modified") return "文件已被外部修改";
  return "";
}

async function onClose(event: MouseEvent, tabId: string) {
  event.stopPropagation();
  await closeTab(tabId);
}

async function onAuxClick(event: MouseEvent, tabId: string) {
  if (event.button !== 1) return;
  event.preventDefault();
  await closeTab(tabId);
}

function createTab() {
  createUntitledTab("", false);
}
</script>

<template>
  <nav
    class="document-tabs flex h-9 flex-none items-end gap-1 overflow-x-auto border-b border-paper-200 bg-paper-100/75 px-2 pt-1 dark:border-paper-800 dark:bg-paper-900/85"
    aria-label="打开的文档"
  >
    <button
      v-for="tab in visibleTabs"
      :key="tab.id"
      class="document-tab group flex h-8 max-w-56 min-w-28 items-center gap-2 rounded-t-md border px-3 text-left text-xs transition-colors"
      :class="
        tab.id === appStore.activeTabId
          ? 'border-paper-200 border-b-paper-50 bg-paper-50 text-ink-900 shadow-sm dark:border-paper-800 dark:border-b-paper-950 dark:bg-paper-950 dark:text-ink-100'
          : 'border-transparent bg-transparent text-ink-500 hover:bg-paper-200/70 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100'
      "
      :title="tabTitle(tab.path)"
      @click="activateTab(tab.id)"
      @auxclick="onAuxClick($event, tab.id)"
    >
      <span
        v-if="tab.externalState !== 'clean'"
        class="h-1.5 w-1.5 flex-none rounded-full"
        :class="tab.externalState === 'deleted' ? 'bg-red-500' : 'bg-sky-500'"
        :aria-label="externalTitle(tab.externalState)"
        :title="externalTitle(tab.externalState)"
      />
      <span v-else-if="tab.isDirty" class="h-1.5 w-1.5 flex-none rounded-full bg-amber-500" aria-label="未保存" />
      <span v-else class="h-1.5 w-1.5 flex-none rounded-full bg-transparent" />
      <span class="min-w-0 flex-1 truncate">{{ tab.name }}</span>
      <span v-if="tab.documentMode === 'large'" class="rounded bg-paper-200 px-1 py-0.5 text-[10px] text-ink-500 dark:bg-paper-800 dark:text-ink-300">
        大
      </span>
      <span
        class="tab-close -mr-1 grid h-5 w-5 flex-none place-items-center rounded text-ink-400 opacity-60 transition hover:bg-paper-200 hover:text-ink-900 group-hover:opacity-100 dark:text-ink-400 dark:hover:bg-paper-800 dark:hover:text-ink-100"
        role="button"
        aria-label="关闭标签页"
        tabindex="-1"
        @click="onClose($event, tab.id)"
      >
        ×
      </span>
    </button>
    <button
      class="new-tab-button mb-0 grid h-8 w-9 flex-none place-items-center rounded-t-md border border-transparent text-base leading-none text-ink-500 transition hover:bg-paper-200/70 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-300/40 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100"
      title="新建未命名标签页"
      aria-label="新建未命名标签页"
      @click="createTab"
    >
      +
    </button>
  </nav>
</template>

<style scoped>
.document-tabs {
  scrollbar-width: thin;
}

.document-tab {
  outline: none;
}

.document-tab:focus-visible {
  box-shadow: 0 0 0 2px rgb(134 128 116 / 28%);
}

.tab-close {
  line-height: 1;
}

.new-tab-button {
  font-weight: 500;
}
</style>
