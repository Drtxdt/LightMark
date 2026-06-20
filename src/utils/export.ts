import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import mermaid from "mermaid";
import katexCss from "katex/dist/katex.min.css?raw";
import type {
  ExportRequest,
  ExportResult,
  ExportSettings,
  ExportTarget,
  ExportTargetId,
  PandocStatus,
} from "../types";
import { appStore, completeExportStatus, currentFileName, failExportStatus, startExportStatus } from "../stores/appStore";
import { escapeHtml } from "./html";
import { buildExportHtml, renderMarkdown } from "./markdown";

const katexFontUrls = import.meta.glob("../../node_modules/katex/dist/fonts/*.woff2", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

let exportExtraStylesCache: string | null = null;
let katexExportCssCache: string | null = null;

export const exportTargets: ExportTarget[] = [
  { id: "pdf", label: "PDF", extension: "pdf", kind: "native-pdf", requiresPandoc: false, enabled: true },
  { id: "html", label: "HTML", extension: "html", kind: "native-html", requiresPandoc: false, enabled: true },
  { id: "htmlPlain", label: "HTML without styles", extension: "html", kind: "native-html", requiresPandoc: false, enabled: true },
  { id: "png", label: "PNG 长图", extension: "png", kind: "native-image", requiresPandoc: false, enabled: true },
  { id: "pdfPandoc", label: "PDF (Pandoc/LaTeX)", extension: "pdf", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "docx", label: "Word (.docx)", extension: "docx", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "odt", label: "OpenOffice (.odt)", extension: "odt", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "rtf", label: "RTF", extension: "rtf", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "epub", label: "EPUB", extension: "epub", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "latex", label: "LaTeX (.tex)", extension: "tex", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "mediawiki", label: "MediaWiki", extension: "wiki", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "rst", label: "reStructuredText", extension: "rst", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "textile", label: "Textile", extension: "textile", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "opml", label: "OPML", extension: "opml", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "revealjs", label: "RevealJS", extension: "html", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "markdownSpec", label: "Markdown (Other Spec)", extension: "md", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "customPandoc", label: "Custom Pandoc", extension: "html", kind: "pandoc", requiresPandoc: true, enabled: true },
];

export async function detectPandoc(settings: ExportSettings) {
  return invoke<PandocStatus>("detect_pandoc", { settings });
}

export async function runDocumentExport(target: ExportTarget) {
  if (appStore.documentMode === "large") throw new Error("大文件模式暂不支持全量导出。");
  if (appStore.exportStatus.status === "running") throw new Error("已有导出任务正在进行。");

  startExportStatus(target.id, target.label);
  try {
    const result = await exportCurrentDocument({
      target: target.id,
      currentPath: appStore.currentFilePath,
      markdown: appStore.currentContent,
      settings: appStore.settings.export,
    });
    completeExportStatus(result.path);
    appStore.statusMessage = `已导出：${result.path}`;
    return result;
  } catch (error) {
    failExportStatus(error);
    throw error;
  }
}

export async function exportCurrentDocument(input: {
  target: ExportTargetId;
  currentPath: string;
  markdown: string;
  settings: ExportSettings;
}) {
  if (!input.currentPath) throw new Error("请先打开 Markdown 文件再导出。");

  const theme = exportTheme(input.settings);
  const body = await renderExportBody(input.markdown, theme);
  const extraStyles = await getExportExtraStyles();
  const styledHtml = buildExportHtml(currentFileName.value, body, {
    includeStyles: shouldIncludeExportStyles(input.target, input.settings),
    theme,
    currentPath: input.currentPath,
    extraStyles,
  });
  const plainHtml = buildExportHtml(currentFileName.value, body, { includeStyles: false, theme, currentPath: input.currentPath });

  if (input.target === "png") {
    const result = await exportHtmlAsPng(input.currentPath, styledHtml, input.settings);
    await handleAfterExport(result.path, input.settings);
    return result;
  }

  const request: ExportRequest = {
    target: input.target,
    currentPath: input.currentPath,
    title: currentFileName.value,
    markdown: input.markdown,
    html: styledHtml,
    plainHtml,
    settings: input.settings,
  };
  const result = await invoke<ExportResult>("export_document", { request });
  await handleAfterExport(result.path, input.settings);
  return result;
}

function exportTheme(settings: ExportSettings) {
  if (settings.htmlTheme === "light" || settings.htmlTheme === "dark") return settings.htmlTheme;
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function shouldIncludeExportStyles(target: ExportTargetId, settings: ExportSettings) {
  if (target === "htmlPlain") return false;
  if (target === "html") return settings.htmlIncludeStyles;
  return true;
}

async function renderExportBody(markdown: string, theme: "light" | "dark") {
  const withMermaid = await renderMermaidForExport(renderMarkdown(markdown), theme);
  return normalizeKatexForExport(withMermaid);
}

async function renderMermaidForExport(html: string, theme: "light" | "dark") {
  const parser = new DOMParser();
  const documentHtml = parser.parseFromString(`<main>${html}</main>`, "text/html");
  const nodes = Array.from(documentHtml.querySelectorAll<HTMLElement>("pre.mermaid"));
  if (nodes.length === 0) return html;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
  });

  for (const [index, node] of nodes.entries()) {
    const code = node.textContent || "";
    const wrapper = documentHtml.createElement("div");
    if (!code.trim()) {
      wrapper.className = "mermaid-export mermaid-export-error";
      wrapper.textContent = "空 Mermaid 图表";
      node.replaceWith(wrapper);
      continue;
    }

    try {
      const result = await mermaid.render(`lightmark-export-mermaid-${Date.now()}-${index}`, code);
      wrapper.className = "mermaid-export";
      wrapper.innerHTML = result.svg;
      node.replaceWith(wrapper);
    } catch (error) {
      wrapper.className = "mermaid-export-error";
      wrapper.innerHTML = `<strong>Mermaid 渲染失败</strong>\n${escapeHtml(code)}\n\n${escapeHtml(error instanceof Error ? error.message : String(error))}`;
      node.replaceWith(wrapper);
    }
  }

  return documentHtml.querySelector("main")?.innerHTML ?? html;
}

