<script setup lang="ts">
import { computed, ref } from "vue";
import {
  appStore,
  closeCommandPalette,
  expandAllHeadingFolds,
  formatCurrentMarkdown,
  openFile,
  openFileInOtherPane,
  openGoToLine,
  openHeadingJump,
  openFormulaJump,
  openQuickOpen,
  openWorkspace,
  saveCurrentFile,
  switchMode,
  toggleDistractionFreeMode,
  toggleCurrentHeadingFold,
  toggleFocusMode,
  toggleSplitLayout,
  toggleTypewriterMode,
} from "../../stores/appStore";
import { useOverlayFocus } from "../../composables/useOverlayFocus";
import { pluginCommands } from "../../plugins/registry";
import { exportTargets, runDocumentExport } from "../../utils/export";

const query = ref("");
const backdrop = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
useOverlayFocus({ backdrop, panel, initialFocus: input, close: closeCommandPalette });

const coreCommands = [
  { name: "快速打开文件", handler: () => openQuickOpen() },
  { name: "前往指定标题", handler: () => openHeadingJump() },
  { name: "前往公式", handler: () => openFormulaJump() },
  {
    name: "刷新当前文档全部公式",
    handler: () => {
      window.dispatchEvent(new CustomEvent("lightmark:refresh-math"));
      appStore.statusMessage = "已刷新当前文档全部公式";
    },
  },
  { name: "前往指定行", handler: () => openGoToLine() },
  { name: "打开文件", handler: () => openFile() },
  { name: "打开文件夹", handler: () => openWorkspace() },
  { name: "保存", handler: () => saveCurrentFile() },
  { name: "格式化当前 Markdown", handler: () => formatCurrentMarkdown() },
  { name: "切换左右分屏", handler: () => toggleSplitLayout() },
  { name: "切换专注模式（F8）", handler: () => toggleFocusMode() },
  { name: "切换打字机模式（F9）", handler: () => toggleTypewriterMode() },
  { name: "切换无干扰模式（Ctrl+Shift+F11）", handler: () => toggleDistractionFreeMode() },
  { name: "折叠/展开当前标题", handler: () => toggleCurrentHeadingFold() },
  { name: "展开当前文档全部标题", handler: () => expandAllHeadingFolds() },
  { name: "在另一栏打开当前文件", handler: () => openFileInOtherPane(appStore.currentFilePath) },
  { name: "打开设置", handler: () => (appStore.settingsOpen = true) },
  ...exportTargets.map((target) => ({
    name: `导出：${target.label}`,
    handler: async () => {
      await runDocumentExport(target);
    },
  })),
  { name: "切换编辑/源代码", handler: () => switchMode(appStore.editorMode === "source" ? "wysiwyg" : "source") },
];

const commands = computed(() => {
  const all = [...coreCommands, ...pluginCommands];
  const text = query.value.trim().toLowerCase();
  return text ? all.filter((command) => command.name.toLowerCase().includes(text)) : all;
});

async function execute(command: { name: string; handler: () => unknown | Promise<unknown> }) {
  try {
    await command.handler();
    closeCommandPalette();
  } catch (error) {
    appStore.statusMessage = String(error);
  }
}
</script>

<template>
  <div ref="backdrop" class="lm-modal-backdrop fixed inset-0 z-50 p-20" @click.self="closeCommandPalette">
    <div ref="panel" tabindex="-1" class="lm-palette-panel mx-auto max-w-xl overflow-hidden" role="dialog" aria-modal="true" aria-label="命令面板">
      <input
        ref="input"
        v-model="query"
        class="w-full border-b border-paper-200 bg-transparent px-4 py-3 text-base text-ink-900 outline-none placeholder:text-ink-500 dark:border-paper-800 dark:text-ink-100 dark:placeholder:text-ink-300"
        placeholder="搜索命令"
      />
      <div class="max-h-80 overflow-auto p-2">
        <button
          v-for="command in commands"
          :key="command.name"
          class="block w-full rounded px-3 py-2 text-left text-sm text-ink-700 transition-colors hover:bg-paper-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100"
          @click="execute(command)"
        >
          {{ command.name }}
        </button>
      </div>
    </div>
  </div>
</template>
