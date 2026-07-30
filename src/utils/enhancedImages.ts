export type ImageAlignment = "left" | "center" | "right";

export interface EnhancedImageAttrs {
  src: string;
  alt: string;
  title: string | null;
  widthPx: number | null;
  alignment: ImageAlignment;
  caption: string;
}

const FIGURE_PATTERN = /<figure\b([^>]*\bdata-lightmark-image(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*)>\s*<img\b([^>]*)>\s*(?:<figcaption>([\s\S]*?)<\/figcaption>\s*)?<\/figure>/gi;

export function enhanceImagesForEditor(markdown: string) {
  return replaceEnhancedImages(markdown, (source) => source);
}

export function protectEnhancedImagesForEditor(markdown: string, stash: (html: string) => string) {
  return replaceEnhancedImages(markdown, stash);
}

export function protectEnhancedImagesForPreview(markdown: string, stash: (html: string) => string) {
  return markdown.replace(FIGURE_PATTERN, (source, figureAttrs: string, imageAttrs: string, caption = "") => {
    const parsed = parseEnhancedFigureParts(figureAttrs, imageAttrs, caption);
    return parsed ? stash(enhancedFigureMarkdown(parsed)) : source;
  });
}

function replaceEnhancedImages(markdown: string, wrap: (html: string) => string) {
  return markdown.replace(FIGURE_PATTERN, (source, figureAttrs: string, imageAttrs: string, caption = "") => {
    const parsed = parseEnhancedFigureParts(figureAttrs, imageAttrs, caption);
    if (!parsed) return source;
    return wrap(`<img src="${escapeAttribute(parsed.src)}" alt="${escapeAttribute(parsed.alt)}"${parsed.title ? ` title="${escapeAttribute(parsed.title)}"` : ""} data-lightmark-image="true" data-lightmark-width="${parsed.widthPx ?? ""}" data-lightmark-align="${parsed.alignment}" data-lightmark-caption="${escapeAttribute(parsed.caption)}">`);
  });
}

export function parseEnhancedFigureElement(figure: HTMLElement): EnhancedImageAttrs | null {
  if (!figure.hasAttribute("data-lightmark-image")) return null;
  const image = figure.querySelector(":scope > img");
  if (!(image instanceof HTMLImageElement)) return null;
  return normalizeEnhancedImage({
    src: image.getAttribute("data-markdown-src") || image.getAttribute("src") || "",
    alt: image.getAttribute("alt") || "",
    title: image.getAttribute("title"),
    widthPx: numberWidth(image.getAttribute("width") || figure.getAttribute("data-width")),
    alignment: normalizeAlignment(figure.getAttribute("data-align")),
    caption: figure.querySelector(":scope > figcaption")?.textContent || "",
  });
}

export function enhancedFigureMarkdown(attrs: EnhancedImageAttrs) {
  const normalized = normalizeEnhancedImage(attrs);
  if (!normalized) return "";
  const width = normalized.widthPx ? ` width="${normalized.widthPx}"` : "";
  const title = normalized.title ? ` title="${escapeAttribute(normalized.title)}"` : "";
  const caption = normalized.caption ? `\n  <figcaption>${escapeHtml(normalized.caption)}</figcaption>` : "";
  const style = alignmentStyle(normalized.alignment, normalized.widthPx);
  return `<figure data-lightmark-image data-align="${normalized.alignment}"${normalized.widthPx ? ` data-width="${normalized.widthPx}"` : ""} style="${style}">\n  <img src="${escapeAttribute(normalized.src)}" alt="${escapeAttribute(normalized.alt)}"${title}${width} style="max-width:100%;height:auto;">${caption}\n</figure>`;
}

export function imageMarkdownOrFigure(attrs: EnhancedImageAttrs) {
  const normalized = normalizeEnhancedImage(attrs);
  if (!normalized) return "";
  if (!normalized.widthPx && normalized.alignment === "left" && !normalized.caption) {
    const alt = normalized.alt.replace(/]/g, "\\]");
    const title = normalized.title ? ` "${normalized.title.replace(/"/g, '\\"')}"` : "";
    return `![${alt}](${normalized.src}${title})`;
  }
  return enhancedFigureMarkdown(normalized);
}

export function enhancedImagesForPandoc(markdown: string) {
  return markdown.replace(FIGURE_PATTERN, (source, figureAttrs: string, imageAttrs: string, caption = "") => {
    const parsed = parseEnhancedFigureParts(figureAttrs, imageAttrs, caption);
    if (!parsed) return source;
    const label = (parsed.caption || parsed.alt).replace(/[\[\]]/g, "\\$&");
    const title = parsed.title ? ` "${parsed.title.replace(/"/g, '\\"')}"` : "";
    const width = parsed.widthPx ? `{width=${parsed.widthPx}px}` : "";
    const image = `![${label}](${parsed.src}${title})${width}`;
    if (parsed.alignment === "left") return image;
    return `::: {style="text-align: ${parsed.alignment};"}\n${image}\n:::`;
  });
}

export function unwrapEnhancedImageParagraphs(html: string) {
  return html.replace(/<p>\s*(<figure data-lightmark-image[\s\S]*?<\/figure>)\s*<\/p>/gi, "$1");
}

export function clampImageWidth(value: unknown) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(4096, Math.max(48, number));
}

function parseEnhancedFigureParts(figureAttrs: string, imageAttrs: string, caption: string) {
  const figure = attributes(figureAttrs);
  const image = attributes(imageAttrs);
  return normalizeEnhancedImage({
    src: image.src || "",
    alt: image.alt || "",
    title: image.title || null,
    widthPx: numberWidth(image.width || figure["data-width"]),
    alignment: normalizeAlignment(figure["data-align"]),
    caption: decodeHtml(caption.replace(/<[^>]*>/g, "")).trim(),
  });
}

function normalizeEnhancedImage(attrs: EnhancedImageAttrs): EnhancedImageAttrs | null {
  const src = attrs.src.trim();
  if (!src) return null;
  return {
    src,
    alt: attrs.alt || "",
    title: attrs.title || null,
    widthPx: attrs.widthPx ? clampImageWidth(attrs.widthPx) : null,
    alignment: normalizeAlignment(attrs.alignment),
    caption: (attrs.caption || "").trim(),
  };
}

function attributes(source: string) {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function numberWidth(value: string | null | undefined) {
  if (!value || !/^\d{1,5}$/.test(value.trim())) return null;
  return clampImageWidth(value);
}

function normalizeAlignment(value: unknown): ImageAlignment {
  return value === "center" || value === "right" ? value : "left";
}

function alignmentStyle(alignment: ImageAlignment, widthPx: number | null) {
  const width = widthPx ? `width:${widthPx}px;max-width:100%;` : "max-width:100%;";
  if (alignment === "center") return `${width}margin-left:auto;margin-right:auto;`;
  if (alignment === "right") return `${width}margin-left:auto;margin-right:0;`;
  return `${width}margin-left:0;margin-right:auto;`;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function decodeHtml(value: string) {
  if (typeof document === "undefined") {
    return value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  }
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}
