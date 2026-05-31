<script setup lang="ts">
import { computed, nextTick } from "vue";
import { appStore, switchMode } from "../../stores/appStore";
import { extractOutline } from "../../utils/outline";

const outline = computed(() => {
  if (appStore.documentMode === "large") return appStore.largeFile?.outline ?? [];
  return extractOutline(appStore.currentContent);
});

async function jump(item: (typeof outline.value)[number]) {
  if (appStore.documentMode === "large" && "line" in item) {
    window.dispatchEvent(new CustomEvent("lightmark:jump-line", { detail: item.line }));
    return;
  }
  if (appStore.editorMode !== "wysiwyg") {
    switchMode("wysiwyg");
    await nextTick();
  }
  document.querySelector(`[data-outline-id="${item.id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function outlineIndent(level: number) {
  return `${Math.min(Math.max(level - 1, 0), 5) * 0.75 + 0.5}rem`;
}
</script>

<template>
  <aside class="overflow-auto bg-paper-100/40 p-3 dark:bg-paper-900">
    <h2 class="mb-3 text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">大纲</h2>
    <p v-if="outline.length === 0" class="text-sm text-ink-500 dark:text-ink-300">暂无标题。</p>
    <button
      v-for="item in outline"
      :key="item.id"
      class="block w-full truncate rounded px-2 py-1 text-left text-sm text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100"
      :style="{ paddingLeft: outlineIndent(item.level) }"
      @click="jump(item)"
    >
      {{ item.text }}
    </button>
  </aside>
</template>
