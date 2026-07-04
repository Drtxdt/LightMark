import type { FileNode } from "../types";

export interface WikiLinkTarget {
  raw?: string;
  page: string;
  heading?: string;
}

export interface ParsedWikiLink extends WikiLinkTarget {
  raw: string;
  line: number;
  from: number;
  to: number;
}

export interface WikiLinkResolution {
  status: "found" | "missing" | "ambiguous";
  path?: string;
  candidates: string[];
}

export interface BacklinkItem {
  sourcePath: string;
  sourceName: string;
  line: number;
  preview: string;
  target: WikiLinkTarget;
}

export function parseWikiLinks(markdown: string): ParsedWikiLink[] {
  const links: ParsedWikiLink[] = [];
  let inFence = false;
  let offset = 0;
  const lines = markdown.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (!inFence) {
      collectWikiLinksFromLine(line, lineIndex, offset, links);
    }
    offset += line.length + 1;
  }

  return links;
}

export function resolveWikiLink(target: WikiLinkTarget, nodes: FileNode[]): WikiLinkResolution {
  const expected = normalizeWikiPageName(target.page);
  const candidates = flattenMarkdownFiles(nodes)
    .filter((path) => normalizeWikiPageName(fileStem(path)) === expected)
    .sort(compareWikiCandidatePaths);

  if (candidates.length === 0) return { status: "missing", candidates: [] };
  return {
    status: candidates.length > 1 ? "ambiguous" : "found",
    path: candidates[0],
    candidates,
  };
}

export function backlinksForPath(path: string, source: string, sourcePath: string) {
  const targetPage = normalizeWikiPageName(fileStem(path));
  return parseWikiLinks(source)
    .filter((link) => normalizeWikiPageName(link.page) === targetPage)
    .map((link): BacklinkItem => ({
      sourcePath,
      sourceName: fileName(sourcePath),
      line: link.line,
      preview: previewLine(source, link.line),
      target: link,
    }));
}

export function wikiLinkHref(target: WikiLinkTarget) {
  const params = [`page=${encodeURIComponent(target.page)}`];
  if (target.heading) params.push(`heading=${encodeURIComponent(target.heading)}`);
  return `lightmark://wiki?${params.join("&")}`;
}

export function wikiLinkMarkdown(target: WikiLinkTarget) {
  return `[[${target.heading ? `${target.page}#${target.heading}` : target.page}]]`;
}

export function parseWikiLinkHref(href: string): WikiLinkTarget | null {
  if (!href.startsWith("lightmark://wiki")) return null;
  try {
    const url = new URL(href);
    const page = url.searchParams.get("page")?.trim();
    if (!page) return null;
    const heading = url.searchParams.get("heading")?.trim() || undefined;
    return { page, heading };
  } catch {
    return null;
  }
}

export function renderWikiLinksInEscapedText(html: string) {
  return html.replace(/\[\[([^\]\n]+)\]\]/g, (raw, body) => {
    const target = parseWikiLinkBody(body);
    if (!target) return raw;
    const label = target.heading ? `${target.page}#${target.heading}` : target.page;
    return `<a href="${escapeAttribute(wikiLinkHref(target))}" data-wiki-link="true" data-wiki-page="${escapeAttribute(target.page)}" data-wiki-heading="${escapeAttribute(target.heading || "")}">${escapeHtml(label)}</a>`;
  });
}

export function wikiPageFileName(target: WikiLinkTarget) {
  const page = target.page.trim().replace(/[<>:"|?*\x00-\x1f]/g, "-");
  if (!page || page.includes("/") || page.includes("\\")) return null;
  return page.endsWith(".md") || page.endsWith(".markdown") ? page : `${page}.md`;
}

export function flattenMarkdownFiles(nodes: FileNode[]) {
  const files: string[] = [];
  const walk = (items: FileNode[]) => {
    for (const item of items) {
      if (item.isDir) {
        walk(item.children);
      } else if (isMarkdownPath(item.path)) {
        files.push(item.path);
      }
    }
  };
  walk(nodes);
  return files;
}

function collectWikiLinksFromLine(line: string, lineIndex: number, lineOffset: number, links: ParsedWikiLink[]) {
  const protectedRanges = inlineCodeRanges(line);
  const pattern = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const from = match.index;
    const to = from + match[0].length;
    if (protectedRanges.some((range) => from >= range.from && from < range.to)) continue;
    const target = parseWikiLinkBody(match[1]);
    if (!target) continue;
    links.push({
      ...target,
      raw: match[0],
      line: lineIndex,
      from: lineOffset + from,
      to: lineOffset + to,
    });
  }
}

function parseWikiLinkBody(body: string): WikiLinkTarget | null {
  const [pagePart, headingPart] = body.split("#", 2);
  const page = pagePart.trim();
  if (!page) return null;
  const heading = headingPart?.trim() || undefined;
  return { page, heading };
}

function inlineCodeRanges(line: string) {
  const ranges: Array<{ from: number; to: number }> = [];
  const pattern = /`[^`]*`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

function compareWikiCandidatePaths(left: string, right: string) {
  const leftDepth = left.replace(/\\/g, "/").split("/").length;
  const rightDepth = right.replace(/\\/g, "/").split("/").length;
  return leftDepth - rightDepth || left.localeCompare(right, "zh-Hans-CN");
}

function normalizeWikiPageName(value: string) {
  return stripMarkdownExtension(value.trim()).toLocaleLowerCase();
}

function fileStem(path: string) {
  return stripMarkdownExtension(fileName(path));
}

function stripMarkdownExtension(value: string) {
  return value.replace(/\.(md|markdown)$/i, "");
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function isMarkdownPath(path: string) {
  return /\.(md|markdown)$/i.test(path);
}

function previewLine(source: string, line: number) {
  return source.split(/\r?\n/)[line]?.trim() || "";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
