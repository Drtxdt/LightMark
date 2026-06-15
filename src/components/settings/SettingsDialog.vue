<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { appStore, defaultSettings, resetSettings, updateSettings } from "../../stores/appStore";
import type { AppSettings } from "../../types";

type SettingsSection =
  | "general"
  | "editor"
  | "markdown"
  | "image"
  | "appearance"
  | "export"
  | "shortcuts"
  | "advanced";

const activeSection = ref<SettingsSection>("general");
const localSettings = ref<AppSettings>(cloneSettings(appStore.settings));
const saveState = ref("");

const sections: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "general", label: "基础", description: "启动、自动保存、语言和拼写" },
  { id: "editor", label: "编辑体验", description: "输入、粘贴、编辑模式" },
  { id: "markdown", label: "Markdown", description: "语法能力与兼容模式" },
  { id: "image", label: "图片与资源", description: "拖拽、粘贴和路径格式" },
  { id: "appearance", label: "外观", description: "主题、字体和编辑区" },
  { id: "export", label: "导出", description: "HTML 和未来 Pandoc 导出" },
  { id: "shortcuts", label: "快捷键", description: "命令列表和快捷键预留" },
  { id: "advanced", label: "高级", description: "配置、调试和实验功能" },
];

const shortcutRows = [
  { command: "保存", shortcut: "Ctrl+S" },
  { command: "命令面板", shortcut: "Ctrl+Shift+P" },
  { command: "切换编辑/源代码", shortcut: "命令面板" },
  { command: "打开设置", shortcut: "工具栏按钮" },
  { command: "插入 GitHub 风格警示框", shortcut: "右键菜单" },
];

const activeSectionTitle = computed(() => sections.find((section) => section.id === activeSection.value)?.label ?? "");

watch(
  () => appStore.settings,
  (settings) => {
    localSettings.value = cloneSettings(settings);
  },
  { deep: true },
);

async function persist() {
  try {
    saveState.value = "正在保存...";
    await updateSettings(cloneSettings(localSettings.value));
    saveState.value = "已保存";
    window.setTimeout(() => {
      if (saveState.value === "已保存") saveState.value = "";
    }, 1200);
  } catch (error) {
    saveState.value = String(error);
  }
}

async function resetAll() {
  if (!window.confirm("重置所有设置？最近文件列表会保留。")) return;
  localSettings.value = defaultSettings();
  await resetSettings();
}

function close() {
  appStore.settingsOpen = false;
}

function cloneSettings(settings: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(settings)) as AppSettings;
}
</script>

