<script setup lang="ts">
import { ref } from "vue";
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
import EditorModeToggle from "./EditorModeToggle.vue";
import ThemeToggle from "../theme-toggle/ThemeToggle.vue";
import { openFindPanel } from "../../stores/findReplaceStore";
import { exportTargets, runDocumentExport } from "../../utils/export";
import type { EditorMode, ThemeMode } from "../../types";

type EditorCommand =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "blockquote"
  | "orderedList"
  | "bulletList"
  | "taskList"
  | "heading"
  | "image"
  | "alert";

const exportMenuOpen = ref(false);
const primaryExportTargets = exportTargets.filter((target) => ["pdf", "html", "docx", "png"].includes(target.id));
const secondaryExportTargets = exportTargets.filter((target) => !primaryExportTargets.includes(target));

async function run(action: () => Promise<void> | void) {
  try {
    await action();
  } catch (error) {
    appStore.statusMessage = String(error);
  }
}

async function runExport(target: (typeof exportTargets)[number]) {
  exportMenuOpen.value = false;
  await runDocumentExport(target);
}

function toggleTheme(theme: "light" | "dark") {
  void run(() => setTheme(theme as ThemeMode));
}

function toggleEditorMode(mode: EditorMode) {
  switchMode(mode);
}

const canRunWysiwygCommand = () => appStore.documentMode === "normal" && appStore.editorMode === "wysiwyg";

function runEditorCommand(command: EditorCommand, value?: string | number | null) {
  if (!canRunWysiwygCommand()) return;
  window.dispatchEvent(
    new CustomEvent("lightmark:editor-command", {
      detail: { command, value },
    }),
  );
}

function openCommandPalette() {
  appStore.commandPaletteOpen = true;
}
</script>

<template>
  <header class="lm-toolbar" :class="{ 'lm-toolbar-dark': appStore.activeTheme === 'dark' }">
    <div class="lm-toolbar-group" aria-label="文件">
      <button class="lm-toolbar-button" title="新建" aria-label="新建" @click="run(createNewFile)">
        <span class="tb-ico tb-ico-new" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button" title="打开文件" aria-label="打开文件" @click="run(() => openFile())">
        <span class="tb-ico tb-ico-open-file" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button" title="打开文件夹" aria-label="打开文件夹" @click="run(() => openWorkspace())">
        <span class="tb-ico tb-ico-folder" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button primary" title="保存" aria-label="保存" @click="run(saveCurrentFile)">
        <span class="tb-ico tb-ico-save" aria-hidden="true"></span>
      </button>
    </div>

    <EditorModeToggle
      :class="{ 'editor-mode-toggle-dark': appStore.activeTheme === 'dark' }"
      :model-value="appStore.editorMode"
      :source-disabled="appStore.documentMode === 'large'"
      @update:model-value="toggleEditorMode"
    />

    <div class="lm-toolbar-group editor-tools" aria-label="编辑">
      <button class="lm-toolbar-button" title="加粗" aria-label="加粗" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('bold')">
        <span class="tb-ico tb-ico-bold" aria-hidden="true">B</span>
      </button>
      <button class="lm-toolbar-button" title="斜体" aria-label="斜体" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('italic')">
        <span class="tb-ico tb-ico-italic" aria-hidden="true">I</span>
      </button>
      <button class="lm-toolbar-button" title="行内代码" aria-label="行内代码" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('code')">
        <span class="tb-ico tb-ico-code" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button" title="链接" aria-label="链接" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('link')">
        <span class="tb-ico tb-ico-link" aria-hidden="true"></span>
      </button>
      <span class="lm-toolbar-split"></span>
      <button class="lm-toolbar-button" title="标题" aria-label="标题" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('heading', 2)">
        <span class="tb-ico tb-ico-heading" aria-hidden="true">H</span>
      </button>
      <button class="lm-toolbar-button" title="引用" aria-label="引用" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('blockquote')">
        <span class="tb-ico tb-ico-quote" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button" title="无序列表" aria-label="无序列表" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('bulletList')">
        <span class="tb-ico tb-ico-ul" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button" title="有序列表" aria-label="有序列表" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('orderedList')">
        <span class="tb-ico tb-ico-ol" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button" title="任务清单" aria-label="任务清单" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('taskList')">
        <span class="tb-ico tb-ico-task" aria-hidden="true"></span>
      </button>
      <span class="lm-toolbar-split"></span>
      <button class="lm-toolbar-button" title="图片" aria-label="图片" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('image')">
        <span class="tb-ico tb-ico-image" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button" title="GitHub 警示框" aria-label="GitHub 警示框" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('alert', 'note')">
        <span class="tb-ico tb-ico-alert" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button disabled-soft" title="表格，未来版本实现" aria-label="表格，未来版本实现" disabled>
        <span class="tb-ico tb-ico-table" aria-hidden="true"></span>
      </button>
    </div>

    <div class="lm-toolbar-title" :title="currentFileName">
      <span class="dirty-dot" :class="{ visible: appStore.isDirty }" aria-hidden="true"></span>
      <span class="truncate">{{ currentFileName }}</span>
    </div>

    <div class="lm-toolbar-group ml-auto" aria-label="视图和导出">
      <button class="lm-toolbar-button" title="命令面板" aria-label="命令面板" @click="openCommandPalette">
        <span class="tb-ico tb-ico-command" aria-hidden="true"></span>
      </button>
      <button class="lm-toolbar-button" title="查找与替换 Ctrl+F" aria-label="查找与替换" @click="openFindPanel">
        <span class="tb-ico tb-ico-find" aria-hidden="true"></span>
      </button>
      <div class="lm-export-menu-wrap">
        <button
          class="lm-toolbar-button"
          title="导出"
          aria-label="导出"
          :disabled="appStore.exportStatus.status === 'running'"
          @click="exportMenuOpen = !exportMenuOpen"
        >
          <span class="tb-ico tb-ico-export" aria-hidden="true"></span>
        </button>
        <div v-if="exportMenuOpen" class="lm-export-menu" @mouseleave="exportMenuOpen = false">
          <button
            v-for="target in primaryExportTargets"
            :key="target.id"
            class="lm-export-menu-item"
            :disabled="appStore.exportStatus.status === 'running'"
            @click="run(() => runExport(target))"
          >
            <span>{{ target.label }}</span>
            <small>.{{ target.extension }}</small>
          </button>
          <div class="lm-export-menu-separator"></div>
          <button
            v-for="target in secondaryExportTargets"
            :key="target.id"
            class="lm-export-menu-item"
            :disabled="appStore.exportStatus.status === 'running'"
            @click="run(() => runExport(target))"
          >
            <span>{{ target.label }}</span>
            <small>.{{ target.extension }}</small>
          </button>
        </div>
      </div>
      <button class="lm-toolbar-button" title="偏好设置" aria-label="偏好设置" @click="appStore.settingsOpen = true">
        <span class="tb-ico tb-ico-settings" aria-hidden="true"></span>
      </button>
      <span class="toolbar-theme-wrap">
        <ThemeToggle
          :model-value="appStore.activeTheme"
          size="md"
          @update:model-value="toggleTheme"
        />
      </span>
    </div>
  </header>
