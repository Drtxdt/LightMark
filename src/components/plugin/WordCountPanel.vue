<script setup lang="ts">
import { computed } from "vue";
import { appStore } from "../../stores/appStore";
import { getWordStats } from "../../plugins/wordCountPlugin";

const stats = computed(() => getWordStats(appStore.currentContent));
</script>

<template>
  <div class="fixed inset-0 z-40 bg-ink-900/15 p-8" @click.self="appStore.wordCountOpen = false">
    <section class="ml-auto w-72 rounded-md border border-paper-200 bg-paper-50 p-4 shadow-[0_18px_50px_rgba(31,30,27,0.12)] dark:border-paper-800 dark:bg-paper-900">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-sm font-semibold">Word Count</h2>
        <button class="btn-small" @click="appStore.wordCountOpen = false">Close</button>
      </div>
      <dl class="space-y-3 text-sm">
        <div class="flex justify-between"><dt>Words</dt><dd>{{ stats.words }}</dd></div>
        <div class="flex justify-between"><dt>Characters</dt><dd>{{ stats.chars }}</dd></div>
        <div class="flex justify-between"><dt>Lines</dt><dd>{{ stats.lines }}</dd></div>
      </dl>
    </section>
  </div>
</template>