<template>
  <div class="fixed inset-0 z-50 bg-ink-900/20 p-6 backdrop-blur-[1px]" @click.self="close">
    <section
      class="mx-auto flex h-[min(760px,calc(100vh-48px))] max-w-5xl overflow-hidden rounded-lg border border-paper-200 bg-paper-50 shadow-[0_22px_70px_rgba(31,30,27,0.18)] dark:border-paper-800 dark:bg-paper-950"
      role="dialog"
      aria-modal="true"
      aria-label="偏好设置"
      @keydown.esc="close"
    >
      <aside class="w-56 flex-none border-r border-paper-200 bg-paper-100/70 p-3 dark:border-paper-800 dark:bg-paper-900">
        <div class="mb-3 px-2">
          <h2 class="text-base font-semibold text-ink-900 dark:text-ink-100">偏好设置</h2>
          <p class="mt-1 text-xs text-ink-500 dark:text-ink-300">覆盖 Typora 设置体系，灰置项暂未支持。</p>
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
            <span class="text-xs text-ink-500 dark:text-ink-300">{{ saveState }}</span>
            <button class="btn-small" @click="resetAll">重置设置</button>
            <button class="btn" @click="close">关闭</button>
          </div>
        </header>

        <main class="min-h-0 flex-1 overflow-auto px-6 py-5">
          <div v-if="activeSection === 'general'" class="settings-stack">
            <div class="settings-group">
              <h4>启动</h4>
              <label class="settings-row disabled-row">
                <span><b>启动时</b><small>Typora 支持恢复窗口或打开指定文件夹；LightMark 暂未接入启动恢复。</small></span>
                <select v-model="localSettings.general.launchBehavior" class="select" disabled>
                  <option value="blank">打开空白编辑器</option>
                  <option value="restoreLastSession">恢复上次会话</option>
                  <option value="openWorkspace">打开默认工作区</option>
                </select>
              </label>
              <label class="settings-row">
                <span><b>最近文件数量</b><small>限制最近文件 JSON 列表长度。</small></span>
                <input v-model.number="localSettings.general.recentFilesLimit" class="settings-number" type="number" min="1" max="50" @change="persist" />
              </label>
            </div>
            <div class="settings-group">
              <h4>保存与语言</h4>
              <label class="settings-row disabled-row">
                <span><b>自动保存</b><small>Typora Windows/Linux 支持定时自动保存；LightMark 暂未启用后台保存。</small></span>
                <input v-model="localSettings.general.autoSave" type="checkbox" disabled />
              </label>
              <label class="settings-row disabled-row">
                <span><b>自动保存间隔</b><small>Typora 默认 5 分钟。</small></span>
                <input v-model.number="localSettings.general.autoSaveIntervalMinutes" class="settings-number" type="number" disabled />
              </label>
              <label class="settings-row disabled-row">
                <span><b>拼写检查</b><small>保留 Typora 的拼写检查入口，后续接系统拼写或 Hunspell。</small></span>
                <input v-model="localSettings.general.spellcheck" type="checkbox" disabled />
              </label>
              <label class="settings-row disabled-row">
                <span><b>界面语言</b><small>当前界面固定为中文。</small></span>
                <select v-model="localSettings.general.language" class="select" disabled>
                  <option value="system">跟随系统</option>
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
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
              <label class="settings-row disabled-row">
                <span><b>自动配对括号和引号</b><small>Typora 式普通自动配对，后续接入输入规则。</small></span>
                <input v-model="localSettings.editor.autoPairBrackets" type="checkbox" disabled />
              </label>
              <label class="settings-row disabled-row">
                <span><b>自动配对 Markdown 符号</b><small>包括 *、_、`、~、$、=、^ 等扩展符号。</small></span>
                <input v-model="localSettings.editor.autoPairMarkdownSyntax" type="checkbox" disabled />
              </label>
              <label class="settings-row disabled-row">
                <span><b>焦点模式</b><small>Typora 视图能力预留。</small></span>
                <input v-model="localSettings.editor.focusMode" type="checkbox" disabled />
              </label>
              <label class="settings-row disabled-row">
                <span><b>打字机模式</b><small>Typora 视图能力预留。</small></span>
                <input v-model="localSettings.editor.typewriterMode" type="checkbox" disabled />
              </label>
            </div>
          </div>

          <div v-else-if="activeSection === 'markdown'" class="settings-stack">
            <div class="settings-group">
              <h4>语法支持</h4>
              <label class="settings-row disabled-row">
                <span><b>严格模式</b><small>Typora 可更严格贴近 GFM；LightMark 当前保持兼容解析。</small></span>
                <input v-model="localSettings.markdown.strictMode" type="checkbox" disabled />
              </label>
              <label class="settings-row" v-for="item in [
                ['inlineHtml', '内联 HTML', '渲染并安全过滤常见内联 HTML。'],
                ['blockHtml', '块级 HTML', '渲染并安全过滤块级 HTML。'],
                ['math', '数学公式', '支持行内和块级 LaTeX。'],
                ['mermaid', 'Mermaid 图表', '支持 mermaid 代码块渲染。'],
                ['footnotes', '脚注', '支持脚注定义与引用。'],
                ['toc', 'TOC', '支持 [TOC] 目录节点。'],
                ['taskList', '任务列表', '支持 GitHub 风格任务列表。'],
                ['githubAlerts', 'GitHub 警示框', '支持 [!NOTE]、[!TIP] 等警示框。'],
                ['yamlFrontMatter', 'YAML Front Matter', '识别文档元数据块。'],
                ['smartPunctuation', '智能标点', 'markdown-it typographer。'],
                ['subscript', '下标', '支持 ~sub~。'],
                ['superscript', '上标', '支持 ^sup^。'],
                ['highlight', '高亮', '支持 ==mark==。'],
              ]" :key="item[0]">
                <span><b>{{ item[1] }}</b><small>{{ item[2] }}</small></span>
                <input v-model="(localSettings.markdown as any)[item[0]]" type="checkbox" @change="persist" />
              </label>
            </div>
          </div>

          <div v-else-if="activeSection === 'image'" class="settings-stack">
            <div class="settings-group">
              <h4>插入图片</h4>
              <label class="settings-row">
                <span><b>拖拽本地图片时</b><small>默认只写入引用，符合当前 LightMark 行为。</small></span>
                <select v-model="localSettings.image.insertBehavior" class="select" @change="persist">
                  <option value="reference">写入原文件引用</option>
                  <option value="copyToAssets" disabled>复制到资源目录（暂未支持）</option>
                </select>
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
              <label class="settings-row disabled-row">
                <span><b>资源目录</b><small>剪贴板图片当前保存到 Markdown 同级 assets。</small></span>
                <input v-model="localSettings.image.assetFolder" class="settings-input" disabled />
              </label>
              <label class="settings-row disabled-row">
                <span><b>图片根路径</b><small>Typora 的 typora-root-url 兼容项预留。</small></span>
                <input v-model="localSettings.image.rootUrl" class="settings-input" disabled placeholder="例如 /blog/" />
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
                <span><b>显示大纲</b><small>关闭后侧栏只显示文件页。</small></span>
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
              <h4>HTML 导出</h4>
              <label class="settings-row disabled-row">
                <span><b>默认导出位置</b><small>LightMark 当前仍使用保存对话框。</small></span>
                <select v-model="localSettings.export.defaultFolder" class="select" disabled>
                  <option value="auto">自动</option>
                  <option value="sameFolder">当前文件同目录</option>
                  <option value="custom">自定义目录</option>
                </select>
              </label>
              <label class="settings-row">
                <span><b>HTML 包含样式</b><small>当前导出使用内置样式；关闭项预留给无样式 HTML。</small></span>
                <input v-model="localSettings.export.htmlIncludeStyles" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row disabled-row">
                <span><b>允许 YAML 覆盖导出设置</b><small>Typora 兼容项，后续用于 per-file export config。</small></span>
                <input v-model="localSettings.export.allowYamlOverride" type="checkbox" disabled />
              </label>
            </div>
            <div class="settings-group">
              <h4>Pandoc / PDF / Word</h4>
              <label class="settings-row disabled-row">
                <span><b>Pandoc 路径</b><small>Word、PDF、EPUB、LaTeX 等导出预留。</small></span>
                <input v-model="localSettings.export.pandocPath" class="settings-input" disabled />
              </label>
              <p class="settings-note">PDF、Word、OpenOffice、RTF、EPUB、LaTeX、Wiki、RST、Textile、OPML、RevealJS 和自定义命令导出先在 UI 中占位，等导出链路实现后再启用。</p>
            </div>
          </div>

          <div v-else-if="activeSection === 'shortcuts'" class="settings-stack">
            <div class="settings-group">
              <h4>快捷键</h4>
              <label class="settings-row disabled-row">
                <span><b>自定义快捷键</b><small>Typora 支持自定义 key binding；LightMark 第一版只展示命令列表。</small></span>
                <input v-model="localSettings.shortcuts.customKeybindings" type="checkbox" disabled />
              </label>
              <div class="settings-table">
                <div class="settings-table-row settings-table-head"><span>命令</span><span>快捷键</span></div>
                <div v-for="row in shortcutRows" :key="row.command" class="settings-table-row"><span>{{ row.command }}</span><span>{{ row.shortcut }}</span></div>
              </div>
            </div>
          </div>

          <div v-else class="settings-stack">
            <div class="settings-group">
              <h4>高级</h4>
              <label class="settings-row">
                <span><b>调试模式</b><small>仅写入 JSON，后续用于显示日志和诊断信息。</small></span>
                <input v-model="localSettings.advanced.debugMode" type="checkbox" @change="persist" />
              </label>
              <label class="settings-row disabled-row">
                <span><b>实验性功能</b><small>预留给不稳定能力的统一入口。</small></span>
                <input v-model="localSettings.advanced.experimentalFeatures" type="checkbox" disabled />
              </label>
              <p class="settings-note">配置文件存放在 Tauri app config 目录的 config.json 中。当前版本会自动迁移旧版 theme 字段。</p>
            </div>
          </div>
        </main>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-stack {
  display: grid;
  gap: 18px;
}

.settings-group {
  border: 1px solid rgb(224 220 212);
  border-radius: 8px;
  background: rgb(255 254 251 / 70%);
  overflow: hidden;
}

.dark .settings-group {
  border-color: rgb(52 49 45);
  background: rgb(31 30 27 / 38%);
}

.settings-group h4 {
  margin: 0;
  padding: 12px 14px;
  border-bottom: 1px solid rgb(224 220 212);
  color: inherit;
  font-size: 13px;
  font-weight: 700;
}

.dark .settings-group h4 {
  border-color: rgb(52 49 45);
}

.settings-row {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 10px 14px;
  border-bottom: 1px solid rgb(237 234 228);
  color: inherit;
}

.dark .settings-row {
  border-color: rgb(43 40 37);
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
  color: rgb(117 111 102);
  font-size: 12px;
  line-height: 1.45;
}

.dark .settings-row small,
.dark .settings-note {
  color: rgb(185 179 168);
}

.disabled-row {
  opacity: 0.55;
}

.settings-input,
.settings-number {
  width: 240px;
  border: 1px solid rgb(224 220 212);
  border-radius: 6px;
  background: rgb(251 250 247);
  padding: 6px 8px;
  color: inherit;
  font-size: 13px;
  outline: none;
}

.settings-number {
  width: 96px;
}

.dark .settings-input,
.dark .settings-number {
  border-color: rgb(52 49 45);
  background: rgb(31 30 27);
}

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
  border-bottom: 1px solid rgb(237 234 228);
  font-size: 13px;
}

.dark .settings-table-row {
  border-color: rgb(43 40 37);
}

.settings-table-row:last-child {
  border-bottom: 0;
}

.settings-table-head {
  color: rgb(117 111 102);
  font-size: 12px;
  font-weight: 700;
}
</style>
