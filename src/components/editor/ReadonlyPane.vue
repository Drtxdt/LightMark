<script setup lang="ts">
import { computed } from "vue";
import { appStore, openWikiLink, setActivePane } from "../../stores/appStore";
import type { DocumentTab, EditorPaneId } from "../../types";
import { resolveRenderedImageSources } from "../../utils/imageAssets";
import { renderMarkdown } from "../../utils/markdown";
import { extractOutline } from "../../utils/outline";
import { parseWikiLinkHref } from "../../utils/wikiLinks";

const props = defineProps<{
  paneId: EditorPaneId;
  tab: DocumentTab | null;
}>();

const html = computed(() => {
  const content = props.tab?.content || "";
  const rendered = resolveRenderedImageSources(renderMarkdown(content));
  const outline = extractOutline(content);
  let index = 0;
  return rendered.replace(/<h([1-6])>/g, (match) => {
    const item = outline[index++];
    return item ? `<h${item.level} data-outline-id="${item.id}">` : match;
  });
});

async function activatePane() {
  await setActivePane(props.paneId);
}

async function handleClick(event: MouseEvent) {
  await activatePane();
  const target = event.target instanceof HTMLElement ? event.target : null;
  const link = target?.closest<HTMLAnchorElement>("a[href]");
  if (!link) return;
  const wikiTarget = parseWikiLinkHref(link.getAttribute("href") || "");
  if (!wikiTarget) return;
  event.preventDefault();
  void openWikiLink(wikiTarget);
}
</script>

<template>
  <div class="h-full overflow-auto bg-paper-50 dark:bg-paper-950" @click="handleClick" @focusin="activatePane">
    <article
      v-if="tab"
      class="markdown-preview prose prose-stone dark:prose-invert mx-auto max-w-[var(--lm-editor-width)] px-8 py-12"
      v-html="html"
    />
    <div v-else class="grid h-full place-items-center text-sm text-ink-500 dark:text-ink-400">
      选择一个标签页
    </div>
  </div>
</template>
