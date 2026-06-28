<script setup lang="ts">
import { computed } from "vue";
import {
  appStore,
  closeTab,
  dismissCurrentExternalFileState,
  reloadCurrentFileFromDisk,
  saveCurrentFileAsExternalCopy,
} from "../../stores/appStore";

const activeTab = computed(() => appStore.tabs.find((tab) => tab.id === appStore.activeTabId) ?? null);
const visible = computed(() => Boolean(activeTab.value && activeTab.value.externalState !== "clean"));
const isDeleted = computed(() => activeTab.value?.externalState === "deleted");
const message = computed(() => {
  if (!activeTab.value) return "";
  if (activeTab.value.externalState === "deleted") {
    return "当前文件已被外部删除。";
  }
  return activeTab.value.isDirty ? "当前文件已被外部修改，且本地有未保存内容。" : "当前文件已被外部修改。";
});

async function reloadFromDisk() {
  await reloadCurrentFileFromDisk().catch((error) => (appStore.statusMessage = String(error)));
}

async function saveAsCopy() {
  const saved = await saveCurrentFileAsExternalCopy().catch((error) => {
    appStore.statusMessage = String(error);
    return false;
  });
  if (saved) appStore.statusMessage = "已另存为副本";
}

async function saveDeletedAs() {
  const saved = await saveCurrentFileAsExternalCopy().catch((error) => {
    appStore.statusMessage = String(error);
    return false;
  });
  if (saved) appStore.statusMessage = "已另存为";
}

async function closeDeletedTab() {
  const tab = activeTab.value;
  if (!tab) return;
  await closeTab(tab.id);
}
</script>

<template>
  <section v-if="visible" class="external-file-notice" :class="{ danger: isDeleted }" role="status" aria-live="polite">
    <div class="min-w-0 flex-1">
      <div class="truncate font-medium">{{ message }}</div>
      <div class="truncate text-[11px] opacity-80">{{ activeTab?.path }}</div>
    </div>
    <div class="flex flex-none items-center gap-2">
      <template v-if="isDeleted">
        <button type="button" class="notice-button primary" @click="saveDeletedAs">另存为</button>
        <button type="button" class="notice-button" @click="closeDeletedTab">关闭标签</button>
      </template>
      <template v-else>
        <button type="button" class="notice-button primary" @click="reloadFromDisk">重载磁盘版本</button>
        <button type="button" class="notice-button" @click="saveAsCopy">另存为副本</button>
      </template>
      <button type="button" class="notice-button subtle" @click="dismissCurrentExternalFileState">稍后处理</button>
    </div>
  </section>
</template>

<style scoped>
.external-file-notice {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border-bottom: 1px solid rgb(217 194 141 / 55%);
  background: rgb(255 248 229);
  color: rgb(92 63 12);
  padding: 0.5rem 0.75rem;
  font-size: 0.75rem;
}

.external-file-notice.danger {
  border-bottom-color: rgb(244 156 156 / 60%);
  background: rgb(255 239 239);
  color: rgb(127 29 29);
}

.notice-button {
  height: 1.75rem;
  border-radius: 0.375rem;
  border: 1px solid rgb(120 113 108 / 25%);
  background: rgb(255 255 255 / 62%);
  padding: 0 0.625rem;
  font-size: 0.75rem;
  white-space: nowrap;
}

.notice-button.primary {
  border-color: rgb(68 64 60 / 30%);
  background: rgb(68 64 60);
  color: white;
}

.notice-button.subtle {
  border-color: transparent;
  background: transparent;
}

:global(.dark) .external-file-notice {
  border-bottom-color: rgb(168 131 50 / 45%);
  background: rgb(49 39 18);
  color: rgb(252 211 77);
}

:global(.dark) .external-file-notice.danger {
  border-bottom-color: rgb(153 27 27 / 55%);
  background: rgb(55 23 23);
  color: rgb(252 165 165);
}

:global(.dark) .notice-button {
  border-color: rgb(214 211 209 / 18%);
  background: rgb(255 255 255 / 8%);
}

:global(.dark) .notice-button.primary {
  border-color: rgb(250 250 249 / 28%);
  background: rgb(250 250 249);
  color: rgb(28 25 23);
}
</style>
