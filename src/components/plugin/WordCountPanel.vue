<script setup lang="ts">
import { computed } from "vue";
import { appStore } from "../../stores/appStore";
import { getWordStats } from "../../plugins/wordCountPlugin";

const stats = computed(() => getWordStats(appStore.currentContent));
</script>

<template>
  <div class="lm-modal-backdrop fixed inset-0 z-40 p-8" @click.self="appStore.wordCountOpen = false">
    <section class="lm-palette-panel ml-auto w-72 p-4">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-sm font-semibold">字数统计</h2>
        <button class="btn-small" @click="appStore.wordCountOpen = false">关闭</button>
      </div>
      <dl class="space-y-3 text-sm">
        <div class="flex justify-between"><dt>词数</dt><dd>{{ stats.words }}</dd></div>
        <div class="flex justify-between"><dt>字符</dt><dd>{{ stats.chars }}</dd></div>
        <div class="flex justify-between"><dt>行数</dt><dd>{{ stats.lines }}</dd></div>
      </dl>
    </section>
  </div>
</template>
