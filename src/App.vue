<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import AppLayout from "./components/layout/AppLayout.vue";
import CommandPalette from "./components/command/CommandPalette.vue";
import WordCountPanel from "./components/plugin/WordCountPanel.vue";
import { activatePlugins } from "./plugins/registry";
import { wordCountPlugin } from "./plugins/wordCountPlugin";
import { appStore, applyTheme, loadConfig, saveCurrentFile } from "./stores/appStore";
import { bindShortcut } from "./utils/shortcuts";

let unbindSave = () => {};
let unbindPalette = () => {};

onMounted(async () => {
  activatePlugins([wordCountPlugin]);
  await loadConfig().catch((error) => {
    appStore.statusMessage = String(error);
  });
  applyTheme();
  unbindSave = bindShortcut("ctrl+s", () => {
    saveCurrentFile().catch((error) => (appStore.statusMessage = String(error)));
  });
  unbindPalette = bindShortcut("ctrl+shift+p", () => {
    appStore.commandPaletteOpen = true;
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
});

onUnmounted(() => {
  unbindSave();
  unbindPalette();
});
</script>

<template>
  <AppLayout />
  <CommandPalette v-if="appStore.commandPaletteOpen" />
  <WordCountPanel v-if="appStore.wordCountOpen" />
</template>
