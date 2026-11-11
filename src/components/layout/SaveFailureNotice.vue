<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { activateTab, appStore, saveCurrentFile, saveCurrentFileAsExternalCopy } from '../../stores/appStore';

const failures = ref(new Map<string, string>());
watch(() => [appStore.activeTabId, appStore.saveState] as const, ([id, state]) => {
  if (!id) return;
  if (state === 'failed' && !failures.value.has(id)) failures.value.set(id, appStore.statusMessage || '保存失败，当前修改仍在编辑器中。');
  else if (state === 'saved') failures.value.delete(id);
}, { immediate: true });
watch(() => appStore.tabs.map(tab => tab.id), ids => {
  for (const id of failures.value.keys()) if (!ids.includes(id)) failures.value.delete(id);
});
function recordFailure(event: Event) {
  const detail = (event as CustomEvent<{ tabId: string; message?: string }>).detail;
  if (detail?.tabId) failures.value.set(detail.tabId, detail.message || '保存失败，当前修改仍在编辑器中。');
}
function recordSuccess(event: Event) {
  const detail = (event as CustomEvent<{ tabId: string }>).detail;
  if (detail?.tabId) failures.value.delete(detail.tabId);
}
onMounted(() => { window.addEventListener('lightmark:save-failure', recordFailure); window.addEventListener('lightmark:save-success', recordSuccess); });
onBeforeUnmount(() => { window.removeEventListener('lightmark:save-failure', recordFailure); window.removeEventListener('lightmark:save-success', recordSuccess); });
const failureTabId = computed(() => failures.value.has(appStore.activeTabId) ? appStore.activeTabId : failures.value.keys().next().value);
const failure = computed(() => failureTabId.value ? failures.value.get(failureTabId.value) : undefined);
const failureTab = computed(() => appStore.tabs.find(tab => tab.id === failureTabId.value));
const isCurrentFailure = computed(() => failureTabId.value === appStore.activeTabId);

async function retry(copy = false) {
  if (!isCurrentFailure.value) return;
  try { await (copy ? saveCurrentFileAsExternalCopy() : saveCurrentFile()); }
  catch (error) { appStore.statusMessage = String(error); }
}
async function showFailureDocument() {
  if (failureTabId.value) await activateTab(failureTabId.value);
}
</script>

<template>
  <aside v-if="failure" class="save-failure-notice" role="alert" aria-live="assertive">
    <span class="save-failure-text">{{ failureTab?.name }}：{{ failure }}</span>
    <button v-if="!isCurrentFailure" type="button" @click="showFailureDocument">查看文档</button>
    <button v-if="isCurrentFailure" type="button" @click="retry()">重试保存</button>
    <button v-if="isCurrentFailure && appStore.documentMode === 'normal'" type="button" @click="retry(true)">保存副本</button>
  </aside>
</template>

<style scoped>
.save-failure-notice { display: flex; flex: 0 0 auto; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--lm-error); background: var(--lm-error-soft); color: var(--lm-ink); font-size: 13px; }
.save-failure-text { flex: 1 1 260px; overflow-wrap: anywhere; }
button { flex: 0 0 auto; padding: 4px 9px; border: 1px solid var(--lm-border-strong); border-radius: var(--lm-radius-sm); background: var(--lm-surface); color: var(--lm-ink); }
button:focus-visible { outline: 2px solid var(--lm-accent); outline-offset: 2px; }
</style>
