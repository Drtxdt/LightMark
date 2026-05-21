<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { currentFileName } from "../../stores/appStore";
import {
  appStore,
  createNewFile,
  openFile,
  openWorkspace,
  saveCurrentFile,
  setTheme,
  switchMode,
} from "../../stores/appStore";
import { buildExportHtml, renderMarkdown } from "../../utils/markdown";

async function run(action: () => Promise<void> | void) {
  try {
    await action();
    appStore.statusMessage = "";
  } catch (error) {
    appStore.statusMessage = String(error);
  }
}

async function exportHtml() {
  if (!appStore.currentFilePath) throw new Error("Open a Markdown file before exporting.");
  const html = buildExportHtml(currentFileName.value, renderMarkdown(appStore.currentContent));
  const target = await invoke<string>("export_html", {
    path: appStore.currentFilePath,
    html,
  });
  appStore.statusMessage = `Exported ${target}`;
}
</script>

<template>
  <header class="flex h-12 items-center gap-2 border-b border-slate-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
    <button class="btn" @click="run(createNewFile)">New</button>
    <button class="btn" @click="run(() => openFile())">Open File</button>
    <button class="btn" @click="run(() => openWorkspace())">Open Folder</button>
    <button class="btn-primary" @click="run(saveCurrentFile)">Save</button>
    <div class="mx-2 h-5 w-px bg-slate-200 dark:bg-zinc-800" />
    <div class="segmented">
      <button :class="{ active: appStore.editorMode === 'wysiwyg' }" @click="switchMode('wysiwyg')">Write</button>
      <button :class="{ active: appStore.editorMode === 'source' }" @click="switchMode('source')">Source</button>
      <button :class="{ active: appStore.editorMode === 'preview' }" @click="switchMode('preview')">Preview</button>
    </div>
    <button class="btn" @click="run(exportHtml)">Export HTML</button>
    <div class="ml-auto flex items-center gap-2">
      <span class="max-w-[360px] truncate text-sm text-slate-500 dark:text-zinc-400">
        {{ currentFileName }}<span v-if="appStore.isDirty"> *</span>
      </span>
      <select class="select" :value="appStore.theme" @change="setTheme(($event.target as HTMLSelectElement).value as any)">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  </header>
</template>
