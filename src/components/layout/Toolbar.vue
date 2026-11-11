<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from "vue";
import { currentFileName } from "../../stores/appStore";
import {
  appStore,
  createNewFile,
  flushDocumentSnapshot,
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
import { exportTargets } from "../../utils/exportTargets";
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
  | "table"
  | "alert";

const exportMenuOpen = ref(false);
const exportTrigger = ref<HTMLButtonElement | null>(null);
const exportPanel = ref<HTMLElement | null>(null);
const overflowOpen = ref(false);
const overflowTrigger = ref<HTMLButtonElement | null>(null);
const overflowPanel = ref<HTMLElement | null>(null);
const formatState = ref<Record<string, boolean | number | string>>({});
const headingLevel = computed(() => formatState.value.tabId === appStore.activeTabId ? Number(formatState.value.headingLevel || 0) : 0);
const overflowCommands: Array<{ command: EditorCommand; label: string; value?: string | number }> = [
  { command: "bold", label: "加粗" }, { command: "italic", label: "斜体" }, { command: "code", label: "行内代码" },
  { command: "link", label: "链接" }, { command: "blockquote", label: "引用" },
  { command: "bulletList", label: "无序列表" }, { command: "orderedList", label: "有序列表" },
  { command: "taskList", label: "任务清单" }, { command: "image", label: "图片" },
  { command: "table", label: "表格" }, { command: "alert", label: "GitHub 警示框", value: "note" },
];
function isFormatActive(command: string) { return formatState.value.tabId === appStore.activeTabId && Boolean(formatState.value[command]); }
function receiveFormatState(event: Event) { formatState.value = (event as CustomEvent).detail || {}; }
function closeOverflow() { overflowOpen.value = false; void nextTick(() => overflowTrigger.value?.focus()); }
async function toggleOverflow() {
  overflowOpen.value = !overflowOpen.value;
  if (overflowOpen.value) { await nextTick(); overflowPanel.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }
}
function handleOverflowKeys(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); closeOverflow(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(overflowPanel.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
}
function handleOutsidePointer(event: PointerEvent) {
  if (exportMenuOpen.value && !exportPanel.value?.contains(event.target as Node) && !exportTrigger.value?.contains(event.target as Node)) exportMenuOpen.value = false;
  if (overflowOpen.value && !overflowPanel.value?.contains(event.target as Node) && !overflowTrigger.value?.contains(event.target as Node)) overflowOpen.value = false;
}
onMounted(() => { window.addEventListener("lightmark:editor-format-state", receiveFormatState); window.addEventListener("pointerdown", handleOutsidePointer); });
onBeforeUnmount(() => { window.removeEventListener("lightmark:editor-format-state", receiveFormatState); window.removeEventListener("pointerdown", handleOutsidePointer); });
const primaryExportTargets = exportTargets.filter((target) => ["pdf", "html", "docx", "png"].includes(target.id));
const secondaryExportTargets = exportTargets.filter((target) => !primaryExportTargets.includes(target));
const exportCompatibility = ref(new Map<string, { status: string }>());

async function run(action: () => Promise<unknown> | unknown) {
  try {
    await action();
  } catch (error) {
    appStore.statusMessage = String(error);
  }
}

async function runExport(target: (typeof exportTargets)[number]) {
  exportMenuOpen.value = false;
  const { runDocumentExport } = await import("../../utils/export");
  await runDocumentExport(target);
}

async function toggleExportMenu() {
  exportMenuOpen.value = !exportMenuOpen.value;
  if (!exportMenuOpen.value) return;
  const tabId = appStore.activeTabId;
  const numbering = appStore.settings.markdown.mathNumbering;
  const markdown = tabId ? await flushDocumentSnapshot(tabId, "export") : appStore.currentContent;
  if (tabId !== appStore.activeTabId || !exportMenuOpen.value) { exportMenuOpen.value = false; return; }
  const { analyzeMathExportCompatibility } = await import("../../utils/mathExportCompatibility");
  exportCompatibility.value = new Map(exportTargets.map((target) => [target.id, analyzeMathExportCompatibility(
    markdown,
    target.id,
    numbering,
  )]));
  await nextTick();
  exportPanel.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function handleExportKeys(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); exportMenuOpen.value = false; exportTrigger.value?.focus(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(exportPanel.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
}

function mathExportStatusLabel(status: string) {
  return status === "blocked" ? "阻止" : status === "degraded" ? "降级" : "完整";
}

function toggleTheme(theme: "light" | "dark") {
  void run(() => setTheme(theme as ThemeMode));
}

function toggleEditorMode(mode: EditorMode) {
  void switchMode(mode);
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

    <span v-if="appStore.documentMode === 'large'" class="large-source-capability" title="专用分块源码编辑；默认不折行；选区预览最多 1MiB。">大文件 · 源码</span>
    <EditorModeToggle
      v-else
      :class="{ 'editor-mode-toggle-dark': appStore.activeTheme === 'dark' }"
      :model-value="appStore.editorMode"
      @update:model-value="toggleEditorMode"
    />

    <div class="lm-toolbar-group editor-tools" aria-label="编辑">
      <button class="lm-toolbar-button" title="加粗" aria-label="加粗" :aria-pressed="isFormatActive('bold')" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('bold')">
        <UiIcon name="bold" />
      </button>
      <button class="lm-toolbar-button" title="斜体" aria-label="斜体" :aria-pressed="isFormatActive('italic')" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('italic')">
        <UiIcon name="italic" />
      </button>
      <button class="lm-toolbar-button" title="行内代码" aria-label="行内代码" :aria-pressed="isFormatActive('code')" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('code')">
        <UiIcon name="code" />
      </button>
      <button class="lm-toolbar-button" title="链接" aria-label="链接" :aria-pressed="isFormatActive('link')" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('link')">
        <UiIcon name="link" />
      </button>
      <span class="lm-toolbar-split"></span>
      <select class="toolbar-heading-select" aria-label="段落样式" :value="headingLevel" :disabled="!canRunWysiwygCommand()" @change="runEditorCommand('heading', Number(($event.target as HTMLSelectElement).value))">
        <option :value="0">正文</option>
        <option v-for="level in 6" :key="level" :value="level">H{{ level }}</option>
      </select>
      <button class="lm-toolbar-button toolbar-priority-medium" title="引用" aria-label="引用" :aria-pressed="isFormatActive('blockquote')" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('blockquote')">
        <UiIcon name="quote" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-medium" title="无序列表" aria-label="无序列表" :aria-pressed="isFormatActive('bulletList')" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('bulletList')">
        <UiIcon name="list" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-medium" title="有序列表" aria-label="有序列表" :aria-pressed="isFormatActive('orderedList')" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('orderedList')">
        <UiIcon name="list-ordered" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-medium" title="任务清单" aria-label="任务清单" :aria-pressed="isFormatActive('taskList')" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('taskList')">
        <UiIcon name="list-checks" />
      </button>
      <span class="lm-toolbar-split toolbar-priority-low"></span>
      <button class="lm-toolbar-button toolbar-priority-low" title="图片" aria-label="图片" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('image')">
        <UiIcon name="image" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-low" title="GitHub 警示框" aria-label="GitHub 警示框" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('alert', 'note')">
        <UiIcon name="badge-alert" />
      </button>
      <button class="lm-toolbar-button toolbar-priority-low" title="插入表格" aria-label="插入表格" :disabled="!canRunWysiwygCommand()" @click="runEditorCommand('table')">
        <UiIcon name="table" />
      </button>
    </div>

    <div class="toolbar-overflow-wrap">
      <button ref="overflowTrigger" class="lm-toolbar-button" aria-label="更多编辑操作" title="更多编辑操作" aria-haspopup="menu" :aria-expanded="overflowOpen" @click="toggleOverflow">•••</button>
      <div v-if="overflowOpen" ref="overflowPanel" class="lm-export-menu toolbar-overflow-menu" role="menu" @keydown="handleOverflowKeys">
        <button v-for="item in overflowCommands" :key="item.command" class="lm-export-menu-item" role="menuitem" :disabled="!canRunWysiwygCommand()" @click="overflowOpen = false; runEditorCommand(item.command, item.value)">{{ item.label }}<span v-if="isFormatActive(item.command)" aria-label="已启用">✓</span></button>
        <button v-for="level in 7" :key="`h${level}`" class="lm-export-menu-item" role="menuitem" :disabled="!canRunWysiwygCommand()" @click="overflowOpen = false; runEditorCommand('heading', level - 1)">{{ level === 1 ? '正文' : `H${level - 1}` }}<span v-if="headingLevel === level - 1">✓</span></button>
        <button class="lm-export-menu-item" role="menuitem" :disabled="appStore.documentMode === 'large'" @click="overflowOpen = false; run(formatCurrentMarkdown)">格式化 Markdown</button>
      </div>
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
          ref="exportTrigger"
          title="导出"
          aria-label="导出"
          aria-haspopup="menu"
          :aria-expanded="exportMenuOpen"
          :disabled="appStore.exportStatus.status === 'running'"
          @click="run(toggleExportMenu)"
        >
          <UiIcon name="file-output" />
        </button>
        <div v-if="exportMenuOpen" ref="exportPanel" class="lm-export-menu" role="menu" @keydown="handleExportKeys">
          <button
            v-for="target in primaryExportTargets"
            :key="target.id"
            class="lm-export-menu-item"
            role="menuitem"
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
            role="menuitem"
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
          :size="77"
          @update:model-value="toggleTheme"
        />
      </span>
    </div>
  </header>
</template>

<style scoped>
.large-source-capability { flex: 0 0 auto; padding: 6px 9px; border: 1px solid var(--lm-border); border-radius: 7px; background: var(--lm-surface-soft); color: var(--lm-ink); font-size: 12px; }
.toolbar-heading-select { width: 64px; height: 30px; border: 1px solid var(--lm-border); border-radius: 7px; background: var(--lm-surface); color: var(--lm-ink); font-size: 12px; }
.lm-toolbar-button[aria-pressed="true"] { background: var(--lm-accent-soft); color: var(--lm-accent); }
.toolbar-overflow-wrap { position: relative; display: none; flex: 0 0 auto; }
.toolbar-overflow-menu { left: 0; right: auto; width: 220px; }
@media (max-width: 1180px) { .toolbar-overflow-wrap { display: inline-grid; } }

.lm-toolbar {
  display: flex;
  height: 46px;
  min-width: 0;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--lm-border);
  background: color-mix(in srgb, var(--lm-surface-soft) 94%, transparent);
  padding: 0 10px;
}

.lm-toolbar-group {
  display: inline-flex;
  height: 32px;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--lm-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--lm-surface-raised) 52%, transparent);
  padding: 2px;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--lm-surface-raised) 62%, transparent);
}

