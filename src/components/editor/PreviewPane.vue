<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import mermaid from "mermaid";
import { appStore } from "../../stores/appStore";
import { renderMarkdown } from "../../utils/markdown";
import { extractOutline } from "../../utils/outline";

const html = computed(() => {
  const rendered = renderMarkdown(appStore.currentContent);
  const outline = extractOutline(appStore.currentContent);
  let index = 0;
  return rendered.replace(/<h([123])>/g, (match) => {
    const item = outline[index++];
    return item ? `<h${item.level} data-outline-id="${item.id}">` : match;
  });
});

async function renderMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
  });
  await nextTick();
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(".markdown-preview .mermaid"));
  if (nodes.length > 0) {
    await mermaid.run({ nodes });
  }
}

watch(html, renderMermaid, { immediate: true });
</script>

<template>
  <div class="h-full overflow-auto bg-white dark:bg-zinc-950">
    <article class="markdown-preview prose prose-slate dark:prose-invert mx-auto max-w-[860px] px-8 py-10" v-html="html" />
  </div>
</template>
