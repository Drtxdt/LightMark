<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import {
  appStore,
  closeHeadingJump,
  recordNavigationLocation,
  switchMode,
} from "../../stores/appStore";
import type { LargeOutlineItem, OutlineItem } from "../../types";
import { extractOutline } from "../../utils/outline";

type HeadingCandidate = {
  item: OutlineItem | LargeOutlineItem;
  score: number;
};

const outline = computed<Array<OutlineItem | LargeOutlineItem>>(() => {
  if (appStore.documentMode === "large") return appStore.largeFile?.outline ?? [];
  return extractOutline(appStore.currentContent);
});

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

  if (appStore.documentMode === "large" && "line" in item) {
    window.dispatchEvent(new CustomEvent("lightmark:jump-line", { detail: item.line }));
    return;
  }

  if (appStore.editorMode !== "wysiwyg") {
    switchMode("wysiwyg");
    await nextTick();
  }

  await nextTick();
  const target = await waitForHeadingTarget(item);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function waitForHeadingTarget(item: OutlineItem) {
  const selector = `.ProseMirror [data-outline-id="${cssEscape(item.id)}"]`;
  return new Promise<HTMLElement | null>((resolve) => {
    let attempts = 0;
    const find = () => {
      const target = document.querySelector<HTMLElement>(selector) || findHeadingByOutlineItem(item);
      if (target || attempts >= 8) {
        resolve(target);
        return;
      }
      attempts += 1;
      requestAnimationFrame(find);
    };
    find();
  });
}

function findHeadingByOutlineItem(item: OutlineItem) {
  const headings = Array.from(
    document.querySelectorAll<HTMLElement>(".ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6"),
  );
  const index = outline.value.findIndex((candidate) => candidate.id === item.id);
  const sameLevelBefore = outline.value
    .slice(0, Math.max(index, 0))
    .filter((candidate) => candidate.level === item.level).length;
  const sameLevelHeadings = headings.filter((heading) => Number(heading.tagName.slice(1)) === item.level);
  const indexed = sameLevelHeadings[sameLevelBefore];
  if (indexed && normalizeHeadingText(indexed.textContent || "") === normalizeHeadingText(item.text)) return indexed;

  return (
    headings.find((heading) => {
      return (
        Number(heading.tagName.slice(1)) === item.level &&
        normalizeHeadingText(heading.textContent || "") === normalizeHeadingText(item.text)
      );
    }) || null
  );
}

function scoreHeading(item: OutlineItem | LargeOutlineItem, query: string) {
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

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function lineLabel(item: OutlineItem | LargeOutlineItem) {
  return "line" in item ? `L${item.line + 1}` : `H${item.level}`;
}
</script>

<template>
  <div class="fixed inset-0 z-50 bg-ink-900/20 p-20" @click.self="closeHeadingJump">
    <div class="mx-auto max-w-xl overflow-hidden rounded-md border border-paper-200 bg-paper-50 shadow-[0_18px_50px_rgba(31,30,27,0.12)] dark:border-paper-800 dark:bg-paper-900">
      <input
        v-model="appStore.headingJumpQuery"
        autofocus
        class="w-full border-b border-paper-200 bg-transparent px-4 py-3 text-base text-ink-900 outline-none placeholder:text-ink-500 dark:border-paper-800 dark:text-ink-100 dark:placeholder:text-ink-300"
        placeholder="前往指定标题"
        @keydown.esc="closeHeadingJump"
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