.editor-tools {
  max-width: 45vw;
  overflow: visible;
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
  color: var(--lm-ink-soft);
  cursor: pointer;
  outline: none;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    opacity 140ms ease;
}

.lm-toolbar-button:hover:not(:disabled),
.lm-toolbar-button:focus-visible:not(:disabled) {
  background: var(--lm-accent-soft);
  color: var(--lm-ink);
}

.lm-toolbar-button.primary {
  color: var(--lm-accent);
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
  background: var(--lm-border);
}

.lm-toolbar-title {
  display: flex;
  min-width: 92px;
  max-width: 260px;
  flex: 1 1 160px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--lm-ink-muted);
  font-size: 13px;
  line-height: 1;
}

.dirty-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--lm-accent);
  box-shadow: 0 0 0 3px var(--lm-accent-soft);
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
  border: 1px solid var(--lm-border-strong);
  border-radius: 10px;
  background: var(--lm-surface-raised);
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
  color: var(--lm-ink);
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}

.lm-export-menu-item:hover,
.lm-export-menu-item:focus-visible {
  background: var(--lm-accent-soft);
}

.lm-export-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.lm-export-menu-item small {
  color: var(--lm-ink-muted);
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
.lm-export-menu-meta em.is-degraded { background: var(--lm-accent-soft); color: var(--lm-accent); }
.lm-export-menu-meta em.is-blocked { background: color-mix(in srgb, var(--lm-error) 13%, transparent); color: var(--lm-error); }

.lm-export-menu-separator {
  height: 1px;
  margin: 5px 3px;
  background: var(--lm-border);
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
.lm-toolbar-button:focus-visible:not(:disabled) {
  background: var(--lm-accent-soft);
  outline: 2px solid var(--lm-accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 2px var(--lm-focus);
}
.lm-toolbar-button.primary { background: var(--lm-accent-soft); color: var(--lm-accent); }
.lm-toolbar-split { height: 18px; background: var(--lm-border); }
.lm-toolbar-title { color: var(--lm-ink-muted); font-family: Georgia, "Noto Serif SC", serif; letter-spacing: 0.01em; }
.dirty-dot { width: 7px; height: 7px; background: var(--lm-accent); box-shadow: 0 0 0 3px var(--lm-accent-soft); }
.toolbar-theme-wrap { margin-left: 7px; padding-left: 9px; border-left: 1px solid var(--lm-border); }
.lm-export-menu { border-color: var(--lm-border-strong); border-radius: var(--lm-radius-md); background: var(--lm-surface-raised); box-shadow: var(--lm-shadow-md); }
.lm-export-menu-item { border-radius: var(--lm-radius-sm); color: var(--lm-ink); }
.lm-export-menu-item:hover, .lm-export-menu-item:focus-visible {
  background: var(--lm-accent-soft);
  outline: 2px solid var(--lm-accent);
  outline-offset: 2px;
}

.lm-toolbar-dark { border-bottom-color: var(--lm-border); background: color-mix(in srgb, var(--lm-surface-soft) 96%, transparent); }
.lm-toolbar-dark .lm-toolbar-group { border-color: transparent; background: transparent; box-shadow: none; }
.lm-toolbar-dark .lm-toolbar-button { color: var(--lm-ink-soft); }
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

.lm-toolbar-dark .lm-toolbar-button[aria-pressed="true"] { color: var(--lm-accent); background: var(--lm-accent-soft); }

@media (prefers-reduced-motion: reduce) {
  .lm-toolbar-button { transition-duration: 0ms; }
}
</style>
