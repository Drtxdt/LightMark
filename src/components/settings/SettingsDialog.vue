<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { appStore, defaultSettings, resetSettings, updateSettings } from "../../stores/appStore";
import { confirmDialog } from "../../stores/dialogStore";
import { useOverlayFocus } from "../../composables/useOverlayFocus";
import { detectPandoc } from "../../utils/export";
import { validateSnippet } from "../../utils/snippets";
import type { AppSettings, PandocStatus, SnippetDefinition } from "../../types";
import UiIcon from "../ui/UiIcon.vue";

type SettingsSection =
  | "general"
  | "editor"
  | "snippets"
  | "image"
  | "appearance"
  | "export"
  | "shortcuts"
  | "experimental";

type AfterExportAction = "none" | "openFile" | "revealFolder";

const activeSection = ref<SettingsSection>("general");
const localSettings = ref<AppSettings>(cloneSettings(appStore.settings));
const saveState = ref("");
const pandocStatus = ref<PandocStatus | null>(null);
const snippetDraft = ref<SnippetDefinition | null>(null);
const snippetError = ref("");
const backdrop = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
useOverlayFocus({ backdrop, panel, initialFocus: panel, close });

const sections: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "general", label: "基础", description: "会话、最近文件和草稿保存" },
  { id: "editor", label: "编辑体验", description: "默认模式与状态栏信息" },
  { id: "snippets", label: "片段", description: "管理 / 命令中的 Markdown 模板" },
  { id: "image", label: "图片与资源", description: "图片引用与路径格式" },
  { id: "appearance", label: "外观", description: "主题、字体和编辑区" },
  { id: "export", label: "导出", description: "HTML、Pandoc 与导出行为" },
  { id: "shortcuts", label: "快捷键", description: "当前可用的键盘操作" },
  { id: "experimental", label: "实验功能", description: "规划中能力与当前限制" },
];

const shortcutRows = [
  { command: "保存", shortcut: "Ctrl+S" },
  { command: "查找与替换", shortcut: "Ctrl+F" },
  { command: "快速打开文件", shortcut: "Ctrl+P" },
  { command: "命令面板", shortcut: "Ctrl+Shift+P" },
  { command: "专注模式", shortcut: "F8" },
  { command: "打字机模式", shortcut: "F9" },
  { command: "无干扰模式", shortcut: "Ctrl+Shift+F11" },
  { command: "前往指定标题", shortcut: "Ctrl+Shift+O" },
  { command: "前往指定行", shortcut: "Ctrl+G" },
  { command: "后退 / 前进", shortcut: "Alt+← / Alt+→" },
  { command: "关闭偏好设置", shortcut: "Esc" },
];

const experimentalGroups: Array<{ title: string; items: string[]; note?: string }> = [
  {
    title: "写作辅助",
    items: ["纯文本粘贴策略", "拼写检查"],
  },
  {
    title: "Markdown 精细控制",
    items: ["语法严格模式", "按语法单独启用或关闭", "YAML 覆盖导出设置"],
    note: "HTML、公式、Mermaid、脚注、TOC、任务列表和警示框等能力当前默认启用。",
  },
  {
    title: "资源与界面",
    items: ["拖拽图片自动复制", "图片根路径", "界面语言切换"],
  },
  {
    title: "自定义与诊断",
    items: ["自定义快捷键", "调试日志面板", "统一实验功能开关"],
  },
];

const activeSectionTitle = computed(() => sections.find((section) => section.id === activeSection.value)?.label ?? "");
const compressionThresholdMiB = computed({
  get: () => Number((localSettings.value.image.pasteCompressionThresholdBytes / (1024 * 1024)).toFixed(2)),
  set: (value: number) => {
    localSettings.value.image.pasteCompressionThresholdBytes = Math.round(Number(value) * 1024 * 1024);
  },
});
const afterExportAction = computed<AfterExportAction>({
  get() {
    if (localSettings.value.export.openFileAfterExport) return "openFile";
    if (localSettings.value.export.openFolderAfterExport) return "revealFolder";
    return "none";
  },
  set(value) {
    localSettings.value.export.openFileAfterExport = value === "openFile";
    localSettings.value.export.openFolderAfterExport = value === "revealFolder";
  },
});

