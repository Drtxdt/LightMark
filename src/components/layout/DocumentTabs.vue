<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
  appStore,
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  createUntitledTab,
  moveTab,
  reopenLastClosedTab,
} from "../../stores/appStore";

const visibleTabs = computed(() => appStore.tabs);
const draggedTabId = ref("");
const menu = reactive({
  open: false,
  tabId: "",
  x: 0,
  y: 0,
});

onMounted(() => {
  window.addEventListener("click", closeMenu);
  window.addEventListener("keydown", closeMenuOnEscape);
});

onBeforeUnmount(() => {
  window.removeEventListener("click", closeMenu);
  window.removeEventListener("keydown", closeMenuOnEscape);
});

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

function onDragStart(event: DragEvent, tabId: string) {
  draggedTabId.value = tabId;
  event.dataTransfer?.setData("text/plain", tabId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

async function onDrop(event: DragEvent, targetTabId: string) {
  event.preventDefault();
  const sourceId = draggedTabId.value || event.dataTransfer?.getData("text/plain") || "";
  draggedTabId.value = "";
  if (!sourceId || sourceId === targetTabId) return;
  const sourceIndex = appStore.tabs.findIndex((tab) => tab.id === sourceId);
  let targetIndex = appStore.tabs.findIndex((tab) => tab.id === targetTabId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  if (sourceIndex < targetIndex) targetIndex -= 1;
  await moveTab(sourceId, targetIndex);
}

function openMenu(event: MouseEvent, tabId: string) {
  event.preventDefault();
  event.stopPropagation();
  menu.open = true;
  menu.tabId = tabId;
  menu.x = event.clientX;
  menu.y = event.clientY;
}

function closeMenu() {
  menu.open = false;
}

function closeMenuOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape") closeMenu();
}

async function runMenuAction(action: () => Promise<unknown> | unknown) {
  closeMenu();
  await action();
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
      draggable="true"
      @click="activateTab(tab.id)"
      @auxclick="onAuxClick($event, tab.id)"
      @contextmenu="openMenu($event, tab.id)"
      @dragstart="onDragStart($event, tab.id)"
      @dragend="draggedTabId = ''"
      @dragover.prevent
      @drop="onDrop($event, tab.id)"
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
    <div
      v-if="menu.open"
      class="tab-menu fixed z-50 min-w-40 overflow-hidden rounded-md border border-paper-200 bg-paper-50 py-1 text-xs text-ink-700 shadow-lg dark:border-paper-800 dark:bg-paper-900 dark:text-ink-100"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      role="menu"
      @click.stop
    >
      <button type="button" class="tab-menu-item" role="menuitem" @click="runMenuAction(() => closeTab(menu.tabId))">关闭</button>
      <button type="button" class="tab-menu-item" role="menuitem" @click="runMenuAction(() => closeOtherTabs(menu.tabId))">关闭其他</button>
      <button type="button" class="tab-menu-item" role="menuitem" @click="runMenuAction(() => closeAllTabs())">关闭全部</button>
      <button
        type="button"
        class="tab-menu-item"
        role="menuitem"
        :disabled="appStore.closedTabs.length === 0"
        @click="runMenuAction(() => reopenLastClosedTab())"
      >
        重新打开最近关闭
      </button>
    </div>
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

.tab-menu-item {
  display: block;
  width: 100%;
  padding: 0.45rem 0.75rem;
  text-align: left;
}

.tab-menu-item:hover:not(:disabled) {
  background: rgb(231 229 225 / 80%);
}

.tab-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

:global(.dark) .tab-menu-item:hover:not(:disabled) {
  background: rgb(41 37 36 / 85%);
}
</style>