</template>

<style scoped>
.lm-toolbar {
  display: flex;
  height: 46px;
  min-width: 0;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid rgb(231 225 215 / 86%);
  background:
    linear-gradient(180deg, rgb(253 252 249 / 96%), rgb(247 244 238 / 92%));
  padding: 0 10px;
}

.lm-toolbar-group {
  display: inline-flex;
  height: 32px;
  align-items: center;
  gap: 2px;
  border: 1px solid rgb(219 213 202 / 72%);
  border-radius: 9px;
  background: rgb(255 255 255 / 52%);
  padding: 2px;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 62%);
}

.editor-tools {
  max-width: 45vw;
  overflow: hidden;
}

.lm-toolbar-button {
  position: relative;
  display: grid;
  width: 28px;
  height: 26px;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #625b51;
  cursor: pointer;
  outline: none;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    opacity 140ms ease;
}

.lm-toolbar-button:hover:not(:disabled),
.lm-toolbar-button:focus-visible:not(:disabled) {
  background: rgb(120 113 108 / 12%);
  color: #2f2b25;
}

.lm-toolbar-button.primary {
  color: #4d3922;
}

.lm-toolbar-button:disabled {
  cursor: not-allowed;
  opacity: 0.36;
}

.lm-toolbar-button.disabled-soft {
  opacity: 0.28;
}

.lm-toolbar-split {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: rgb(213 207 196 / 82%);
}

.lm-toolbar-title {
  display: flex;
  min-width: 92px;
  max-width: 260px;
  flex: 1 1 160px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #756f66;
  font-size: 13px;
  line-height: 1;
}

.dirty-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #b07a3c;
  opacity: 0;
}

.dirty-dot.visible {
  opacity: 1;
}

.toolbar-theme-wrap {
  display: inline-flex;
  margin-left: 4px;
}

.lm-export-menu-wrap {
  position: relative;
  display: inline-grid;
}

.lm-export-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 60;
  display: grid;
  width: 230px;
  max-height: min(68vh, 440px);
  overflow: auto;
  border: 1px solid rgb(219 213 202 / 88%);
  border-radius: 10px;
  background: rgb(255 254 251 / 98%);
  padding: 6px;
  box-shadow: 0 14px 36px rgb(49 45 40 / 16%);
}

