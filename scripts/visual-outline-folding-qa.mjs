import fs from "node:fs";
import path from "node:path";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("Usage: node scripts/visual-outline-folding-qa.mjs <output-dir>");
fs.mkdirSync(outputDir, { recursive: true });

const cdpPort = process.env.LIGHTMARK_CDP_PORT || "9333";
const pages = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((response) => response.json());
const page = pages.find((item) => item.url.includes("outline-qa=1"))
  || pages.find((item) => /^http:\/\/(?:127\.0\.0\.1|localhost):1420\//.test(item.url));
if (!page) throw new Error("LightMark Edge page not found.");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const callbacks = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) callbacks.reject(new Error(message.error.message));
  else callbacks.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const nextId = ++id;
  pending.set(nextId, { resolve, reject });
  ws.send(JSON.stringify({ id: nextId, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description || ""}`);
  }
  return result.result.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshot = async (name) => {
  const result = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(path.join(outputDir, name), Buffer.from(result.data, "base64"));
};
const clickAt = async ({ x, y }) => {
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 780, deviceScaleFactor: 1, mobile: false });
await wait(1200);

const markdown = [
  "---",
  "title: Outline QA",
  "tags: [outline, visual]",
  "---",
  "# 第一章",
  "第一章开场段落，用于检查标题折叠后正文是否完全隐藏。",
  "",
  "### 跳级三级标题",
  "跳级标题正文。",
  "",
  "#### 四级标题",
  "- 列表第一项",
  "- 列表第二项",
  "",
  "##### 五级标题",
  "五级正文包含 **粗体** 和 $x^2 + y^2$。",
  "",
  "###### 六级标题",
  "六级正文。",
  "",
  "## 重复标题",
  "第一个重复标题正文。",
  "",
  "## 重复标题",
  "第二个重复标题正文。",
  "",
  "# 结尾章节",
  "结尾正文。",
].join("\n");

await evaluate(`(async () => {
  window.__savedConfig = null;
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === 'write_app_config') {
        window.__savedConfig = args.config;
        return null;
      }
      if (cmd === 'read_app_config') return { recentFiles: [], settings: {} };
      return null;
    },
  };
  const store = await import('/src/stores/appStore.ts');
  window.__outlineStore = store;
  if (store.appStore.splitLayout.enabled) await store.toggleSplitLayout();
  await store.setActivePane('main');
  store.appStore.settings.editor.focusMode = false;
  store.appStore.settings.editor.typewriterMode = false;
  window.dispatchEvent(new CustomEvent('lightmark:writing-modes-changed'));
  store.setContent(${JSON.stringify(markdown)});
  const tab = store.getPaneTab('main');
  if (tab) {
    tab.path = 'E:/qa/outline.md';
    tab.name = 'outline.md';
    tab.kind = 'normal';
    tab.collapsedOutlineKeys = [];
    tab.collapsedHeadingKeys = [];
  }
  store.appStore.currentFilePath = 'E:/qa/outline.md';
  await store.setTheme('light').catch(() => {});
  store.updatePaneOutlineAnchor('main', 10, 'selection');
  store.switchMode('source');
  return true;
})()`);
await wait(1200);
await evaluate(`(() => {
  window.__outlineStore.updatePaneOutlineAnchor('main', 10, 'selection');
  return true;
})()`);
await evaluate(`(() => {
  const button = Array.from(document.querySelectorAll('.sidebar-switch')).find((item) => item.textContent.includes('大纲'));
  button?.click();
  return Boolean(button);
})()`);
await wait(120);
const h4LinePoint = await evaluate(`(() => {
  const line = Array.from(document.querySelectorAll('.cm-line')).find((item) => item.textContent.includes('四级标题'));
  if (!line) throw new Error('H4 source line missing');
  const rect = line.getBoundingClientRect();
  return { x: rect.left + Math.min(120, rect.width / 2), y: rect.top + rect.height / 2 };
})()`);
await clickAt(h4LinePoint);
await wait(400);
await screenshot("outline-follow-light-1200x780.png");

const followMetrics = await evaluate(`(() => ({
  rows: document.querySelectorAll('.outline-row').length,
  activeText: document.querySelector('.outline-row.active .outline-item')?.textContent.trim(),
  activeVisible: Boolean(document.querySelector('.outline-row.active')),
  anchorLine: window.__outlineStore.appStore.paneOutlineAnchorLines.main,
  anchorSource: window.__outlineStore.appStore.paneOutlineAnchorSources.main,
  activePaneId: window.__outlineStore.appStore.splitLayout.activePaneId,
  resolvedText: window.__outlineStore.getPaneStructuredOutline('main').filter((item) => item.line <= window.__outlineStore.appStore.paneOutlineAnchorLines.main).at(-1)?.text,
  h4ToH6: Array.from(document.querySelectorAll('.outline-row .outline-item')).map((item) => item.textContent.trim()).filter((text) => /四级|五级|六级/.test(text)),
  viewport: [innerWidth, innerHeight],
}))()`);

await evaluate(`(() => {
  const firstDisclosure = document.querySelector('.outline-row .outline-disclosure');
  firstDisclosure?.click();
  return true;
})()`);
await wait(250);
const treeFoldMetrics = await evaluate(`(async () => {
  const store = window.__outlineStore;
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    visibleRows: Array.from(document.querySelectorAll('.outline-row .outline-item')).map((item) => item.textContent.trim()),
    collapsedKeys: store.getPaneTab('main')?.collapsedOutlineKeys.length,
    persistedOutlineKeys: window.__savedConfig?.session?.openTabs?.[0]?.collapsedOutlineKeys?.length ?? 0,
  };
})()`);
await screenshot("outline-tree-collapsed-light-1200x780.png");

await evaluate(`(async () => {
  const store = window.__outlineStore;
  store.setAllPaneOutlineFolds('main', false);
  store.switchMode('wysiwyg');
  return true;
})()`);
await wait(1000);
await evaluate(`(() => {
  window.dispatchEvent(new CustomEvent('lightmark:writing-modes-changed'));
  return true;
})()`);
await wait(160);
const wysiwygBefore = await evaluate(`(() => ({
  toggles: document.querySelectorAll('.ProseMirror .lm-heading-fold-toggle').length,
  h4ToH6: document.querySelectorAll('.ProseMirror h4,.ProseMirror h5,.ProseMirror h6').length,
  content: document.querySelector('.ProseMirror')?.textContent,
}))()`);
await evaluate(`(() => {
  const button = document.querySelector('.ProseMirror .lm-heading-fold-toggle');
  if (!button) throw new Error('WYSIWYG heading fold button missing');
  button.click();
  return true;
})()`);
await wait(350);
await screenshot("heading-fold-wysiwyg-light-1200x780.png");
const wysiwygFoldMetrics = await evaluate(`(async () => {
  const store = window.__outlineStore;
  return {
    hiddenBlocks: document.querySelectorAll('.ProseMirror .lm-heading-fold-hidden').length,
    summary: document.querySelector('.ProseMirror .lm-heading-fold-summary')?.textContent.trim(),
    collapsedHeadingKeys: store.getPaneTab('main')?.collapsedHeadingKeys.length,
    markdownUnchanged: store.getPaneContent('main') === ${JSON.stringify(markdown)},
    persistedHeadingKeys: window.__savedConfig?.session?.openTabs?.[0]?.collapsedHeadingKeys?.length ?? 0,
    dirty: store.getPaneTab('main')?.isDirty,
  };
})()`);

await evaluate(`(async () => {
  const store = window.__outlineStore;
  store.switchMode('source');
  return true;
})()`);
await wait(900);
await screenshot("heading-fold-source-light-1200x780.png");
const sourceMetrics = await evaluate(`(() => ({
  gutterToggles: document.querySelectorAll('.cm-heading-fold-toggle').length,
  collapsedGutterToggles: document.querySelectorAll('.cm-heading-fold-toggle.collapsed').length,
  placeholder: document.querySelector('.cm-heading-fold-placeholder')?.textContent.trim(),
  sourceMode: Boolean(document.querySelector('.cm-editor')),
}))()`);
const sourceGutterPoint = await evaluate(`(() => {
  const marker = document.querySelector('.cm-heading-fold-toggle.collapsed');
  if (!marker) throw new Error('Collapsed source gutter marker missing');
  const rect = marker.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`);
const sourceGutterHit = await evaluate(`(() => {
  const point = ${JSON.stringify({})};
  const marker = document.querySelector('.cm-heading-fold-toggle.collapsed');
  const rect = marker.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return { markerRect: [rect.x, rect.y, rect.width, rect.height], hitClass: hit?.className || '', hitTag: hit?.tagName || '' };
})()`);
await clickAt(sourceGutterPoint);
await wait(220);
const sourceGutterInteraction = await evaluate(`(() => {
  const expandedByPointer = !document.querySelector('.cm-heading-fold-toggle.collapsed');
  if (!expandedByPointer) document.querySelector('.cm-heading-fold-toggle.collapsed')?.click();
  return {
    expandedByPointer,
    expandedByDomClick: !document.querySelector('.cm-heading-fold-toggle.collapsed'),
    placeholderRemoved: !document.querySelector('.cm-heading-fold-placeholder'),
  };
})()`);
await clickAt(sourceGutterPoint);
await wait(220);
await evaluate(`(() => {
  if (!document.querySelector('.cm-heading-fold-toggle.collapsed')) {
    document.querySelector('.cm-heading-fold-toggle')?.click();
  }
  return true;
})()`);

await evaluate(`(() => {
  window.dispatchEvent(new CustomEvent('lightmark:jump-heading', {
    detail: { line: 10, text: '四级标题', paneId: 'main' },
  }));
  return true;
})()`);
await wait(350);
const navigationMetrics = await evaluate(`(async () => {
  const store = window.__outlineStore;
  return {
    collapsedAfterReveal: store.getPaneTab('main')?.collapsedHeadingKeys.length,
    anchorLine: store.appStore.paneOutlineAnchorLines.main,
    mode: store.getPaneEditorMode('main'),
  };
})()`);

await call("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
await evaluate(`(async () => {
  const store = window.__outlineStore;
  await store.setTheme('dark').catch(() => {});
  store.switchMode('wysiwyg');
  return true;
})()`);
await wait(700);
await evaluate(`(() => {
  window.dispatchEvent(new CustomEvent('lightmark:writing-modes-changed'));
  return true;
})()`);
await wait(180);
await screenshot("outline-heading-dark-900x600.png");
const narrowMetrics = await evaluate(`(() => {
  const sidebar = document.querySelector('.lm-sidebar');
  const editor = document.querySelector('.ProseMirror');
  const toggle = document.querySelector('.ProseMirror .lm-heading-fold-toggle');
  const sidebarRect = sidebar.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const toggleRect = toggle.getBoundingClientRect();
  return {
    viewport: [innerWidth, innerHeight],
    sidebarFits: sidebar.scrollWidth <= sidebar.clientWidth,
    toggleReachable: toggleRect.left >= editorRect.left - 36 && toggleRect.right <= editorRect.right,
    noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
    sidebarWidth: Math.round(sidebarRect.width),
    focusMode: window.__outlineStore.appStore.settings.editor.focusMode,
    dimmedBlocks: document.querySelectorAll('.ProseMirror .lm-focus-dimmed').length,
  };
})()`);

await evaluate(`(async () => {
  const store = window.__outlineStore;
  await store.toggleSplitLayout();
  store.setPaneContent('secondary', ${JSON.stringify(markdown)}, false);
  store.updatePaneOutlineAnchor('main', 4, 'selection');
  store.updatePaneOutlineAnchor('secondary', 24, 'selection');
  await store.setActivePane('secondary');
  return true;
})()`);
await wait(500);
const splitMetrics = await evaluate(`(() => ({
  activePane: document.querySelector('.lm-editor-pane.active') === document.querySelectorAll('.lm-editor-pane')[1] ? 'secondary' : 'main',
  activeOutlineText: document.querySelector('.outline-row.active .outline-item')?.textContent.trim(),
  panes: document.querySelectorAll('.lm-editor-pane').length,
}))()`);
await screenshot("outline-split-dark-900x600.png");

const report = {
  follow: followMetrics,
  treeFold: treeFoldMetrics,
  wysiwygBefore,
  wysiwygFold: wysiwygFoldMetrics,
  source: sourceMetrics,
  sourceGutterHit,
  sourceGutterInteraction,
  navigation: navigationMetrics,
  narrowDark: narrowMetrics,
  split: splitMetrics,
};
fs.writeFileSync(path.join(outputDir, "outline-folding-visual-report.json"), JSON.stringify(report, null, 2));
ws.close();
console.log(JSON.stringify(report, null, 2));
