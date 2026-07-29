<script setup lang="ts">
import { computed, ref } from "vue";
import { currentFileName } from "../../stores/appStore";
import {
  appStore,
  createNewFile,
  formatCurrentMarkdown,
  openCommandPalette,
  openFile,
  openWorkspace,
  saveCurrentFile,
  setTheme,
  switchMode,
  toggleSplitLayout,
} from "../../stores/appStore";
import EditorModeToggle from "./EditorModeToggle.vue";
import ThemeToggle from "../theme-toggle/ThemeToggle.vue";
import UiIcon from "../ui/UiIcon.vue";
import { openFindPanel } from "../../stores/findReplaceStore";
import { exportTargets, runDocumentExport } from "../../utils/export";
import { analyzeMathExportCompatibility, mathExportStatusLabel } from "../../utils/mathExportCompatibility";
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
const exportCompatibility = computed(() => new Map(exportTargets.map((target) => {
  const result = analyzeMathExportCompatibility(
    appStore.currentContent,
    target.id,
    appStore.settings.markdown.mathNumbering,
  );
  return [target.id, result] as const;
})));

async function run(action: () => Promise<unknown> | unknown) {
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

</script>

<template>
  <header class="lm-toolbar" :class="{ 'lm-toolbar-dark': appStore.activeTheme === 'dark' }">
    <div class="lm-toolbar-group file-tools" aria-label="文件">
      <button class="lm-toolbar-button" title="新建" aria-label="新建" @click="run(createNewFile)">
        <UiIcon name="file-plus" />
      </button>
      <button class="lm-toolbar-button" title="打开文件" aria-label="打开文件" @click="run(() => openFile())">
        <UiIcon name="file-input" />
      </button>
      <button class="lm-toolbar-button" title="打开文件夹" aria-label="打开文件夹" @click="run(() => openWorkspace())">
        <UiIcon name="folder-open" />
      </button>
      <button class="lm-toolbar-button primary" title="保存" aria-label="保存" @click="run(saveCurrentFile)">
        <UiIcon name="save" />
      </button>
      <button class="lm-toolbar-button" :title="appStore.splitLayout.enabled ? '关闭分屏' : '左右分屏'" :aria-label="appStore.splitLayout.enabled ? '关闭分屏' : '左右分屏'" @click="run(toggleSplitLayout)">
        <UiIcon name="columns" />
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
        <UiIcon name="bold" />
      </button>
      <button class="lm-toolbar-button" title="斜体" aria-label="斜体" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('italic')">
        <UiIcon name="italic" />
      </button>
      <button class="lm-toolbar-button" title="行内代码" aria-label="行内代码" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('code')">
        <UiIcon name="code" />
      </button>
      <button class="lm-toolbar-button" title="链接" aria-label="链接" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('link')">
        <UiIcon name="link" />
      </button>
      <span class="lm-toolbar-split"></span>
      <button class="lm-toolbar-button" title="标题" aria-label="标题" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('heading', 2)">
        <UiIcon name="heading" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-medium" title="引用" aria-label="引用" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('blockquote')">
        <UiIcon name="quote" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-medium" title="无序列表" aria-label="无序列表" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('bulletList')">
        <UiIcon name="list" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-medium" title="有序列表" aria-label="有序列表" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('orderedList')">
        <UiIcon name="list-ordered" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-medium" title="任务清单" aria-label="任务清单" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('taskList')">
        <UiIcon name="list-checks" />
      </button>
      <span class="lm-toolbar-split toolbar-priority-low"></span>
      <button class="lm-toolbar-button toolbar-priority-low" title="图片" aria-label="图片" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('image')">
        <UiIcon name="image" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-low" title="GitHub 警示框" aria-label="GitHub 警示框" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('alert', 'note')">
        <UiIcon name="badge-alert" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-low disabled-soft" title="表格，未来版本实现" aria-label="表格，未来版本实现" disabled>
        <UiIcon name="table" />
      </button>
    </div>

    <div class="lm-toolbar-title" :title="currentFileName">
      <span class="dirty-dot" :class="{ visible: appStore.isDirty }" aria-hidden="true"></span>
      <span class="truncate">{{ currentFileName }}</span>
    </div>

    <div class="lm-toolbar-group view-tools ml-auto" aria-label="视图和导出">
      <button class="lm-toolbar-button toolbar-priority-low" title="格式化当前 Markdown" aria-label="格式化当前 Markdown" :disabled="appStore.documentMode === 'large'" @click="run(formatCurrentMarkdown)">
        <UiIcon name="format" />
      </button>
      <button class="lm-toolbar-button" title="命令面板" aria-label="命令面板" @click="openCommandPalette">
        <UiIcon name="command" />
      </button>
      <button class="lm-toolbar-button" title="查找与替换 Ctrl+F" aria-label="查找与替换" @click="openFindPanel">
        <UiIcon name="search" />
      </button>
      <div class="lm-export-menu-wrap">
        <button
          class="lm-toolbar-button"
          title="导出"
          aria-label="导出"
          :disabled="appStore.exportStatus.status === 'running'"
          @click="exportMenuOpen = !exportMenuOpen"
        >
          <UiIcon name="file-output" />
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
            <span class="lm-export-menu-meta">
              <em :class="`is-${exportCompatibility.get(target.id)?.status}`">
                {{ mathExportStatusLabel(exportCompatibility.get(target.id)?.status ?? "full") }}
              </em>
              <small>.{{ target.extension }}</small>
            </span>
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
            <span class="lm-export-menu-meta">
              <em :class="`is-${exportCompatibility.get(target.id)?.status}`">
                {{ mathExportStatusLabel(exportCompatibility.get(target.id)?.status ?? "full") }}
              </em>
              <small>.{{ target.extension }}</small>
            </span>
          </button>
        </div>
      </div>
      <button class="lm-toolbar-button" title="偏好设置" aria-label="偏好设置" @click="appStore.settingsOpen = true">
        <UiIcon name="settings" />
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
  width: 260px;
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
.lm-export-menu-meta {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.lm-export-menu-meta em {
  border-radius: 999px;
  background: var(--lm-surface-soft);
  padding: 3px 6px;
  color: var(--lm-ink-muted);
  font-size: 10px;
  font-style: normal;
  line-height: 1;
}
.lm-export-menu-meta em.is-degraded { background: var(--lm-accent-soft); color: var(--lm-accent-strong); }
.lm-export-menu-meta em.is-blocked { background: color-mix(in srgb, var(--lm-danger) 13%, transparent); color: var(--lm-danger); }

.lm-export-menu-separator {
  height: 1px;
  margin: 5px 3px;
  background: rgb(219 213 202 / 78%);
}

/* Paper desk chrome */
.lm-toolbar {
  height: 52px;
  gap: 10px;
  border-bottom-color: var(--lm-border);
  background: color-mix(in srgb, var(--lm-surface-soft) 94%, transparent);
  padding: 0 12px;
  box-shadow: inset 0 1px rgb(255 255 255 / 45%);
}

.lm-toolbar-group {
  height: 34px;
  gap: 1px;
  border-color: transparent;
  border-radius: 10px;
  background: transparent;
  padding: 2px;
  box-shadow: none;
}

.lm-toolbar-button {
  width: 32px;
  height: 30px;
  border-radius: 8px;
  color: var(--lm-ink-soft);
  transition: background var(--lm-transition), color var(--lm-transition), transform var(--lm-transition), opacity var(--lm-transition);
}

.lm-toolbar-button:hover:not(:disabled) {
  background: var(--lm-accent-soft);
  color: var(--lm-ink);
}

.lm-toolbar-button:active:not(:disabled) { transform: translateY(1px); }
.lm-toolbar-button:focus-visible:not(:disabled) { background: var(--lm-accent-soft); box-shadow: 0 0 0 2px var(--lm-focus); }
.lm-toolbar-button.primary { background: var(--lm-accent-soft); color: var(--lm-accent); }
.lm-toolbar-split { height: 18px; background: var(--lm-border); }
.lm-toolbar-title { color: var(--lm-ink-muted); font-family: Georgia, "Noto Serif SC", serif; letter-spacing: 0.01em; }
.dirty-dot { width: 7px; height: 7px; background: var(--lm-accent); box-shadow: 0 0 0 3px var(--lm-accent-soft); }
.toolbar-theme-wrap { margin-left: 7px; padding-left: 9px; border-left: 1px solid var(--lm-border); }
.lm-export-menu { border-color: var(--lm-border-strong); border-radius: var(--lm-radius-md); background: var(--lm-surface-raised); box-shadow: var(--lm-shadow-md); }
.lm-export-menu-item { border-radius: var(--lm-radius-sm); color: var(--lm-ink); }
.lm-export-menu-item:hover, .lm-export-menu-item:focus-visible { background: var(--lm-accent-soft); }

:global(.dark) .lm-toolbar,
.lm-toolbar-dark { border-bottom-color: var(--lm-border); background: color-mix(in srgb, var(--lm-surface-soft) 96%, transparent); }
:global(.dark) .lm-toolbar-group,
.lm-toolbar-dark .lm-toolbar-group { border-color: transparent; background: transparent; box-shadow: none; }
:global(.dark) .lm-toolbar-button,
.lm-toolbar-dark .lm-toolbar-button { color: var(--lm-ink-soft); }
:global(.dark) .lm-toolbar-button:hover:not(:disabled),
.lm-toolbar-dark .lm-toolbar-button:hover:not(:disabled) { background: var(--lm-accent-soft); color: var(--lm-ink); }

@media (max-width: 1180px) {
  .toolbar-priority-low { display: none; }
  .editor-tools { max-width: none; }
  .lm-toolbar-title { max-width: 170px; }
}

@media (max-width: 1020px) {
  .toolbar-priority-medium { display: none; }
  .lm-toolbar-title { min-width: 72px; max-width: 140px; }
}

@media (max-width: 860px) {
  .editor-tools { display: none; }
  .lm-toolbar-title { max-width: none; }
}

@media (max-width: 720px) {
  .lm-toolbar-title { display: none; }
  .view-tools .lm-toolbar-button:first-child { display: none; }
  .toolbar-theme-wrap { margin-left: 3px; padding-left: 6px; }
}

@media (prefers-reduced-motion: reduce) {
  .lm-toolbar-button { transition-duration: 0ms; }
}
</style>
