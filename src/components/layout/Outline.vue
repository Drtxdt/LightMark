<script setup lang="ts">
import { computed, nextTick } from "vue";
import { appStore } from "../../stores/appStore";
import { extractOutline } from "../../utils/outline";

const outline = computed(() => extractOutline(appStore.currentContent));

async function jump(id: string) {
  if (appStore.editorMode !== "preview") {
    appStore.editorMode = "preview";
    await nextTick();
  }
  document.querySelector(`[data-outline-id="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
</script>

<template>
  <aside class="overflow-auto bg-slate-50 p-3 dark:bg-zinc-900">
    <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">Outline</h2>
    <p v-if="outline.length === 0" class="text-sm text-slate-500 dark:text-zinc-400">No headings.</p>
    <button
      v-for="item in outline"
      :key="item.id"
      class="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-slate-200 dark:hover:bg-zinc-800"
      :class="{ 'pl-5': item.level === 2, 'pl-8': item.level === 3 }"
      @click="jump(item.id)"
    >
      {{ item.text }}
    </button>
  </aside>
</template>
