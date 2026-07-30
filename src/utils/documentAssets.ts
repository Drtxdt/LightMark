export type AssetKind = "image" | "audio" | "video" | "pdf";
export type AssetSyntax = "markdown-image" | "markdown-link" | "html" | "lightmark-figure";

export interface AssetReference {
  source: string;
  from: number;
  to: number;
  line: number;
  kind: AssetKind;
  syntax: AssetSyntax;
  external: boolean;
}

const SUPPORTED = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|mp3|wav|ogg|m4a|flac|mp4|webm|mov|mkv|pdf)(?:[?#].*)?$/i;

export function extractAssetReferences(markdown: string): AssetReference[] {
  const protectedRanges = structuralProtectedRanges(markdown);
  const references: AssetReference[] = [];
  const push = (source: string, from: number, to: number, syntax: AssetSyntax) => {
    if (!source || inRanges(from, protectedRanges) || !SUPPORTED.test(source.split(/\s+/)[0])) return;
    references.push({
      source,
      from,
      to,
      line: lineAt(markdown, from),
      kind: assetKind(source),
      syntax,
      external: isExternalAssetSource(source),
    });
  };

  for (const match of markdown.matchAll(/(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g)) {
    const whole = match[0];
    const source = match[3] || match[4] || "";
    const relative = whole.indexOf(source);
    const from = (match.index || 0) + relative;
    push(source, from, from + source.length, match[1] ? "markdown-image" : "markdown-link");
  }
  for (const match of markdown.matchAll(/<(img|audio|video|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const source = match[2] || match[3] || "";
    const from = (match.index || 0) + match[0].indexOf(source);
    const figureStart = markdown.lastIndexOf("<figure", match.index);
    const figureEnd = markdown.indexOf("</figure>", match.index);
    const marked = figureStart >= 0 && figureEnd >= 0 && figureEnd - (match.index || 0) < 4096
      && /data-lightmark-image/i.test(markdown.slice(figureStart, match.index));
    push(source, from, from + source.length, marked ? "lightmark-figure" : "html");
  }
  return references.sort((a, b) => a.from - b.from).filter((item, index, all) => {
    return index === 0 || item.from !== all[index - 1].from || item.to !== all[index - 1].to;
  });
}

export function replaceAssetReference(markdown: string, reference: AssetReference, nextSource: string) {
  if (markdown.slice(reference.from, reference.to) !== reference.source) return null;
  return `${markdown.slice(0, reference.from)}${nextSource}${markdown.slice(reference.to)}`;
}

export function isExternalAssetSource(source: string) {
  return /^(?:https?:|data:|blob:|asset:|tauri:|file:)/i.test(source) || source.startsWith("#");
}

function assetKind(source: string): AssetKind {
  const clean = source.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".pdf")) return "pdf";
  if (/\.(?:mp3|wav|ogg|m4a|flac)$/.test(clean)) return "audio";
  if (/\.(?:mp4|webm|mov|mkv)$/.test(clean)) return "video";
  return "image";
}

function structuralProtectedRanges(markdown: string) {
  const ranges: Array<[number, number]> = [];
  const add = (pattern: RegExp) => {
    for (const match of markdown.matchAll(pattern)) ranges.push([match.index || 0, (match.index || 0) + match[0].length]);
  };
  add(/^(?:\uFEFF)?---[^\S\r\n]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[^\S\r\n]*(?=\r?\n|$)/g);
  add(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g);
  add(/`+[^`\n]*`+/g);
  add(/\$\$[\s\S]*?\$\$/g);
  add(/(?<!\\)\$(?!\s)[^$\n]+?(?<!\s)\$/g);
  return ranges.sort((a, b) => a[0] - b[0]);
}

function inRanges(offset: number, ranges: Array<[number, number]>) {
  return ranges.some(([from, to]) => offset >= from && offset < to);
}

function lineAt(markdown: string, offset: number) {
  let line = 0;
  for (let index = 0; index < offset; index += 1) if (markdown.charCodeAt(index) === 10) line += 1;
  return line;
}