watch(
  () => appStore.settings,
  (settings) => {
    localSettings.value = cloneSettings(settings);
  },
  { deep: true },
);

onMounted(() => {
  void refreshPandocStatus();
});

async function persist() {
  try {
    saveState.value = "正在保存...";
    localSettings.value.image.assetFolder = validateAssetFolder(localSettings.value.image.assetFolder);
    await updateSettings(cloneSettings(localSettings.value));
    saveState.value = "已保存";
    window.setTimeout(() => {
      if (saveState.value === "已保存") saveState.value = "";
    }, 1200);
  } catch (error) {
    saveState.value = String(error);
  }
}

function validateAssetFolder(value: string) {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized) return "assets";
  if (/^(?:[a-z]:|\/|\\)/i.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error("附件目录必须是文档目录内的相对路径，不能包含“..”。");
  }
  return normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

async function refreshPandocStatus() {
  pandocStatus.value = await detectPandoc(localSettings.value.export).catch(() => ({
    available: false,
    path: "",
    version: "",
    source: "missing" as const,
  }));
}

async function resetAll() {
  const confirmed = await confirmDialog({
    title: "重置所有设置？",
    message: "最近文件列表会保留，其他偏好设置将恢复默认值。",
    confirmLabel: "重置",
    tone: "danger",
  });
  if (!confirmed) return;
  localSettings.value = defaultSettings();
  await resetSettings();
}

function editSnippet(item?: SnippetDefinition) {
  snippetError.value = "";
  snippetDraft.value = item
    ? { ...item }
    : {
        id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `snippet-${Date.now()}`,
        name: "",
        trigger: "",
        description: "",
        markdown: "${selection}${cursor}",
        enabled: true,
      };
}

async function saveSnippet() {
  if (!snippetDraft.value) return;
  const candidate = {
    ...snippetDraft.value,
    name: snippetDraft.value.name.trim(),
    trigger: snippetDraft.value.trigger.trim(),
    description: snippetDraft.value.description.trim(),
  };
  snippetError.value = validateSnippet(candidate, localSettings.value.snippets.items);
  if (snippetError.value) return;
  const index = localSettings.value.snippets.items.findIndex((item) => item.id === candidate.id);
  if (index >= 0) localSettings.value.snippets.items.splice(index, 1, candidate);
  else localSettings.value.snippets.items.push(candidate);
  snippetDraft.value = null;
  await persist();
}

async function removeSnippet(item: SnippetDefinition) {
  const confirmed = await confirmDialog({
    title: "删除片段？",
    message: `“${item.name}”将从 / 命令和命令面板中移除。`,
    confirmLabel: "删除",
    tone: "danger",
  });
  if (!confirmed) return;
  localSettings.value.snippets.items = localSettings.value.snippets.items.filter((candidate) => candidate.id !== item.id);
  if (snippetDraft.value?.id === item.id) snippetDraft.value = null;
  await persist();
}

async function moveSnippet(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= localSettings.value.snippets.items.length) return;
  const [item] = localSettings.value.snippets.items.splice(index, 1);
  localSettings.value.snippets.items.splice(target, 0, item);
  await persist();
}

async function toggleSnippet() {
  await persist();
}

function close() {
  appStore.settingsOpen = false;
}

function cloneSettings(settings: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(settings)) as AppSettings;
}
</script>

