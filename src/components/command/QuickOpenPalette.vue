<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import { appStore, closeQuickOpen, openFile, openFileInOtherPane, quickOpenCandidates } from "../../stores/appStore";
import type { QuickOpenCandidate } from "../../types";

const candidates = computed(() => quickOpenCandidates.value);

watch(
  () => [appStore.quickOpenQuery, candidates.value.length] as const,
  () => {
    appStore.quickOpenActiveIndex = Math.max(0, Math.min(appStore.quickOpenActiveIndex, candidates.value.length - 1));
  },
  { immediate: true },
);

function moveSelection(delta: 1 | -1) {
  if (candidates.value.length === 0) return;
  const next = appStore.quickOpenActiveIndex + delta;
  appStore.quickOpenActiveIndex = (next + candidates.value.length) % candidates.value.length;
}

async function openSelected() {
  const candidate = candidates.value[appStore.quickOpenActiveIndex];
  if (!candidate) return;
  await selectCandidate(candidate);
}

async function openSelectedInOtherPane() {
  const candidate = candidates.value[appStore.quickOpenActiveIndex];
  if (!candidate) return;
  await selectCandidate(candidate, true);
}

async function handleEnter(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey) {
    await openSelectedInOtherPane();
    return;
  }
  await openSelected();
}

async function selectCandidate(candidate: QuickOpenCandidate, otherPane = false) {
  try {
    if (otherPane) {
      await openFileInOtherPane(candidate.path);
    } else {
      await openFile(candidate.path);
    }
    closeQuickOpen();
    await nextTick();
  } catch (error) {
    appStore.statusMessage = String(error);
  }
}

function sourceLabel(candidate: QuickOpenCandidate) {
  return candidate.source === "workspace" ? "工作区" : "最近";
}
</script>

<template>
  <div class="lm-modal-backdrop fixed inset-0 z-50 p-20" @click.self="closeQuickOpen">
    <div class="lm-palette-panel mx-auto max-w-2xl overflow-hidden">
      <input
        v-model="appStore.quickOpenQuery"
        autofocus
        class="w-full border-b border-paper-200 bg-transparent px-4 py-3 text-base text-ink-900 outline-none placeholder:text-ink-500 dark:border-paper-800 dark:text-ink-100 dark:placeholder:text-ink-300"
        placeholder="快速打开文件"
        @keydown.esc="closeQuickOpen"
        @keydown.down.prevent="moveSelection(1)"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.enter.prevent="handleEnter"
      />
      <div class="max-h-96 overflow-auto p-2">
        <button
          v-for="(candidate, index) in candidates"
          :key="candidate.path"
          class="block w-full rounded px-3 py-2 text-left text-sm transition-colors"
          :class="index === appStore.quickOpenActiveIndex
            ? 'bg-paper-200 text-ink-900 dark:bg-paper-800 dark:text-ink-100'
            : 'text-ink-700 hover:bg-paper-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100'"
          @mouseenter="appStore.quickOpenActiveIndex = index"
          @click="selectCandidate(candidate)"
        >
          <span class="flex items-center justify-between gap-3">
            <span class="min-w-0">
              <span class="block truncate font-medium">{{ candidate.name }}</span>
              <span class="block truncate text-xs text-ink-500 dark:text-ink-400">{{ candidate.path }}</span>
            </span>
            <span class="shrink-0 rounded border border-paper-200 px-1.5 py-0.5 text-[11px] text-ink-500 dark:border-paper-700 dark:text-ink-400">
              {{ sourceLabel(candidate) }}
            </span>
          </span>
        </button>
        <p v-if="candidates.length === 0" class="px-3 py-6 text-center text-sm text-ink-500 dark:text-ink-400">
          没有匹配的 Markdown 文件
        </p>
      </div>
    </div>
  </div>
</template>
