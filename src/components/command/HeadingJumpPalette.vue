<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  appStore,
  closeHeadingJump,
  getPaneStructuredOutline,
  getPaneTab,
  recordNavigationLocation,
  revealHeadingAtLine,
} from "../../stores/appStore";
import type { StructuredOutlineItem } from "../../utils/outline";
import { useOverlayFocus } from "../../composables/useOverlayFocus";

type HeadingCandidate = {
  item: StructuredOutlineItem;
  score: number;
};
const backdrop = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
useOverlayFocus({ backdrop, panel, initialFocus: input, close: closeHeadingJump });

const activePaneId = computed(() => appStore.splitLayout.activePaneId);
const outline = computed(() => getPaneStructuredOutline(activePaneId.value));

const candidates = computed(() => {
  const query = normalizeHeadingQuery(appStore.headingJumpQuery);
  const source = outline.value.map((item, index) => ({
    item,
    score: query ? scoreHeading(item, query) : index,
  }));
  return source
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => left.score - right.score || left.item.text.localeCompare(right.item.text, "zh-Hans-CN"));
});

watch(
  () => [appStore.headingJumpQuery, candidates.value.length] as const,
  () => {
    appStore.headingJumpActiveIndex = Math.max(
      0,
      Math.min(appStore.headingJumpActiveIndex, candidates.value.length - 1),
    );
  },
  { immediate: true },
);

function moveSelection(delta: 1 | -1) {
  if (candidates.value.length === 0) return;
  const next = appStore.headingJumpActiveIndex + delta;
  appStore.headingJumpActiveIndex = (next + candidates.value.length) % candidates.value.length;
}

async function jumpSelected() {
  const candidate = candidates.value[appStore.headingJumpActiveIndex];
  if (!candidate) return;
  await jumpToHeading(candidate);
}

async function jumpToHeading(candidate: HeadingCandidate) {
  recordNavigationLocation();
  const item = candidate.item;
  closeHeadingJump();
  const paneId = activePaneId.value;
  if (getPaneTab(paneId)?.documentMode === "large") {
    window.dispatchEvent(new CustomEvent("lightmark:jump-line", { detail: { line: item.line, paneId } }));
    return;
  }
  revealHeadingAtLine(paneId, item.line);
  await nextTick();
  window.dispatchEvent(new CustomEvent("lightmark:jump-heading", {
    detail: { id: item.id, text: item.text, line: item.line, paneId },
  }));
}

function scoreHeading(item: StructuredOutlineItem, query: string) {
  const text = normalizeHeadingQuery(item.text);
  const exact = text.indexOf(query);
  if (exact >= 0) return exact + item.level / 10;
  return subsequenceScore(text, query) + item.level / 10;
}

function subsequenceScore(value: string, query: string) {
  let valueIndex = 0;
  let score = 0;
  for (const char of query) {
    const match = value.indexOf(char, valueIndex);
    if (match < 0) return Number.POSITIVE_INFINITY;
    score += match;
    valueIndex = match + 1;
  }
  return score + value.length / 1000;
}

function normalizeHeadingText(value: string) {
  return value.replace(/[#*_`[\]()]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeHeadingQuery(value: string) {
  return normalizeHeadingText(value).toLocaleLowerCase();
}

function lineLabel(item: StructuredOutlineItem) {
  return `L${item.line + 1}`;
}
</script>

<template>
  <div ref="backdrop" class="lm-modal-backdrop fixed inset-0 z-50 p-20" @click.self="closeHeadingJump">
    <div ref="panel" tabindex="-1" class="lm-palette-panel mx-auto max-w-xl overflow-hidden" role="dialog" aria-modal="true" aria-label="前往指定标题">
      <input
        ref="input"
        v-model="appStore.headingJumpQuery"
        class="w-full border-b border-paper-200 bg-transparent px-4 py-3 text-base text-ink-900 outline-none placeholder:text-ink-500 dark:border-paper-800 dark:text-ink-100 dark:placeholder:text-ink-300"
        placeholder="前往指定标题"
        @keydown.down.prevent="moveSelection(1)"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.enter.prevent="jumpSelected"
      />
      <div class="max-h-96 overflow-auto p-2">
        <button
          v-for="(candidate, index) in candidates"
          :key="candidate.item.id"
          class="block w-full rounded px-3 py-2 text-left text-sm transition-colors"
          :class="index === appStore.headingJumpActiveIndex
            ? 'bg-paper-200 text-ink-900 dark:bg-paper-800 dark:text-ink-100'
            : 'text-ink-700 hover:bg-paper-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100'"
          @mouseenter="appStore.headingJumpActiveIndex = index"
          @click="jumpToHeading(candidate)"
        >
          <span class="flex items-center justify-between gap-3">
            <span class="min-w-0 truncate" :style="{ paddingLeft: `${Math.max(0, candidate.item.level - 1) * 0.75}rem` }">
              {{ candidate.item.text }}
            </span>
            <span class="shrink-0 rounded border border-paper-200 px-1.5 py-0.5 text-[11px] text-ink-500 dark:border-paper-700 dark:text-ink-400">
              {{ lineLabel(candidate.item) }}
            </span>
          </span>
        </button>
        <p v-if="candidates.length === 0" class="px-3 py-6 text-center text-sm text-ink-500 dark:text-ink-400">
          当前文档没有匹配标题
        </p>
      </div>
    </div>
  </div>
</template>
