<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { appStore, openFile, openWorkspace, switchMode } from "../../stores/appStore";
import FileTreeNode from "./FileTreeNode.vue";
import { extractOutline } from "../../utils/outline";

const activePane = ref<"files" | "outline">("files");
const outline = computed(() => extractOutline(appStore.currentContent));

async function selectFile(path: string) {
  await openFile(path);
}

async function jumpToHeading(id: string) {
  if (appStore.editorMode !== "wysiwyg") {
    switchMode("wysiwyg");
    await nextTick();
  }

  await nextTick();
  const target = await waitForHeadingTarget(id);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function waitForHeadingTarget(id: string) {
  const selector = `.ProseMirror [data-outline-id="${cssEscape(id)}"]`;
  return new Promise<HTMLElement | null>((resolve) => {
    let attempts = 0;
    const find = () => {
      const target = document.querySelector<HTMLElement>(selector);
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

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function outlineIndent(level: number) {
  return `${Math.min(Math.max(level - 1, 0), 5) * 0.75 + 0.5}rem`;
}
</script>

<template>
  <aside class="min-w-0 overflow-auto bg-paper-100/60 p-3 dark:bg-paper-900">
    <div class="mb-3 flex items-center gap-1 rounded-md bg-paper-200/70 p-1 dark:bg-paper-800">
      <button
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

    <section v-if="activePane === 'files'">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">工作区</h2>
        <button class="btn-small" @click="openWorkspace()">打开</button>
      </div>
      <p v-if="!appStore.currentWorkspace" class="text-sm text-ink-500 dark:text-ink-300">尚未打开文件夹。</p>
      <p v-else class="mb-3 truncate text-xs text-ink-500 dark:text-ink-300">{{ appStore.currentWorkspace }}</p>
      <FileTreeNode v-for="node in appStore.fileTree" :key="node.path" :node="node" @select="selectFile" />
    </section>

    <section v-else>
      <h2 class="mb-3 text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">当前文档</h2>
      <p v-if="outline.length === 0" class="text-sm text-ink-500 dark:text-ink-300">暂无标题。</p>
      <button
        v-for="item in outline"
        :key="item.id"
        class="block w-full truncate rounded px-2 py-1 text-left text-sm text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100"
        :style="{ paddingLeft: outlineIndent(item.level) }"
        @click="jumpToHeading(item.id)"
      >
        {{ item.text }}
      </button>
    </section>
  </aside>
</template>
