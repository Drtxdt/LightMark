import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { appStore, refreshFileTree } from "../stores/appStore";
import { processPastedImage, type ProcessedPastedImage } from "./imageCompression";

export type ImageAssetInputSource = "clipboard" | "drop";

const imageExtensionByType: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

export function getImageFilesFromClipboard(data: DataTransfer | null) {
  if (!data) return [];
  return getImageFilesFromItems(data.items);
}

export function getImageFilesFromDrop(data: DataTransfer | null) {
  if (!data) return [];
  const fromItems = getImageFilesFromItems(data.items);
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

export async function saveImagesAsMarkdown(
  files: File[],
  options: { source?: ImageAssetInputSource } = {},
) {
  if (files.length === 0) return "";
  if (!appStore.currentFilePath) {
    appStore.statusMessage = "请先保存或打开 Markdown 文件，再粘贴图片。";
    return "";
  }
  if (appStore.documentMode === "large") {
    appStore.statusMessage = "大文件模式暂不支持直接粘贴图片。";
    return "";
  }

  const snippets: string[] = [];
  const processed: ProcessedPastedImage[] = [];
  const timestamp = new Date();
  for (const originalFile of files) {
    const result = options.source === "clipboard"
      ? await processPastedImage(originalFile, appStore.settings.image, timestamp)
      : unchangedDroppedImage(originalFile);
    processed.push(result);
    const relativePath = await saveImageAsset(result.file);
    snippets.push(`![${imageAlt(result.file)}](${formatMarkdownImagePath(relativePath)})`);
  }
  await refreshFileTree().catch(() => {});
  appStore.statusMessage = imageSaveStatus(processed);
  return snippets.join("\n\n");
}

export async function imagePathsAsMarkdown(paths: string[]) {
  if (paths.length === 0) return "";
  if (!appStore.currentFilePath) {
    appStore.statusMessage = "请先保存或打开 Markdown 文件，再插入图片。";
    return "";
  }
  if (appStore.documentMode === "large") {
    appStore.statusMessage = "大文件模式暂不支持直接插入图片。";
    return "";
  }
  const markdown = await invoke<string>("image_paths_to_markdown", {
    markdownPath: appStore.currentFilePath,
    paths,
    useRelativePath: appStore.settings.image.useRelativePath,
    ensureDotSlash: appStore.settings.image.ensureDotSlash,
    escapePath: appStore.settings.image.escapePath,
  });
  appStore.statusMessage = `已插入 ${paths.length} 张图片引用`;
  return markdown;
}

export function resolveRenderedImageSources(html: string) {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  if (appStore.currentFilePath) {
    template.content.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
      const source = image.getAttribute("src") || "";
      const resolved = resolveMarkdownImageSource(source);
      if (!resolved || resolved === source) return;
      image.setAttribute("data-markdown-src", source);
      image.setAttribute("src", resolved);
    });
  }
  unwrapImageOnlyParagraphs(template.content);
  return template.innerHTML;
}

export function markdownImageSourceFromElement(node: HTMLElement) {
  return node.getAttribute("data-markdown-src") || node.getAttribute("src") || "";
}

function getImageFilesFromItems(items: DataTransferItemList | undefined) {
  if (!items) return [];
  return Array.from(items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function unwrapImageOnlyParagraphs(root: DocumentFragment) {
  root.querySelectorAll("p").forEach((paragraph) => {
    const meaningfulChildren = Array.from(paragraph.childNodes).filter((child) => {
      return child.nodeType !== globalThis.Node.TEXT_NODE || Boolean(child.textContent?.trim());
    });
    if (meaningfulChildren.length !== 1) return;
    const image = meaningfulChildren[0];
    if (!(image instanceof HTMLImageElement)) return;
    paragraph.replaceWith(image);
  });
}

async function saveImageAsset(file: File) {
  const fallbackName = `image-${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(file)}`;
  const fileName = file.name || fallbackName;
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return await invoke<string>("save_asset_file", {
    markdownPath: appStore.currentFilePath,
    fileName,
    bytes,
    assetFolder: appStore.settings.image.assetFolder || "assets",
  });
}

export function resolveMarkdownImageSource(source: string, markdownPath = appStore.currentFilePath) {
  if (isExternalImageSource(source)) return source;
  const absolute = resolveMarkdownImagePath(source, markdownPath);
  return isTauri() ? convertFileSrc(absolute) : absolute;
}

export function resolveMarkdownImagePath(source: string, markdownPath = appStore.currentFilePath) {
  const decodedSource = decodeMarkdownPath(source);
  return isAbsolutePath(decodedSource) ? decodedSource : joinPath(parentPath(markdownPath), decodedSource);
}

function isExternalImageSource(source: string) {
  return /^(?:https?:|data:|blob:|asset:|tauri:|file:)/i.test(source) || source.startsWith("#");
}

function decodeMarkdownPath(path: string) {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function parentPath(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(0, index) : "";
}

function joinPath(base: string, relative: string) {
  if (!base) return relative;
  return `${base.replace(/[\\/]+$/, "")}/${relative.replace(/^[\\/]+/, "")}`;
}

function isAbsolutePath(path: string) {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function extensionFor(file: File) {
  return imageExtensionByType[file.type] || "png";
}

function imageAlt(file: File) {
  const name = file.name.replace(/\.[^.]+$/, "").trim();
  return name || "image";
}

function formatMarkdownImagePath(path: string) {
  let normalized = path.replace(/\\/g, "/");
  if (
    appStore.settings.image.ensureDotSlash &&
    !normalized.startsWith("./") &&
    !normalized.startsWith("../") &&
    !normalized.startsWith("/") &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)
  ) {
    normalized = `./${normalized}`;
  }
  return appStore.settings.image.escapePath ? normalized.split("/").map(encodePathSegment).join("/") : normalized;
}

function encodePathSegment(segment: string) {
  return encodeURIComponent(segment).replace(/%20/g, "%20");
}

function unchangedDroppedImage(file: File): ProcessedPastedImage {
  return {
    originalFile: file,
    file,
    originalBytes: file.size,
    outputBytes: file.size,
    originalDimensions: null,
    outputDimensions: null,
    compressed: false,
    skipReason: "disabled",
  };
}

function imageSaveStatus(results: ProcessedPastedImage[]) {
  const originalBytes = results.reduce((total, item) => total + item.originalBytes, 0);
  const outputBytes = results.reduce((total, item) => total + item.outputBytes, 0);
  const compressed = results.filter((item) => item.compressed).length;
  const warnings = results.filter((item) => item.warning).length;
  const sizeSummary = compressed > 0 ? `（${formatBytes(originalBytes)} → ${formatBytes(outputBytes)}）` : "";
  const compressionSummary = compressed > 0 ? `，压缩 ${compressed} 张${sizeSummary}` : "";
  const warningSummary = warnings > 0 ? `，${warnings} 张压缩失败并保留原图` : "";
  return `已保存 ${results.length} 张图片${compressionSummary}${warningSummary}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