<template>
  <div ref="backdrop" class="lm-modal-backdrop fixed inset-0 z-50 p-6" @click.self="close">
    <section
      ref="panel"
      tabindex="-1"
      class="lm-settings-panel mx-auto flex h-[min(760px,calc(100vh-48px))] max-w-5xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="偏好设置"
    >
      <aside class="w-56 flex-none border-r border-paper-200 bg-paper-100/70 p-3 dark:border-paper-800 dark:bg-paper-900">
        <div class="mb-3 px-2">
          <h2 class="text-base font-semibold text-ink-900 dark:text-ink-100">偏好设置</h2>
          <p class="mt-1 text-xs text-ink-500 dark:text-ink-300">这里的每一项都会真实影响 LightMark。</p>
        </div>
        <button
          v-for="section in sections"
          :key="section.id"
          class="mb-1 block w-full rounded-md px-2.5 py-2 text-left transition-colors"
          :class="
            activeSection === section.id
              ? 'bg-paper-50 text-ink-900 shadow-sm dark:bg-paper-950 dark:text-ink-100'
              : 'text-ink-500 hover:bg-paper-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100'
          "
          @click="activeSection = section.id"
        >
          <span class="block text-sm font-medium">{{ section.label }}</span>
          <span class="mt-0.5 block truncate text-xs opacity-75">{{ section.description }}</span>
        </button>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-14 flex-none items-center justify-between border-b border-paper-200 px-5 dark:border-paper-800">
          <div>
            <h3 class="text-base font-semibold text-ink-900 dark:text-ink-100">{{ activeSectionTitle }}</h3>
            <p class="text-xs text-ink-500 dark:text-ink-300">修改会即时写入 config.json。</p>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs text-ink-500 dark:text-ink-300" aria-live="polite">{{ saveState }}</span>
            <button class="btn-small" @click="resetAll">重置设置</button>
            <button class="settings-close" type="button" title="关闭" aria-label="关闭偏好设置" @click="close">
              <UiIcon name="x" :size="18" />
            </button>
          </div>
        </header>

        <main class="min-h-0 flex-1 overflow-auto px-6 py-5">
          <div v-if="activeSection === 'general'" class="settings-stack">
            <div class="settings-group">
              <h4>启动</h4>
              <label class="settings-row">
                <span><b>恢复上次会话</b><small>启动时重新打开上次的文档标签页；未保存内容仍由草稿恢复处理。</small></span>
                <input v-model="localSettings.general.restoreLastFile" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>最近文件数量</b><small>限制最近文件 JSON 列表长度。</small></span>
                <input v-model.number="localSettings.general.recentFilesLimit" class="settings-number" type="number" min="1" max="50" @change="persist" />
              </label>
            </div>
            <div class="settings-group">
              <h4>草稿保存</h4>
              <label class="settings-row">
                <span><b>自动保存草稿</b><small>定时写入 LightMark 私有草稿目录，不直接覆盖原文件。</small></span>
                <input v-model="localSettings.general.autoSave" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>自动保存间隔</b><small>默认 5 分钟，范围 1-60 分钟。</small></span>
                <input
                  v-model.number="localSettings.general.autoSaveIntervalMinutes"
                  class="settings-number"
                  type="number"
                  min="1"
                  max="60"
                  @change="persist"
                />
              </label>
            </div>
          </div>

          <div v-else-if="activeSection === 'editor'" class="settings-stack">
            <div class="settings-group">
              <h4>编辑器</h4>
              <label class="settings-row">
                <span><b>默认编辑模式</b><small>普通文件打开后使用的模式；大文件仍固定为编辑模式。</small></span>
                <select v-model="localSettings.editor.defaultMode" class="select" @change="persist">
                  <option value="wysiwyg">编辑</option>
                  <option value="source">源代码</option>
                </select>
              </label>
              <label class="settings-row">
                <span><b>显示字数与行数</b><small>在底部状态栏显示普通文档字数或大文件行数。</small></span>
                <input v-model="localSettings.editor.showWordCount" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>专注模式</b><small>仅突出当前结构块，其他内容降低至约 30% 不透明度。</small></span>
                <input v-model="localSettings.editor.focusMode" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>打字机模式</b><small>光标离开视口舒适区后，将其平滑校正到垂直中央。</small></span>
                <input v-model="localSettings.editor.typewriterMode" type="checkbox" @change="persist" />
              </label>
            </div>
            <div class="settings-group">
              <h4>数学公式</h4>
              <label class="settings-row">
                <span><b>块级公式自动编号</b><small>默认关闭；手写 \tag 始终优先，AMS 模式按公式块而非 align 行编号。</small></span>
                <select v-model="localSettings.markdown.mathNumbering" class="select" @change="persist">
                  <option value="none">不自动编号</option>
                  <option value="ams-block">AMS 公式块</option>
                  <option value="all-display">所有块级公式</option>
                </select>
              </label>
            </div>
          </div>

          <div v-else-if="activeSection === 'snippets'" class="settings-stack" data-settings-snippets>
            <div class="settings-group">
              <div class="snippet-settings-heading flex items-start justify-between gap-4">
                <div>
                  <h4>全局 Markdown 片段</h4>
                  <p class="mt-1 text-xs text-ink-500 dark:text-ink-300">WYSIWYG 可输入 / 调用；三种编辑模式均可从命令面板插入。</p>
                </div>
                <button class="btn-small" type="button" @click="editSnippet()">新增片段</button>
              </div>
              <div v-if="localSettings.snippets.items.length" class="snippet-settings-list">
                <article v-for="(snippet, index) in localSettings.snippets.items" :key="snippet.id" class="snippet-settings-card">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <b class="truncate text-sm text-ink-900 dark:text-ink-100">{{ snippet.name }}</b>
                      <code class="snippet-trigger">/{{ snippet.trigger }}</code>
                    </div>
                    <p class="mt-1 truncate text-xs text-ink-500 dark:text-ink-300">{{ snippet.description || "无描述" }}</p>
                  </div>
                  <label class="snippet-enable"><span>启用</span><input v-model="snippet.enabled" type="checkbox" @change="toggleSnippet" /></label>
                  <div class="snippet-card-actions">
                    <button type="button" title="上移" :disabled="index === 0" @click="moveSnippet(index, -1)">↑</button>
                    <button type="button" title="下移" :disabled="index === localSettings.snippets.items.length - 1" @click="moveSnippet(index, 1)">↓</button>
                    <button type="button" @click="editSnippet(snippet)">编辑</button>
                    <button type="button" class="danger" @click="removeSnippet(snippet)">删除</button>
                  </div>
                </article>
              </div>
              <div v-else class="settings-empty-state">还没有自定义片段。</div>
            </div>

            <div v-if="snippetDraft" class="settings-group snippet-editor" data-snippet-editor>
              <div class="flex items-center justify-between gap-3">
                <h4>{{ localSettings.snippets.items.some((item) => item.id === snippetDraft?.id) ? "编辑片段" : "新建片段" }}</h4>
                <button class="settings-close" type="button" title="取消" aria-label="取消编辑片段" @click="snippetDraft = null">
                  <UiIcon name="x" :size="16" />
                </button>
              </div>
              <div class="snippet-fields-two">
                <label><span>名称</span><input v-model="snippetDraft.name" class="settings-input" maxlength="80" placeholder="会议纪要" /></label>
                <label><span>触发词</span><input v-model="snippetDraft.trigger" class="settings-input" maxlength="40" placeholder="meeting" /></label>
              </div>
              <label class="snippet-field"><span>描述</span><input v-model="snippetDraft.description" class="settings-input" maxlength="160" placeholder="插入会议标题、日期和待办结构" /></label>
              <label class="snippet-field">
                <span>Markdown 正文</span>
                <textarea v-model="snippetDraft.markdown" class="snippet-markdown-input" rows="9" spellcheck="false" />
              </label>
              <p class="snippet-variable-help"><code>${cursor}</code> 最终光标 · <code>${selection}</code> 当前选区 · <code>${date}</code> 日期 · <code>${time}</code> 时间</p>
              <p v-if="snippetError" class="snippet-error" role="alert">{{ snippetError }}</p>
              <div class="flex justify-end gap-2">
                <button class="btn-small" type="button" @click="snippetDraft = null">取消</button>
                <button class="btn-primary" type="button" @click="saveSnippet">保存片段</button>
              </div>
            </div>
          </div>

          <div v-else-if="activeSection === 'image'" class="settings-stack">
            <div class="settings-group">
              <h4>插入图片</h4>
              <label class="settings-row settings-row-column">
                <span><b>附件目录</b><small>相对于当前 Markdown 文档；不允许绝对路径或“..”。</small></span>
                <input v-model="localSettings.image.assetFolder" class="settings-input" placeholder="assets" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>优先使用相对路径</b><small>文件和 Markdown 在同一磁盘/路径体系内时生成相对引用。</small></span>
                <input v-model="localSettings.image.useRelativePath" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>相对路径强制 ./ 前缀</b><small>类似 Typora 的 Ensure ./ Prefix。</small></span>
                <input v-model="localSettings.image.ensureDotSlash" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>自动转义图片路径</b><small>将空格和中文等字符编码为 URL 形式。</small></span>
                <input v-model="localSettings.image.escapePath" type="checkbox" @change="persist" />
              </label>
            </div>
            <div class="settings-group">
              <h4>剪贴板图片压缩</h4>
              <label class="settings-row">
                <span><b>自动压缩粘贴的大图片</b><small>只处理剪贴板中的 PNG、JPEG 和 WebP；拖放文件保持原样。</small></span>
                <input v-model="localSettings.image.pasteCompressionEnabled" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>体积阈值（MiB）</b><small>超过该体积或最大边长时开始处理。</small></span>
                <input v-model.number="compressionThresholdMiB" class="settings-number" type="number" min="0.25" max="100" step="0.25" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>最大边长（px）</b><small>按比例缩小，不改变图片宽高比。</small></span>
                <input v-model.number="localSettings.image.pasteCompressionMaxDimension" class="settings-number" type="number" min="320" max="8192" step="160" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>JPEG / WebP 质量</b><small>PNG 始终使用无损编码。</small></span>
                <input v-model.number="localSettings.image.pasteCompressionQuality" class="settings-number" type="number" min="40" max="100" step="1" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>粘贴图片命名</b><small>泛化剪贴板名称始终替换为时间名称。</small></span>
                <select v-model="localSettings.image.pastedImageNaming" class="select" @change="persist">
                  <option value="preserve">优先保留原文件名</option>
                  <option value="timestamp">全部使用日期时间</option>
                </select>
              </label>
            </div>
          </div>

          <div v-else-if="activeSection === 'appearance'" class="settings-stack">
            <div class="settings-group">
              <h4>主题与布局</h4>
              <label class="settings-row">
                <span><b>主题</b><small>设置与工具栏昼夜切换保持同步。</small></span>
                <select v-model="localSettings.appearance.theme" class="select" @change="persist">
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </label>
              <label class="settings-row">
                <span><b>编辑区宽度</b><small>控制普通编辑和预览的正文最大宽度。</small></span>
                <input v-model.number="localSettings.appearance.editorWidth" class="settings-number" type="number" min="560" max="1200" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>显示侧栏</b><small>隐藏文件/大纲侧栏，保留主编辑区。</small></span>
                <input v-model="localSettings.appearance.showSidebar" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>显示大纲入口</b><small>控制侧栏中的大纲页入口；文件与反链页不受影响。</small></span>
                <input v-model="localSettings.appearance.showOutline" type="checkbox" @change="persist" />
              </label>
            </div>
            <div class="settings-group">
              <h4>字体与排版</h4>
              <label class="settings-row">
                <span><b>正文字体</b><small>CSS font-family 值。</small></span>
                <input v-model="localSettings.appearance.fontFamily" class="settings-input" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>字号</b><small>12 到 24 px。</small></span>
                <input v-model.number="localSettings.appearance.fontSize" class="settings-number" type="number" min="12" max="24" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>行高</b><small>正文 line-height。</small></span>
                <input v-model.number="localSettings.appearance.lineHeight" class="settings-number" type="number" min="1.2" max="2.4" step="0.1" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>段落间距</b><small>段落 margin，单位 em。</small></span>
                <input v-model.number="localSettings.appearance.paragraphSpacing" class="settings-number" type="number" min="0" max="2" step="0.1" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>代码字体</b><small>源代码模式、代码块和内联代码使用。</small></span>
                <input v-model="localSettings.appearance.codeFontFamily" class="settings-input" @change="persist" />
              </label>
            </div>
          </div>

          <div v-else-if="activeSection === 'export'" class="settings-stack">
            <div class="settings-group">
              <h4>通用</h4>
              <label class="settings-row">
                <span><b>默认导出位置</b><small>保存对话框仍会出现，这里决定初始目录。</small></span>
                <select v-model="localSettings.export.defaultFolder" class="settings-input" @change="persist">
                  <option value="auto">自动</option>
                  <option value="sameFolder">当前文件同目录</option>
                  <option value="custom">自定义目录</option>
                </select>
              </label>
              <label class="settings-row">
                <span><b>自定义目录</b><small>默认导出位置选择“自定义目录”时使用。</small></span>
                <input
                  v-model="localSettings.export.customFolder"
                  class="settings-input"
                  :disabled="localSettings.export.defaultFolder !== 'custom'"
                  @change="persist"
                />
              </label>
              <label class="settings-row">
                <span><b>导出完成后</b><small>选择成功导出后的唯一后续动作。</small></span>
                <select v-model="afterExportAction" class="select" @change="persist">
                  <option value="none">不执行操作</option>
                  <option value="openFile">打开导出文件</option>
                  <option value="revealFolder">在文件管理器中定位</option>
                </select>
              </label>
              <label class="settings-row">
                <span><b>导出 YAML Front Matter</b><small>默认不导出；开启后将文档开头的 YAML 作为可见正文包含在所有导出格式中。</small></span>
                <input v-model="localSettings.export.includeYamlFrontMatter" type="checkbox" @change="persist" />
              </label>
            </div>
            <div class="settings-group">
              <h4>HTML / PNG</h4>
              <label class="settings-row">
                <span><b>HTML 包含样式</b><small>关闭后导出不附带 LightMark 内置主题样式。</small></span>
                <input v-model="localSettings.export.htmlIncludeStyles" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>HTML 主题</b><small>第一版导出样式以 LightMark 内置主题为准。</small></span>
                <select v-model="localSettings.export.htmlTheme" class="settings-input" @change="persist">
                  <option value="current">跟随当前主题</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </label>
            </div>
            <div class="settings-group">
              <h4>Pandoc / PDF / Word</h4>
              <label class="settings-row">
                <span><b>优先使用内置 Pandoc</b><small>LightMark 会先使用随应用提供的 Pandoc；填写自定义路径时自定义路径优先。</small></span>
                <input v-model="localSettings.export.preferBundledPandoc" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>Pandoc 路径</b><small>留空时使用内置 Pandoc 或 PATH 中的 pandoc。</small></span>
                <input v-model="localSettings.export.pandocPath" class="settings-input" @change="persist" />
              </label>
              <div class="settings-row">
                <span>
                  <b>Pandoc 状态</b>
                  <small>{{ pandocStatus?.available ? `${pandocStatus.version} · ${pandocStatus.source} · ${pandocStatus.path}` : "未检测到 Pandoc" }}</small>
                </span>
                <button class="btn-small" @click="refreshPandocStatus">重新检测</button>
              </div>
              <label class="settings-row">
                <span><b>PDF Engine</b><small>默认 xelatex，适合中文；也可填 wkhtmltopdf、weasyprint 等。</small></span>
                <input v-model="localSettings.export.pdfEngine" class="settings-input" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>PDF 纸张</b><small>传递给 Pandoc 变量 papersize。</small></span>
                <input v-model="localSettings.export.pdfPaperSize" class="settings-input" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>PDF 边距</b><small>传递给 Pandoc 变量 margin，例如 20mm。</small></span>
                <input v-model="localSettings.export.pdfMargin" class="settings-input" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>DOCX 样式参考文档</b><small>对应 Pandoc --reference-doc。</small></span>
                <input v-model="localSettings.export.docxReferenceDoc" class="settings-input" @change="persist" />
              </label>
            </div>
            <div class="settings-group">
              <h4>EPUB / 自定义 Pandoc</h4>
              <label class="settings-row">
                <span><b>EPUB 封面图片</b><small>对应 Pandoc --epub-cover-image。</small></span>
                <input v-model="localSettings.export.epubCoverImage" class="settings-input" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>EPUB CSS</b><small>对应 Pandoc --css。</small></span>
                <input v-model="localSettings.export.epubCss" class="settings-input" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>Custom Pandoc 格式</b><small>对应 Pandoc --to；留空时由输出扩展名推断。</small></span>
                <input v-model="localSettings.export.customPandocFormat" class="settings-input" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>Custom Pandoc 扩展名</b><small>例如 .html、.typ、.asciidoc。</small></span>
                <input v-model="localSettings.export.customPandocExtension" class="settings-input" @change="persist" />
              </label>
              <label class="settings-row">
                <span><b>Custom Pandoc 额外参数</b><small>支持简单引号分组，例如 --toc --metadata title="Demo"。</small></span>
                <input v-model="localSettings.export.customPandocArgs" class="settings-input" @change="persist" />
              </label>
              <p class="settings-note">自定义 shell 命令和 YAML 覆盖导出设置暂不启用；Pandoc 导出会显示失败命令和 stderr，便于排查。</p>
            </div>
          </div>

          <div v-else-if="activeSection === 'shortcuts'" class="settings-stack">
            <div class="settings-group">
              <h4>当前快捷键</h4>
              <div class="settings-table">
                <div class="settings-table-row settings-table-head"><span>命令</span><span>快捷键</span></div>
                <div v-for="row in shortcutRows" :key="row.command" class="settings-table-row"><span>{{ row.command }}</span><span>{{ row.shortcut }}</span></div>
              </div>
            </div>
          </div>

          <div v-else class="settings-stack experimental-stack">
            <div class="settings-intro">
              这些能力尚未接入，不会显示无效开关。对应配置字段继续保留，以便未来版本兼容启用。
              括号、方括号、引号与 Markdown 符号自动配对已作为默认编辑行为启用，因此不列在实验能力中。
            </div>
            <div v-for="group in experimentalGroups" :key="group.title" class="experimental-card">
              <div class="experimental-card-header">
                <h4>{{ group.title }}</h4>
                <span>尚未接入</span>
              </div>
              <ul>
                <li v-for="item in group.items" :key="item">{{ item }}</li>
              </ul>
              <p v-if="group.note">{{ group.note }}</p>
            </div>
          </div>
        </main>
      </div>
    </section>
  </div>
