<script setup lang="ts">
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { appStore, openFile, openWorkspace, saveCurrentFile, switchMode } from "../../stores/appStore";
import { pluginCommands } from "../../plugins/registry";
import { buildExportHtml, renderMarkdown } from "../../utils/markdown";
import { currentFileName } from "../../stores/appStore";

const query = ref("");

const coreCommands = [
  { name: "Open File", handler: () => openFile() },
  { name: "Open Folder", handler: () => openWorkspace() },
  { name: "Save", handler: () => saveCurrentFile() },
  {
    name: "Export HTML",
    handler: async () => {
      if (!appStore.currentFilePath) throw new Error("Open a Markdown file before exporting.");
      await invoke("export_html", {
        path: appStore.currentFilePath,
        html: buildExportHtml(currentFileName.value, renderMarkdown(appStore.currentContent)),
      });
    },
  },
  { name: "Toggle Source Mode", handler: () => switchMode(appStore.editorMode === "source" ? "wysiwyg" : "source") },
  { name: "Toggle Preview Mode", handler: () => switchMode(appStore.editorMode === "preview" ? "wysiwyg" : "preview") },
];

const commands = computed(() => {
  const all = [...coreCommands, ...pluginCommands];
  const text = query.value.trim().toLowerCase();
  return text ? all.filter((command) => command.name.toLowerCase().includes(text)) : all;
});

async function execute(command: { name: string; handler: () => void | Promise<void> }) {
  try {
    await command.handler();
    appStore.commandPaletteOpen = false;
    appStore.statusMessage = "";
  } catch (error) {
    appStore.statusMessage = String(error);
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 bg-slate-950/30 p-20" @click.self="appStore.commandPaletteOpen = false">
    <div class="mx-auto max-w-xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <input
        v-model="query"
        autofocus
        class="w-full border-b border-slate-200 bg-transparent px-4 py-3 text-base outline-none dark:border-zinc-800"
        placeholder="Search commands"
        @keydown.esc="appStore.commandPaletteOpen = false"
      />
      <div class="max-h-80 overflow-auto p-2">
        <button
          v-for="command in commands"
          :key="command.name"
          class="block w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-zinc-800"
          @click="execute(command)"
        >
          {{ command.name }}
        </button>
      </div>
    </div>
  </div>
</template>
