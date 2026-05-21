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
  if (!appStore.currentFilePath) throw new Error("请先打开 Markdown 文件再导出。");
  const html = buildExportHtml(currentFileName.value, renderMarkdown(appStore.currentContent));
  const target = await invoke<string>("export_html", {
    path: appStore.currentFilePath,
    html,
  });
  appStore.statusMessage = `已导出：${target}`;
}
</script>

<template>
  <header class="flex h-11 items-center gap-1.5 border-b border-paper-200 bg-paper-50 px-3 dark:border-paper-800 dark:bg-paper-950">
    <button class="btn" @click="run(createNewFile)">新建</button>
    <button class="btn" @click="run(() => openFile())">打开文件</button>
    <button class="btn" @click="run(() => openWorkspace())">打开文件夹</button>
    <button class="btn-primary" @click="run(saveCurrentFile)">保存</button>
    <div class="mx-2 h-5 w-px bg-paper-200 dark:bg-paper-800" />
    <div class="segmented">
      <button :class="{ active: appStore.editorMode === 'wysiwyg' }" @click="switchMode('wysiwyg')">编辑</button>
      <button :class="{ active: appStore.editorMode === 'source' }" @click="switchMode('source')">源代码</button>
    </div>
    <button class="btn" @click="run(exportHtml)">导出 HTML</button>
    <div class="ml-auto flex items-center gap-2">
      <span class="max-w-[360px] truncate text-sm text-ink-500 dark:text-ink-300">
        {{ currentFileName }}<span v-if="appStore.isDirty"> *</span>
      </span>
      <select class="select" :value="appStore.theme" @change="setTheme(($event.target as HTMLSelectElement).value as any)">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>
  </header>
</template>