.lm-export-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  padding: 8px 9px;
  color: #403b34;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}

.lm-export-menu-item:hover,
.lm-export-menu-item:focus-visible {
  background: rgb(120 113 108 / 11%);
  outline: none;
}

.lm-export-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.lm-export-menu-item small {
  color: #8a8276;
  font: 12px/1 "JetBrains Mono", ui-monospace, monospace;
}

.lm-export-menu-separator {
  height: 1px;
  margin: 5px 3px;
  background: rgb(219 213 202 / 78%);
}

.tb-ico {
  position: relative;
  display: block;
  width: 17px;
  height: 17px;
  color: currentColor;
}

.tb-ico::before,
.tb-ico::after {
  position: absolute;
  box-sizing: border-box;
  content: "";
}

.tb-ico-bold,
.tb-ico-italic,
.tb-ico-heading,
.tb-ico-pdf {
  display: grid;
  place-items: center;
  font: 700 13px/1 "JetBrains Mono", ui-monospace, monospace;
}

.tb-ico-italic {
  font-style: italic;
}

.tb-ico-new::before,
.tb-ico-open-file::before {
  inset: 2px 4px 1px 4px;
  border: 1.6px solid currentColor;
  border-radius: 2px;
}

.tb-ico-new::after {
  left: 8px;
  top: 5px;
  width: 1.6px;
  height: 7px;
  background: currentColor;
  box-shadow: -3px 3px 0 -2px transparent;
}

.tb-ico-new {
  background:
    linear-gradient(currentColor, currentColor) center / 7px 1.6px no-repeat;
}

.tb-ico-open-file::after {
  right: 3px;
  top: 2px;
  width: 5px;
  height: 5px;
  border-left: 1.6px solid currentColor;
  border-bottom: 1.6px solid currentColor;
  border-radius: 0 0 0 2px;
}

.tb-ico-folder::before {
  left: 2px;
  top: 5px;
  width: 13px;
  height: 9px;
  border: 1.6px solid currentColor;
  border-radius: 2px;
}

.tb-ico-folder::after {
  left: 3px;
  top: 3px;
  width: 6px;
  height: 4px;
  border: 1.6px solid currentColor;
  border-bottom: 0;
  border-radius: 2px 2px 0 0;
}

.tb-ico-save::before {
  inset: 2px;
  border: 1.6px solid currentColor;
  border-radius: 2px;
}

.tb-ico-save::after {
  left: 5px;
  bottom: 3px;
  width: 7px;
  height: 5px;
  border: 1.4px solid currentColor;
  border-radius: 1px;
}

.tb-ico-code::before {
  left: 0;
  top: 2px;
  content: "<";
  font: 700 14px/1 "JetBrains Mono", monospace;
}

.tb-ico-code::after {
  right: 0;
  top: 2px;
  content: ">";
  font: 700 14px/1 "JetBrains Mono", monospace;
}

.tb-ico-link::before,
.tb-ico-link::after {
  width: 7px;
  height: 9px;
  border: 1.7px solid currentColor;
  border-radius: 6px;
}

.tb-ico-link::before {
  left: 2px;
  top: 6px;
  border-right-color: transparent;
  transform: rotate(38deg);
}

.tb-ico-link::after {
  right: 2px;
  top: 2px;
  border-left-color: transparent;
  transform: rotate(38deg);
}

.tb-ico-quote::before {
  left: 2px;
  top: -1px;
  content: "“";
  font: 700 22px/1 Georgia, serif;
}

.tb-ico-ul::before {
  left: 2px;
  top: 4px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 5px 0 currentColor, 0 10px 0 currentColor;
}

.tb-ico-ul::after,
.tb-ico-ol::after {
  left: 8px;
  top: 4px;
  width: 8px;
  height: 1.8px;
  background: currentColor;
  box-shadow: 0 5px 0 currentColor, 0 10px 0 currentColor;
}

.tb-ico-ol::before {
  left: 1px;
  top: 2px;
  content: "1";
  font: 700 9px/1 sans-serif;
}

.tb-ico-task::before {
  left: 2px;
  top: 2px;
  width: 12px;
  height: 12px;
  border: 1.6px solid currentColor;
  border-radius: 4px;
}

.tb-ico-task::after {
  left: 6px;
  top: 4px;
  width: 5px;
  height: 8px;
  border: solid currentColor;
  border-width: 0 1.7px 1.7px 0;
  transform: rotate(42deg);
}

.tb-ico-image::before {
  inset: 3px 2px 3px 2px;
  border: 1.6px solid currentColor;
  border-radius: 2px;
}

