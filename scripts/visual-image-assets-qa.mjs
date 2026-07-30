import fs from "node:fs";
import path from "node:path";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("Usage: node scripts/visual-image-assets-qa.mjs <output-dir>");
fs.mkdirSync(outputDir, { recursive: true });

const pages = await fetch("http://127.0.0.1:9333/json").then((response) => response.json());
const page = pages.find((item) => item.url.includes("qa=final"))
  || pages.find((item) => item.url.startsWith("http://127.0.0.1:1420/"));
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
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const nextId = ++id;
  pending.set(nextId, { resolve, reject });
  ws.send(JSON.stringify({ id: nextId, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description || ""}`);
  return result.result.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshot = async (name) => {
  const result = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(path.join(outputDir, name), Buffer.from(result.data, "base64"));
};

await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 780, deviceScaleFactor: 1, mobile: false });
await wait(1800);
const setup = await evaluate(`(async () => {
  const store = await import('/src/stores/appStore.ts');
  store.setTheme('light').catch(() => {});
  store.setContent(\`# 图片排版体验

上方正文用于检查工具栏是否遮挡。

<figure data-lightmark-image data-align="left" data-width="620" style="width:620px;max-width:100%;margin-left:0;margin-right:auto;">
  <img src="/@fs/E:/my_code/LightMark/scripts/fixtures/visual-image.svg" alt="宽幅测试图片" width="620" style="max-width:100%;height:auto;">
  <figcaption>初始 Caption</figcaption>
</figure>

下方正文用于检查图片不会覆盖相邻内容。\`);
  store.switchMode('source');
  return { content: store.appStore.currentContent.slice(0, 80), tabs: store.appStore.tabs.length, mode: store.appStore.editorMode };
})()`);
console.log("setup", setup);
await wait(180);
await evaluate(`(() => { document.querySelector('[aria-label="编辑"]').click(); return true; })()`);
await wait(1600);
const renderedDebug = await evaluate(`(async () => {
  const store = await import('/src/stores/appStore.ts');
  const markdown = await import('/src/utils/markdown.ts');
  return markdown.renderMarkdownForEditor(store.appStore.currentContent);
})()`);
console.log("rendered", renderedDebug.slice(0, 1000));
const imageRect = await evaluate(`(() => {
  const image = document.querySelector('.typora-image-node img');
  if (!image) throw new Error('Image node missing: ' + document.querySelector('.ProseMirror')?.innerHTML.slice(0, 1200));
  const rect = image.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: imageRect.x, y: imageRect.y, button: "left", clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: imageRect.x, y: imageRect.y, button: "left", clickCount: 1 });
await wait(250);
await evaluate(`(() => {
  const center = document.querySelector('.typora-image-tool[data-align="center"]');
  center.click();
  const width = document.querySelector('.typora-image-width');
  width.value = '540';
  width.dispatchEvent(new Event('change', { bubbles: true }));
  const caption = document.querySelector('.typora-image-caption');
  caption.value = '居中的独立 Caption';
  caption.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('.typora-image-node').scrollIntoView({ block: 'center' });
})()`);
await wait(350);
await screenshot("image-layout-light-1200x780.png");

const lightMetrics = await evaluate(`(() => {
  const figure = document.querySelector('.typora-image-node');
  const toolbar = document.querySelector('.typora-image-toolbar');
  const below = Array.from(document.querySelectorAll('.ProseMirror p')).at(-1);
  const f = figure.getBoundingClientRect(), t = toolbar.getBoundingClientRect(), b = below.getBoundingClientRect();
  return {
    figureWidth: Math.round(f.width),
    alignment: figure.dataset.align,
    toolbarVisible: getComputedStyle(toolbar).display !== 'none',
    toolbarAboveImage: t.bottom <= figure.querySelector('.typora-image-stage').getBoundingClientRect().top,
    noOverlapBelow: f.bottom <= b.top,
    caption: figure.querySelector('.typora-image-caption').value,
  };
})()`);
const exportMetrics = await evaluate(`(async () => {
  const store = await import('/src/stores/appStore.ts');
  const markdown = await import('/src/utils/markdown.ts');
  const html = markdown.renderMarkdown(store.appStore.currentContent);
  const template = document.createElement('template');
  template.innerHTML = html;
  const figure = template.content.querySelector('figure[data-lightmark-image]');
  return {
    semanticFigure: Boolean(figure),
    width: figure?.getAttribute('data-width'),
    alignment: figure?.getAttribute('data-align'),
    caption: figure?.querySelector('figcaption')?.textContent,
    markdown: store.appStore.currentContent.slice(0, 700),
    html: html.slice(0, 700),
  };
})()`);

await call("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
await evaluate(`(async () => { const store = await import('/src/stores/appStore.ts'); await store.setTheme('dark').catch(() => {}); return true; })()`);
await wait(400);
await screenshot("image-layout-dark-900x600.png");
const narrowMetrics = await evaluate(`(() => {
  const figure = document.querySelector('.typora-image-node').getBoundingClientRect();
  const editor = document.querySelector('.ProseMirror').getBoundingClientRect();
  return { viewport: [innerWidth, innerHeight], figureWithinEditor: figure.left >= editor.left && figure.right <= editor.right + 1 };
})()`);

await evaluate(`(async () => {
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === 'inspect_document_assets') {
        return {
          assetFolder: 'E:/qa/assets',
          references: args.sources.map((source, index) => ({
            source,
            path: index === 1 ? 'E:/qa/assets/missing.pdf' : 'E:/qa/assets/visual-image.svg',
            name: index === 1 ? 'missing.pdf' : 'visual-image.svg',
            exists: index !== 1,
            size: index === 1 ? null : 84231,
            kind: index === 1 ? 'pdf' : 'image',
          })),
          folderFiles: [
            { source: '', path: 'E:/qa/assets/visual-image.svg', name: 'visual-image.svg', exists: true, size: 84231, kind: 'image' },
            { source: '', path: 'E:/qa/assets/demo.mp4', name: 'demo.mp4', exists: true, size: 4200000, kind: 'video' },
          ],
        };
      }
      return null;
    },
  };
  const store = await import('/src/stores/appStore.ts');
  const extra = '\\n\\n[缺失 PDF](assets/missing.pdf)';
  store.appStore.currentFilePath = 'E:/qa/demo.md';
  store.appStore.currentContent += extra;
  const active = store.appStore.tabs.find((item) => item.id === store.appStore.activeTabId);
  if (active) { active.path = 'E:/qa/demo.md'; active.content = store.appStore.currentContent; }
  return true;
})()`);
await evaluate(`(() => {
  const button = Array.from(document.querySelectorAll('.sidebar-switch')).find((item) => item.textContent.includes('资源'));
  button.click();
})()`);
await wait(350);
await screenshot("resources-sidebar-dark-900x600.png");
const resourceMetrics = await evaluate(`(() => ({
  active: document.querySelector('.sidebar-switch.active')?.textContent.trim(),
  message: document.querySelector('.resource-state')?.textContent.trim(),
  tabsFit: !document.querySelector('.resources-pane') || document.querySelector('.resources-pane').scrollWidth <= document.querySelector('.resources-pane').clientWidth,
}))()`);

fs.writeFileSync(path.join(outputDir, "image-assets-visual-report.json"), JSON.stringify({
  light: lightMetrics,
  export: exportMetrics,
  narrowDark: narrowMetrics,
  resources: resourceMetrics,
}, null, 2));
ws.close();
console.log(JSON.stringify({ lightMetrics, exportMetrics, narrowMetrics, resourceMetrics }, null, 2));