function normalizeKatexForExport(html: string) {
  const parser = new DOMParser();
  const documentHtml = parser.parseFromString(`<main>${html}</main>`, "text/html");
  documentHtml.querySelectorAll<HTMLParagraphElement>("p").forEach((paragraph) => {
    const elementChildren = Array.from(paragraph.children);
    const hasOnlyWhitespaceText = Array.from(paragraph.childNodes).every((node) => {
      return node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim();
    });
    const onlyChild = elementChildren[0];
    if (elementChildren.length === 1 && hasOnlyWhitespaceText && onlyChild.classList.contains("katex-display")) {
      onlyChild.classList.add("katex-display-export");
      paragraph.replaceWith(onlyChild);
    }
  });
  return documentHtml.querySelector("main")?.innerHTML ?? html;
}

async function getExportExtraStyles() {
  if (exportExtraStylesCache) return exportExtraStylesCache;
  exportExtraStylesCache = `${await getKatexExportCss()}\n${exportCssFixups}`;
  return exportExtraStylesCache;
}

const exportCssFixups = `
.markdown-preview pre code.hljs {
  display: block;
  overflow-x: auto;
  background: transparent;
  color: inherit;
}
.markdown-preview .katex {
  color: inherit;
  overflow-wrap: normal;
}
.markdown-preview .katex-display-export {
  overflow-x: auto;
  overflow-y: hidden;
  break-inside: avoid;
}
`;

async function getKatexExportCss() {
  if (katexExportCssCache) return katexExportCssCache;
  const fontDataUrls = new Map<string, string>();
  const files = Array.from(new Set(Array.from(katexCss.matchAll(/url\((["']?)fonts\/([^)"']+?\.woff2)\1\)/g)).map((match) => match[2])));
  for (const fileName of files) {
    const fontUrl = fontUrlForKatexFile(fileName);
    if (!fontUrl) continue;
    const dataUrl = await assetUrlToDataUrl(fontUrl, "font/woff2");
    fontDataUrls.set(fileName, dataUrl);
  }
  let next = katexCss.replace(/url\((["']?)fonts\/([^)"']+?\.woff2)\1\)/g, (match, _quote: string, fileName: string) => {
    const dataUrl = fontDataUrls.get(fileName);
    return dataUrl ? `url(${dataUrl})` : match;
  });
  next = stripKatexNonWoffFallbacks(next);
  katexExportCssCache = next;
  return next;
}

function fontUrlForKatexFile(fileName: string) {
  const entry = Object.entries(katexFontUrls).find(([path]) => path.endsWith(`/fonts/${fileName}`) || path.endsWith(`\\fonts\\${fileName}`));
  return typeof entry?.[1] === "string" ? entry[1] : "";
}

async function assetUrlToDataUrl(url: string, mime: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法加载导出字体资源：${url}`);
  const buffer = await response.arrayBuffer();
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function stripKatexNonWoffFallbacks(css: string) {
  return css.replace(/,url\(fonts\/[^)]+?\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
}

async function exportHtmlAsPng(currentPath: string, html: string, settings: ExportSettings): Promise<ExportResult> {
  const bytes = await renderHtmlToPngBytes(html);
  return invoke<ExportResult>("save_export_bytes", {
    currentPath,
    target: "png",
    extension: "png",
    bytes,
    settings,
  });
}

async function renderHtmlToPngBytes(html: string) {
  const parser = new DOMParser();
  const documentHtml = parser.parseFromString(html, "text/html");
  const main = documentHtml.querySelector("main");
  const style = documentHtml.querySelector("style")?.textContent ?? "";
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  container.style.width = "900px";
  container.style.background = "#fbfaf7";
  container.style.color = "#1f1e1b";
  container.innerHTML = `<style>${style}</style>${main ? main.outerHTML : documentHtml.body.innerHTML}`;
  document.body.appendChild(container);
  await nextAnimationFrame();

  const width = Math.ceil(container.scrollWidth);
  const height = Math.ceil(container.scrollHeight);
  const serialized = new XMLSerializer().serializeToString(container);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<foreignObject width="100%" height="100%">${serialized}</foreignObject>
</svg>`;

  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("PNG 渲染失败。"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境不支持 Canvas 导出。");
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG 编码失败。"))), "image/png");
    });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    URL.revokeObjectURL(url);
    container.remove();
  }
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function handleAfterExport(path: string, settings: ExportSettings) {
  if (settings.openFileAfterExport) {
    await openPath(path).catch(() => {});
    return;
  }
  if (settings.openFolderAfterExport) {
    await revealItemInDir(path).catch(() => {});
  }
}
