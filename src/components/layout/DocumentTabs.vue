<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
  appStore,
  activateTabInOtherPane,
  activateTabInPane,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  createUntitledTab,
  moveTab,
  reopenLastClosedTab,
  setActivePane,
} from "../../stores/appStore";
import type { DocumentTab, EditorPaneId } from "../../types";
import { paneTabId, paneTabIds } from "../../utils/splitLayout";
import UiIcon from "../ui/UiIcon.vue";

const props = withDefaults(defineProps<{ paneId?: EditorPaneId }>(), {
  paneId: "main",
});
const visibleTabs = computed(() => {
  if (!appStore.splitLayout.enabled) return appStore.tabs;
  const ids = paneTabIds(appStore.splitLayout, props.paneId);
  return ids.map((id) => appStore.tabs.find((tab) => tab.id === id)).filter((tab): tab is DocumentTab => Boolean(tab));
});
const activePaneTabId = computed(() => paneTabId(appStore.splitLayout, props.paneId) || appStore.activeTabId);
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

async function activatePaneTab(tabId: string) {
  await activateTabInPane(props.paneId, tabId);
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

async function createTab() {
  await setActivePane(props.paneId);
  createUntitledTab("", false, props.paneId);
}
</script>

<template>
  <nav
    class="document-tabs flex h-10 flex-none items-end gap-1 overflow-x-auto px-3 pt-1.5"
    aria-label="打开的文档"
  >
    <button
      v-for="tab in visibleTabs"
      :key="tab.id"
      class="document-tab group flex h-[34px] max-w-56 min-w-28 items-center gap-2 border px-3 text-left text-xs"
      :class="
        tab.id === activePaneTabId
          ? 'active'
          : ''
      "
      :title="tabTitle(tab.path)"
      draggable="true"
      @click="activatePaneTab(tab.id)"
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
        <UiIcon name="x" :size="14" />
      </span>
    </button>
    <div
      v-if="menu.open"
      class="tab-menu fixed z-50 min-w-40 overflow-hidden py-1 text-xs"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      role="menu"
      @click.stop
    >
      <button type="button" class="tab-menu-item" role="menuitem" @click="runMenuAction(() => closeTab(menu.tabId))">关闭</button>
      <button type="button" class="tab-menu-item" role="menuitem" @click="runMenuAction(() => activateTabInOtherPane(menu.tabId))">在另一栏打开</button>
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
      class="new-tab-button mb-0 grid h-[34px] w-9 flex-none place-items-center border border-transparent text-base leading-none"
      title="新建未命名标签页"
      aria-label="新建未命名标签页"
      @click="createTab"
    >
      <UiIcon name="plus" :size="17" />
    </button>
  </nav>
</template>

<style scoped>
.document-tabs {
  scrollbar-width: thin;
  border-bottom: 1px solid var(--lm-border);
  background: var(--lm-surface-soft);
}

.document-tab {
  border-color: transparent;
  border-radius: 9px 9px 0 0;
  background: transparent;
  color: var(--lm-ink-muted);
  outline: none;
  transition: background var(--lm-transition), color var(--lm-transition), border-color var(--lm-transition);
}

.document-tab:hover { background: color-mix(in srgb, var(--lm-surface-raised) 55%, transparent); color: var(--lm-ink); }
.document-tab.active {
  border-color: var(--lm-border);
  border-bottom-color: var(--lm-surface);
  background: var(--lm-surface);
  color: var(--lm-ink);
  box-shadow: 0 -2px 10px rgb(72 51 29 / 3%);
}

.document-tab:focus-visible {
  box-shadow: 0 0 0 2px rgb(134 128 116 / 28%);
}

.tab-close {
  line-height: 1;
  opacity: 0;
}

.document-tab:hover .tab-close,
.document-tab.active .tab-close,
.document-tab:focus-visible .tab-close { opacity: 0.72; }

.new-tab-button {
  border-radius: 9px 9px 0 0;
  color: var(--lm-ink-muted);
  transition: all var(--lm-transition);
}
.new-tab-button:hover { background: var(--lm-accent-soft); color: var(--lm-accent); }
.new-tab-button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--lm-focus); }

.tab-menu { border: 1px solid var(--lm-border-strong); border-radius: var(--lm-radius-md); background: var(--lm-surface-raised); color: var(--lm-ink); box-shadow: var(--lm-shadow-md); }

.tab-menu-item {
  display: block;
  width: 100%;
  padding: 0.45rem 0.75rem;
  text-align: left;
}

.tab-menu-item:hover:not(:disabled) {
  background: var(--lm-accent-soft);
}

.tab-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

:global(.dark) .tab-menu-item:hover:not(:disabled) {
  background: var(--lm-accent-soft);
}
</style>