</template>

<style scoped>
.lm-settings-panel > aside {
  border-color: var(--lm-border);
  background: var(--lm-sidebar);
}

.lm-settings-panel > div > header {
  border-color: var(--lm-border);
  background: color-mix(in srgb, var(--lm-surface-raised) 94%, transparent);
}

.lm-settings-panel > div > main { background: var(--lm-surface); }

.settings-close {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--lm-radius-sm);
  background: transparent;
  color: var(--lm-ink-muted);
  cursor: pointer;
}

.settings-close:hover { background: var(--lm-accent-soft); color: var(--lm-ink); }
.settings-close:focus-visible { border-color: var(--lm-border-strong); box-shadow: 0 0 0 3px var(--lm-focus); }

.settings-stack {
  display: grid;
  gap: 18px;
}

.settings-group {
  border: 1px solid var(--lm-border);
  border-radius: var(--lm-radius-md);
  background: var(--lm-surface-raised);
  overflow: hidden;
  box-shadow: var(--lm-shadow-sm);
}

.dark .settings-group {
  border-color: var(--lm-border);
  background: var(--lm-surface-raised);
}

.settings-group h4 {
  margin: 0;
  padding: 12px 14px;
  border-bottom: 1px solid var(--lm-border);
  color: inherit;
  font-size: 13px;
  font-weight: 700;
}