.tb-ico-image::after {
  left: 5px;
  bottom: 4px;
  width: 8px;
  height: 6px;
  border-left: 1.6px solid currentColor;
  border-top: 1.6px solid currentColor;
  transform: rotate(45deg);
}

.tb-ico-alert::before {
  left: 8px;
  top: 2px;
  width: 1.8px;
  height: 9px;
  background: currentColor;
}

.tb-ico-alert::after {
  left: 8px;
  bottom: 2px;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: currentColor;
}

.tb-ico-table::before {
  inset: 2px;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  background:
    linear-gradient(currentColor, currentColor) 50% 0 / 1.4px 100% no-repeat,
    linear-gradient(currentColor, currentColor) 0 50% / 100% 1.4px no-repeat;
}

.tb-ico-command::before {
  inset: 3px;
  border: 1.6px solid currentColor;
  border-radius: 5px;
}

.tb-ico-command::after {
  left: 7px;
  top: 7px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: -5px 0 0 currentColor, 5px 0 0 currentColor;
}

.tb-ico-find::before {
  left: 2px;
  top: 2px;
  width: 9px;
  height: 9px;
  border: 1.7px solid currentColor;
  border-radius: 50%;
}

.tb-ico-find::after {
  right: 2px;
  bottom: 2px;
  width: 7px;
  height: 1.7px;
  border-radius: 2px;
  background: currentColor;
  transform: rotate(45deg);
}

.tb-ico-export::before {
  left: 8px;
  top: 2px;
  width: 1.6px;
  height: 9px;
  background: currentColor;
}

.tb-ico-export::after {
  left: 5px;
  top: 2px;
  width: 7px;
  height: 7px;
  border-top: 1.6px solid currentColor;
  border-right: 1.6px solid currentColor;
  transform: rotate(-45deg);
}

.tb-ico-settings::before {
  inset: 3px;
  border: 1.7px solid currentColor;
  border-radius: 50%;
}

.tb-ico-settings::after {
  left: 8px;
  top: 0;
  width: 1.5px;
  height: 17px;
  background: currentColor;
  box-shadow: -5px 5px 0 -0.2px currentColor, 5px -5px 0 -0.2px currentColor;
  transform: rotate(45deg);
}

:global(.dark) .lm-toolbar,
.lm-toolbar-dark {
  border-bottom-color: rgb(41 37 34 / 92%);
  background:
    linear-gradient(180deg, rgb(20 19 17 / 98%), rgb(28 26 23 / 94%));
}

:global(.dark) .lm-toolbar-group,
.lm-toolbar-dark .lm-toolbar-group {
  border-color: rgb(76 70 62 / 70%);
  background: rgb(32 29 26 / 76%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 4%);
}

:global(.dark) .lm-toolbar-button,
.lm-toolbar-dark .lm-toolbar-button {
  color: #b9b3a8;
}

:global(.dark) .lm-toolbar-button:hover:not(:disabled),
:global(.dark) .lm-toolbar-button:focus-visible:not(:disabled),
.lm-toolbar-dark .lm-toolbar-button:hover:not(:disabled),
.lm-toolbar-dark .lm-toolbar-button:focus-visible:not(:disabled) {
  background: rgb(255 255 255 / 8%);
  color: #f2eee6;
}

:global(.dark) .lm-toolbar-button.primary,
.lm-toolbar-dark .lm-toolbar-button.primary {
  color: #e1c49c;
}

:global(.dark) .lm-toolbar-split,
.lm-toolbar-dark .lm-toolbar-split {
  background: rgb(76 70 62 / 82%);
}

:global(.dark) .lm-toolbar-title,
.lm-toolbar-dark .lm-toolbar-title {
  color: #aaa196;
}

:global(.dark) .lm-export-menu,
.lm-toolbar-dark .lm-export-menu {
  border-color: rgb(76 70 62 / 86%);
  background: rgb(32 29 26 / 98%);
  box-shadow: 0 16px 42px rgb(0 0 0 / 34%);
}

:global(.dark) .lm-export-menu-item,
.lm-toolbar-dark .lm-export-menu-item {
  color: #e5ded2;
}

:global(.dark) .lm-export-menu-item:hover,
:global(.dark) .lm-export-menu-item:focus-visible,
.lm-toolbar-dark .lm-export-menu-item:hover,
.lm-toolbar-dark .lm-export-menu-item:focus-visible {
  background: rgb(255 255 255 / 8%);
}

:global(.dark) .lm-export-menu-item small,
.lm-toolbar-dark .lm-export-menu-item small {
  color: #aaa196;
}

:global(.dark) .lm-export-menu-separator,
.lm-toolbar-dark .lm-export-menu-separator {
  background: rgb(76 70 62 / 82%);
}
</style>
