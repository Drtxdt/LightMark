<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { appStore, openFile, openWorkspace, switchMode } from "../../stores/appStore";
import FileTreeNode from "./FileTreeNode.vue";
import { extractOutline } from "../../utils/outline";
import type { LargeOutlineItem, OutlineItem } from "../../types";

const activePane = ref<"files" | "outline">("files");
const outline = computed(() => {
  if (appStore.documentMode === "large") return appStore.largeFile?.outline ?? [];
  return extractOutline(appStore.currentContent);
});

watch(
  () => appStore.settings.appearance.showOutline,
  (showOutline) => {
    if (!showOutline && activePane.value === "outline") activePane.value = "files";
  },
);

async function selectFile(path: string) {
  await openFile(path);
}

async function jumpToHeading(item: OutlineItem | LargeOutlineItem) {
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
  const headings = Array.from(document.querySelectorAll<HTMLElement>(".ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6"));
  const index = outline.value.findIndex((candidate) => candidate.id === item.id);
  const sameLevelBefore = outline.value.slice(0, Math.max(index, 0)).filter((candidate) => candidate.level === item.level).length;
  const sameLevelHeadings = headings.filter((heading) => Number(heading.tagName.slice(1)) === item.level);
  const indexed = sameLevelHeadings[sameLevelBefore];
  if (indexed && normalizeHeadingText(indexed.textContent || "") === normalizeHeadingText(item.text)) return indexed;

  return headings.find((heading) => {
    return Number(heading.tagName.slice(1)) === item.level && normalizeHeadingText(heading.textContent || "") === normalizeHeadingText(item.text);
  }) || null;
}

function normalizeHeadingText(value: string) {
  return value.replace(/[#*_`[\]()]/g, "").replace(/\s+/g, " ").trim();
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function outlineIndent(level: number) {
  return `${Math.min(Math.max(level - 1, 0), 5) * 0.75 + 0.5}rem`;
}
</script>

<template>
  <aside class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-paper-100/60 dark:bg-paper-900">
    <div class="flex-none p-3 pb-2">
      <div class="flex items-center gap-1 rounded-md bg-paper-200/70 p-1 dark:bg-paper-800">
        <button
          v-if="appStore.settings.appearance.showOutline"
          class="flex-1 rounded px-2 py-1 text-sm text-ink-500 transition-colors hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100"
          :class="{ 'bg-paper-50 text-ink-900 shadow-sm dark:bg-paper-900 dark:text-ink-100': activePane === 'files' }"
          @click="activePane = 'files'"
        >
          文件
        </button>
        <button
          class="flex-1 rounded px-2 py-1 text-sm text-ink-500 transition-colors hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100"
          :class="{ 'bg-paper-50 text-ink-900 shadow-sm dark:bg-paper-900 dark:text-ink-100': activePane === 'outline' }"
          @click="activePane = 'outline'"
        >
          大纲
        </button>
      </div>
    </div>

    <section v-if="activePane === 'files'" class="min-h-0 flex-1 overflow-auto px-3 pb-3">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">工作区</h2>
        <button class="btn-small" @click="openWorkspace()">打开</button>
      </div>
      <p v-if="!appStore.currentWorkspace" class="text-sm text-ink-500 dark:text-ink-300">尚未打开文件夹。</p>
      <p v-else class="mb-3 truncate text-xs text-ink-500 dark:text-ink-300">{{ appStore.currentWorkspace }}</p>
      <FileTreeNode v-for="node in appStore.fileTree" :key="node.path" :node="node" @select="selectFile" />
    </section>

    <section v-else class="min-h-0 flex-1 overflow-auto px-3 pb-3">
      <h2 class="mb-3 text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">当前文档</h2>
      <p v-if="outline.length === 0" class="text-sm text-ink-500 dark:text-ink-300">暂无标题。</p>
      <button
        v-for="item in outline"
        :key="item.id"
        class="block w-full truncate rounded px-2 py-1 text-left text-sm text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100"
        :style="{ paddingLeft: outlineIndent(item.level) }"
        @click="jumpToHeading(item)"
      >
        {{ item.text }}
      </button>
    </section>
  </aside>
</template>