.dark .settings-group h4 {
  border-color: var(--lm-border);
}

.settings-row {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--lm-border);
  color: inherit;
}

.dark .settings-row {
  border-color: var(--lm-border);
}

.settings-row:last-child {
  border-bottom: 0;
}

.settings-row span {
  min-width: 0;
}

.settings-row b {
  display: block;
  font-size: 14px;
  font-weight: 600;
}

.settings-row small,
.settings-note {
  display: block;
  margin-top: 3px;
  color: var(--lm-ink-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dark .settings-row small,
.dark .settings-note {
  color: var(--lm-ink-muted);
}

.settings-input,
.settings-number {
  width: 240px;
  border: 1px solid var(--lm-border-strong);
  border-radius: var(--lm-radius-sm);
  background: var(--lm-surface);
  padding: 6px 8px;
  color: inherit;
  font-size: 13px;
  outline: none;
}

.settings-number {
  width: 96px;
}

.settings-input:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.dark .settings-input,
.dark .settings-number {
  border-color: var(--lm-border-strong);
  background: var(--lm-surface);
}

.settings-input:focus,
.settings-number:focus { border-color: var(--lm-accent); box-shadow: 0 0 0 3px var(--lm-focus); }

.settings-note {
  margin: 0;
  padding: 12px 14px;
}

.settings-table {
  padding: 8px 14px 14px;
}

.settings-table-row {
  display: grid;
  grid-template-columns: 1fr 160px;
  gap: 16px;
  padding: 7px 0;
  border-bottom: 1px solid var(--lm-border);
  font-size: 13px;
}

.dark .settings-table-row {
  border-color: var(--lm-border);
}

.settings-table-row:last-child {
  border-bottom: 0;
}

.settings-table-head {
  color: var(--lm-ink-muted);
  font-size: 12px;
  font-weight: 700;
}

.settings-intro {
  border: 1px solid var(--lm-border);
  border-radius: var(--lm-radius-md);
  background: var(--lm-accent-soft);
  padding: 12px 14px;
  color: var(--lm-ink-soft);
  font-size: 13px;
  line-height: 1.6;
}

.experimental-card {
  border: 1px solid var(--lm-border);
  border-radius: var(--lm-radius-md);
  background: var(--lm-surface-raised);
  padding: 14px;
  box-shadow: var(--lm-shadow-sm);
}

.experimental-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.experimental-card h4 { margin: 0; font-size: 14px; font-weight: 650; }
.experimental-card-header span { border: 1px solid var(--lm-border); border-radius: 999px; padding: 2px 7px; color: var(--lm-ink-muted); font-size: 11px; }
.experimental-card ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 18px; margin: 12px 0 0; padding: 0; list-style: none; }
.experimental-card li { position: relative; padding-left: 13px; color: var(--lm-ink-soft); font-size: 13px; }
.experimental-card li::before { position: absolute; left: 0; top: 0.55em; width: 4px; height: 4px; border-radius: 50%; background: var(--lm-ink-muted); content: ""; }
.experimental-card p { margin: 11px 0 0; border-top: 1px solid var(--lm-border); padding-top: 10px; color: var(--lm-ink-muted); font-size: 12px; line-height: 1.55; }

.snippet-settings-list { display: grid; gap: 8px; padding: 0 14px 14px; }
.snippet-settings-heading { padding: 12px 14px; }
.settings-group .snippet-settings-heading h4 { border: 0; padding: 0; }
.snippet-settings-card { display: flex; align-items: center; gap: 12px; border: 1px solid var(--lm-border); border-radius: var(--lm-radius-sm); padding: 10px; background: var(--lm-surface); }
.snippet-trigger { flex: none; border-radius: 5px; padding: 1px 6px; color: var(--lm-ink-muted); background: var(--lm-accent-soft); font-size: 11px; }
.snippet-enable { display: inline-flex; align-items: center; gap: 5px; color: var(--lm-ink-muted); font-size: 11px; }
.snippet-card-actions { display: flex; flex: none; gap: 4px; }
.snippet-card-actions button { min-width: 28px; border-radius: 5px; padding: 4px 7px; color: var(--lm-ink-muted); font-size: 12px; }
.snippet-card-actions button:hover:not(:disabled) { background: var(--lm-accent-soft); color: var(--lm-ink); }
.snippet-card-actions button:disabled { opacity: .35; }
.snippet-card-actions .danger { color: #b64b47; }
.settings-empty-state { margin: 0 14px 14px; border: 1px dashed var(--lm-border); border-radius: var(--lm-radius-sm); padding: 20px; text-align: center; color: var(--lm-ink-muted); font-size: 13px; }
.snippet-editor { padding: 14px; overflow: visible; }
.snippet-editor h4, .snippet-settings-list + h4 { border: 0; padding: 0; }
.snippet-fields-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .7fr); gap: 12px; margin-top: 12px; }
.snippet-fields-two label, .snippet-field { display: grid; gap: 6px; color: var(--lm-ink-muted); font-size: 12px; }
.snippet-field { margin-top: 12px; }
.snippet-fields-two .settings-input, .snippet-field .settings-input { width: 100%; }
.snippet-markdown-input { width: 100%; resize: vertical; border: 1px solid var(--lm-border-strong); border-radius: var(--lm-radius-sm); background: var(--lm-surface); padding: 9px 10px; color: var(--lm-ink); font-family: var(--lm-editor-code-font-family); font-size: 12px; line-height: 1.55; outline: none; }
.snippet-markdown-input:focus { border-color: var(--lm-accent); box-shadow: 0 0 0 3px var(--lm-focus); }
.snippet-variable-help { margin: 10px 0; color: var(--lm-ink-muted); font-size: 11px; }
.snippet-variable-help code { margin-right: 2px; color: var(--lm-ink); }
.snippet-error { margin: 8px 0; color: #b64b47; font-size: 12px; }

@media (max-width: 960px) {
  .experimental-card ul { grid-template-columns: 1fr; }
  .snippet-settings-card { align-items: flex-start; flex-wrap: wrap; }
  .snippet-card-actions { width: 100%; justify-content: flex-end; }
  .snippet-fields-two { grid-template-columns: 1fr; }
}
</style>
