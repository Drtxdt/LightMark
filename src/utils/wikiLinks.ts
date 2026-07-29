import type { FileNode } from "../types";
import { parseDocument } from "yaml";

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

export interface WikiDocumentEntry {
  path: string;
  name: string;
  relativePath: string;
  normalizedName: string;
  aliases: string[];
  normalizedAliases: string[];
  tags: string[];
  normalizedTags: string[];
  links: ParsedWikiLink[];
  searchableSegments: KnowledgeTextSegment[];
  linePreviews: string[];
  indexed: boolean;
}

export interface WikiWorkspaceIndex {
  root: string;
  entries: WikiDocumentEntry[];
}

export interface WikiCompletionCandidate extends WikiDocumentEntry {
  matchedAlias?: string;
}

export interface BacklinkItem {
  sourcePath: string;
  sourceName: string;
  line: number;
  preview: string;
  target: WikiLinkTarget;
}

export interface KnowledgeTextSegment {
  text: string;
  from: number;
  to: number;
  line: number;
}

export interface KnowledgeTagItem {
  name: string;
  normalizedName: string;
  paths: string[];
}

export interface UnlinkedMentionItem {
  sourcePath: string;
  sourceName: string;
  line: number;
  from: number;
  to: number;
  text: string;
  preview: string;
  targetPath: string;
}

export interface KnowledgeQuickOpenMatch {
  score: number;
  matchKind: "name" | "alias" | "tag" | "path";
  matchedAlias?: string;
  matchedTag?: string;
}

export type UnlinkedMentionConversion =
  | { status: "stale" }
  | { status: "ok"; text: string; replacement: string; from: number; to: number };

export function parseWikiLinks(markdown: string): ParsedWikiLink[] {
  return analyzeMarkdownKnowledge(markdown).links;
}

export function createWikiWorkspaceIndex(nodes: FileNode[], root = ""): WikiWorkspaceIndex {
  return {
    root,
    entries: flattenMarkdownFiles(nodes).map((path) => createWikiDocumentEntry(path, root)),
  };
}

export function updateWikiIndexEntry(index: WikiWorkspaceIndex, path: string, markdown: string) {
  const existing = index.entries.find((entry) => samePath(entry.path, path));
  const entry = existing ?? createWikiDocumentEntry(path, index.root);
  const analysis = analyzeMarkdownKnowledge(markdown);
  entry.aliases = analysis.aliases;
  entry.normalizedAliases = analysis.aliases.map(normalizeWikiPageName);
  entry.tags = analysis.tags;
  entry.normalizedTags = analysis.tags.map(normalizeTagName);
  entry.links = analysis.links;
  entry.searchableSegments = analysis.searchableSegments;
  entry.linePreviews = analysis.linePreviews;
  entry.indexed = true;
  if (!existing) index.entries.push(entry);
  return entry;
}

export function parseFrontMatterAliases(markdown: string) {
  return parseFrontMatterKnowledge(markdown).aliases;
}

export function parseKnowledgeTags(markdown: string) {
  return analyzeMarkdownKnowledge(markdown).tags;
}

export function knowledgeTags(index: WikiWorkspaceIndex): KnowledgeTagItem[] {
  const groups = new Map<string, KnowledgeTagItem>();
  for (const entry of index.entries) {
    entry.tags.forEach((tag, tagIndex) => {
      const normalizedName = entry.normalizedTags[tagIndex] || normalizeTagName(tag);
      if (!normalizedName) return;
      const existing = groups.get(normalizedName);
      if (existing) {
        if (!existing.paths.some((path) => samePath(path, entry.path))) existing.paths.push(entry.path);
      } else {
        groups.set(normalizedName, { name: tag, normalizedName, paths: [entry.path] });
      }
    });
  }
  return [...groups.values()]
    .map((item) => ({ ...item, paths: item.paths.sort(compareWikiCandidatePaths) }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
}

export function backlinksFromIndex(path: string, index: WikiWorkspaceIndex) {
  const backlinks: BacklinkItem[] = [];
  for (const entry of index.entries) {
    if (samePath(entry.path, path)) continue;
    for (const link of entry.links) {
      const resolution = resolveWikiLink(link, index);
      if (!resolution.path || !samePath(resolution.path, path)) continue;
      backlinks.push({
        sourcePath: entry.path,
        sourceName: fileName(entry.path),
        line: link.line,
        preview: entry.linePreviews[link.line]?.trim() || link.raw,
        target: link,
      });
    }
  }
  return backlinks;
}

export function unlinkedMentionsForPath(path: string, index: WikiWorkspaceIndex) {
  const target = index.entries.find((entry) => samePath(entry.path, path));
  if (!target) return [];
  const names = uniqueAliases([target.name, ...target.aliases])
    .filter(isEligibleMentionName)
    .sort((left, right) => right.length - left.length || left.localeCompare(right, "zh-Hans-CN"));
  if (names.length === 0) return [];

  const results: UnlinkedMentionItem[] = [];
  for (const entry of index.entries) {
    if (samePath(entry.path, path)) continue;
    const occupied: Array<{ from: number; to: number }> = [];
    for (const segment of entry.searchableSegments) {
      const normalized = segment.text.toLocaleLowerCase();
      for (const name of names) {
        const expected = name.toLocaleLowerCase();
        let searchFrom = 0;
        while (searchFrom <= normalized.length - expected.length) {
          const localFrom = normalized.indexOf(expected, searchFrom);
          if (localFrom < 0) break;
          const localTo = localFrom + expected.length;
          searchFrom = localFrom + Math.max(expected.length, 1);
          if (!mentionBoundariesMatch(segment.text, localFrom, localTo, name)) continue;
          const from = segment.from + localFrom;
          const to = segment.from + localTo;
          if (occupied.some((range) => from < range.to && to > range.from)) continue;
          occupied.push({ from, to });
          results.push({
            sourcePath: entry.path,
            sourceName: fileName(entry.path),
            line: segment.line,
            from,
            to,
            text: segment.text.slice(localFrom, localTo),
            preview: entry.linePreviews[segment.line]?.trim() || segment.text.trim(),
            targetPath: path,
          });
        }
      }
    }
  }
  return results.sort((left, right) => (
    left.sourceName.localeCompare(right.sourceName, "zh-Hans-CN")
    || left.line - right.line
    || left.from - right.from
  ));
}

export function prepareUnlinkedMentionConversion(
  markdown: string,
  mention: Pick<UnlinkedMentionItem, "from" | "to" | "text">,
): UnlinkedMentionConversion {
  if (mention.from < 0 || mention.to < mention.from || markdown.slice(mention.from, mention.to) !== mention.text) {
    return { status: "stale" };
  }
  const replacement = `[[${mention.text}]]`;
  return {
    status: "ok",
    text: `${markdown.slice(0, mention.from)}${replacement}${markdown.slice(mention.to)}`,
    replacement,
    from: mention.from,
    to: mention.from + replacement.length,
  };
}

export function scoreKnowledgeQuickOpenEntry(
  entry: WikiDocumentEntry,
  rawQuery: string,
): KnowledgeQuickOpenMatch | null {
  const query = normalizeQuickOpenText(rawQuery.trim());
  if (!query) return { score: 0, matchKind: "name" };
  const name = normalizeQuickOpenText(entry.name);
  const path = normalizeQuickOpenText(entry.path);
  const tagQuery = query.startsWith("#") ? query.slice(1) : query;
  if (name === query) return { score: 0, matchKind: "name" };
  const exactAlias = entry.aliases.find((alias) => normalizeQuickOpenText(alias) === query);
  if (exactAlias) return { score: 100, matchKind: "alias", matchedAlias: exactAlias };

  const nameScore = quickOpenSubsequenceScore(name, query);
  if (Number.isFinite(nameScore)) return { score: 200 + nameScore, matchKind: "name" };
  const aliasMatches = entry.aliases
    .map((alias) => ({ alias, score: quickOpenSubsequenceScore(normalizeQuickOpenText(alias), query) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score);
  if (aliasMatches[0]) {
    return { score: 300 + aliasMatches[0].score, matchKind: "alias", matchedAlias: aliasMatches[0].alias };
  }
  const tagMatches = entry.tags
    .map((tag) => ({ tag, score: quickOpenSubsequenceScore(normalizeQuickOpenText(tag), tagQuery) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score);
  if (tagMatches[0]) {
    return {
      score: (query.startsWith("#") ? 50 : 400) + tagMatches[0].score,
      matchKind: "tag",
      matchedTag: tagMatches[0].tag,
    };
  }
  const pathScore = quickOpenSubsequenceScore(path, query);
  return Number.isFinite(pathScore) ? { score: 500 + pathScore, matchKind: "path" } : null;
}

export function wikiCompletionCandidates(index: WikiWorkspaceIndex, query: string, limit = 8): WikiCompletionCandidate[] {
  const expected = normalizeWikiPageName(query);
  return index.entries
    .map((entry) => {
      const matchedAlias = expected
        ? entry.aliases.find((alias) => normalizeWikiPageName(alias).includes(expected))
        : undefined;
      const nameExact = Boolean(expected) && entry.normalizedName === expected;
      const aliasExact = Boolean(expected) && entry.normalizedAliases.includes(expected);
      const nameIncludes = !expected || entry.normalizedName.includes(expected);
      if (!nameIncludes && !matchedAlias) return null;
      const rank = nameExact ? 0 : aliasExact ? 1 : nameIncludes ? 2 : 3;
      return { ...entry, matchedAlias, rank };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => left.rank - right.rank || compareWikiCandidatePaths(left.path, right.path))
    .slice(0, limit)
    .map(({ rank: _rank, ...entry }) => entry);
}

export function resolveWikiLink(target: WikiLinkTarget, source: FileNode[] | WikiWorkspaceIndex): WikiLinkResolution {
  const expected = normalizeWikiPageName(target.page);
  const index = Array.isArray(source) ? createWikiWorkspaceIndex(source) : source;
  const nameMatches = index.entries.filter((entry) => entry.normalizedName === expected);
  const aliasMatches = index.entries.filter((entry) => entry.normalizedAliases.includes(expected));
  const candidates = (nameMatches.length > 0 ? nameMatches : aliasMatches)
    .map((entry) => entry.path)
    .sort(compareWikiCandidatePaths);

  if (candidates.length === 0) return { status: "missing", candidates: [] };
  return {
    status: candidates.length > 1 ? "ambiguous" : "found",
    path: candidates[0],
    candidates,
  };
}

export function backlinksForPath(path: string, source: string, sourcePath: string, index?: WikiWorkspaceIndex) {
  return parseWikiLinks(source)
    .filter((link) => {
      if (!index) return normalizeWikiPageName(link.page) === normalizeWikiPageName(fileStem(path));
      const resolution = resolveWikiLink(link, index);
      return Boolean(resolution.path && samePath(resolution.path, path));
    })
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

export function removeWikiIndexEntry(index: WikiWorkspaceIndex, path: string) {
  const entryIndex = index.entries.findIndex((entry) => samePath(entry.path, path));
  if (entryIndex >= 0) index.entries.splice(entryIndex, 1);
}

function analyzeMarkdownKnowledge(markdown: string) {
  const records = markdownLineRecords(markdown);
  const structuralRanges = collectKnowledgeProtectedRanges(markdown, records);
  const links: ParsedWikiLink[] = [];
  const wikiPattern = /\[\[([^\]\n]+)\]\]/g;
  let wikiMatch: RegExpExecArray | null;
  while ((wikiMatch = wikiPattern.exec(markdown))) {
    const from = wikiMatch.index;
    const to = from + wikiMatch[0].length;
    if (rangeContainsOffset(structuralRanges, from)) continue;
    const target = parseWikiLinkBody(wikiMatch[1]);
    if (!target) continue;
    links.push({
      ...target,
      raw: wikiMatch[0],
      line: lineForOffset(records, from),
      from,
      to,
    });
  }

  const protectedForText = mergeRanges([
    ...structuralRanges,
    ...links.map((link) => ({ from: link.from, to: link.to })),
  ]);
  const inlineTags = collectInlineKnowledgeTags(markdown, records, protectedForText);
  const frontMatter = parseFrontMatterKnowledge(markdown);
  const tags = uniqueTags([...frontMatter.tags, ...inlineTags.map((tag) => tag.name)]);
  const searchableRanges = mergeRanges([
    ...protectedForText,
    ...inlineTags.map((tag) => ({ from: tag.from, to: tag.to })),
  ]);
  const searchableSegments: KnowledgeTextSegment[] = [];
  for (const record of records) {
    let cursor = record.from;
    const lineRanges = searchableRanges.filter((range) => range.from < record.to && range.to > record.from);
    for (const range of lineRanges) {
      const rangeFrom = Math.max(record.from, range.from);
      const rangeTo = Math.min(record.to, range.to);
      if (rangeFrom > cursor) pushKnowledgeSegment(searchableSegments, markdown, cursor, rangeFrom, record.line);
      cursor = Math.max(cursor, rangeTo);
    }
    if (cursor < record.to) pushKnowledgeSegment(searchableSegments, markdown, cursor, record.to, record.line);
  }

  return {
    aliases: frontMatter.aliases,
    tags,
    links,
    searchableSegments,
    linePreviews: records.map((record) => markdown.slice(record.from, record.to)),
  };
}

function parseFrontMatterKnowledge(markdown: string) {
  const match = markdown.match(/^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!match) return { aliases: [] as string[], tags: [] as string[] };
  try {
    const document = parseDocument(match[1]);
    if (document.errors.length > 0) return { aliases: [] as string[], tags: [] as string[] };
    const value = document.toJS() as Record<string, unknown> | null;
    const aliases: string[] = [];
    const tags: string[] = [];
    for (const [key, fieldValue] of Object.entries(value || {})) {
      const normalizedKey = key.toLocaleLowerCase();
      if (normalizedKey === "alias" || normalizedKey === "aliases") aliases.push(...aliasesFromValue(fieldValue));
      if (normalizedKey === "tag" || normalizedKey === "tags") tags.push(...tagsFromValue(fieldValue));
    }
    return {
      aliases: uniqueAliases(aliases),
      tags: uniqueTags(tags),
    };
  } catch {
    return { aliases: [] as string[], tags: [] as string[] };
  }
}

function collectKnowledgeProtectedRanges(
  markdown: string,
  records: Array<{ line: number; from: number; to: number; end: number }>,
) {
  const ranges: Array<{ from: number; to: number }> = [];
  const frontMatter = markdown.match(/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (frontMatter) ranges.push({ from: 0, to: frontMatter[0].length });

  let fence: { marker: string; length: number; from: number } | null = null;
  let math: { close: RegExp; from: number } | null = null;
  let html: { close: RegExp; from: number } | null = null;
  for (const record of records) {
    const line = markdown.slice(record.from, record.to);
    if (frontMatter && record.from < frontMatter[0].length) continue;
    if (fence) {
      const close = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        ranges.push({ from: fence.from, to: record.end });
        fence = null;
      }
      continue;
    }
    const fenceOpen = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fenceOpen) {
      fence = { marker: fenceOpen[1][0], length: fenceOpen[1].length, from: record.from };
      continue;
    }
    if (math) {
      if (math.close.test(line)) {
        ranges.push({ from: math.from, to: record.end });
        math = null;
      }
      continue;
    }
    const trimmed = line.trim();
    if (/^\$\$/.test(trimmed)) {
      if (/^\$\$[\s\S]+\$\$\s*$/.test(trimmed)) ranges.push({ from: record.from, to: record.end });
      else math = { close: /\$\$\s*$/, from: record.from };
      continue;
    }
    if (/^\\\[/.test(trimmed)) {
      if (/\\\]\s*$/.test(trimmed) && trimmed.length > 4) ranges.push({ from: record.from, to: record.end });
      else math = { close: /\\\]\s*$/, from: record.from };
      continue;
    }
    const environment = trimmed.match(/^\\begin\{([A-Za-z*]+)\}/);
    if (environment) {
      const escapedName = escapeRegExp(environment[1]);
      if (new RegExp(`\\\\end\\{${escapedName}\\}`).test(trimmed)) ranges.push({ from: record.from, to: record.end });
      else math = { close: new RegExp(`\\\\end\\{${escapedName}\\}`), from: record.from };
      continue;
    }
    if (html) {
      if (html.close.test(line)) {
        ranges.push({ from: html.from, to: record.end });
        html = null;
      }
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      if (/-->/.test(line)) ranges.push({ from: record.from, to: record.end });
      else html = { close: /-->/, from: record.from };
      continue;
    }
    const htmlBlock = line.match(/^\s*<(script|style|pre|iframe|div|section|table|details|figure|video|audio)\b/i);
    if (htmlBlock) {
      const close = new RegExp(`</${escapeRegExp(htmlBlock[1])}>`, "i");
      if (close.test(line)) ranges.push({ from: record.from, to: record.end });
      else html = { close, from: record.from };
      continue;
    }
    collectInlineProtectedRanges(line, record.from, ranges);
  }
  if (fence) ranges.push({ from: fence.from, to: markdown.length });
  if (math) ranges.push({ from: math.from, to: markdown.length });
  if (html) ranges.push({ from: html.from, to: markdown.length });
  return mergeRanges(ranges);
}

function collectInlineProtectedRanges(line: string, lineOffset: number, ranges: Array<{ from: number; to: number }>) {
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 1;
    while (line[index + run] === "`") run += 1;
    const marker = "`".repeat(run);
    const close = line.indexOf(marker, index + run);
    if (close < 0) {
      index += run;
      continue;
    }
    ranges.push({ from: lineOffset + index, to: lineOffset + close + run });
    index = close + run;
  }
  collectPatternRanges(line, lineOffset, /!?\[[^\]\n]*\]\([^\)\n]*\)/g, ranges);
  collectPatternRanges(line, lineOffset, /<(?:(?:https?|mailto):[^>\n]+|\/?[A-Za-z][^>\n]*)>/g, ranges);
  collectPatternRanges(line, lineOffset, /https?:\/\/[^\s<]+/g, ranges);
  collectPatternRanges(line, lineOffset, /\\./g, ranges);
  collectInlineMathRanges(line, lineOffset, ranges);
}

function collectInlineMathRanges(line: string, lineOffset: number, ranges: Array<{ from: number; to: number }>) {
  collectPatternRanges(line, lineOffset, /\\\([\s\S]*?\\\)/g, ranges);
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "$" || line[index - 1] === "\\" || line[index + 1] === "$") continue;
    const close = findUnescapedCharacter(line, "$", index + 1);
    if (close < 0) continue;
    ranges.push({ from: lineOffset + index, to: lineOffset + close + 1 });
    index = close;
  }
}

function collectInlineKnowledgeTags(
  markdown: string,
  records: Array<{ line: number; from: number; to: number }>,
  protectedRanges: Array<{ from: number; to: number }>,
) {
  const tags: Array<{ name: string; from: number; to: number; line: number }> = [];
  const pattern = /#[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*/gu;
  for (const record of records) {
    const line = markdown.slice(record.from, record.to);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      const localFrom = match.index;
      const from = record.from + localFrom;
      const to = from + match[0].length;
      const previous = line[localFrom - 1] || "";
      const name = match[0].slice(1);
      if (previous === "\\" || /[\p{L}\p{N}_/#]/u.test(previous)) continue;
      if (!/\p{L}/u.test(name)) continue;
      if (rangeOverlaps(protectedRanges, from, to)) continue;
      tags.push({ name, from, to, line: record.line });
    }
  }
  return tags;
}

function markdownLineRecords(markdown: string) {
  const records: Array<{ line: number; from: number; to: number; end: number }> = [];
  let from = 0;
  let line = 0;
  while (from <= markdown.length) {
    const lf = markdown.indexOf("\n", from);
    const end = lf < 0 ? markdown.length : lf + 1;
    const rawTo = lf < 0 ? markdown.length : lf;
    const to = rawTo > from && markdown[rawTo - 1] === "\r" ? rawTo - 1 : rawTo;
    records.push({ line, from, to, end });
    if (lf < 0) break;
    from = end;
    line += 1;
  }
  return records;
}

function pushKnowledgeSegment(
  segments: KnowledgeTextSegment[],
  markdown: string,
  from: number,
  to: number,
  line: number,
) {
  if (to <= from) return;
  const text = markdown.slice(from, to);
  if (!text.trim()) return;
  segments.push({ text, from, to, line });
}

function lineForOffset(records: Array<{ line: number; from: number; end: number }>, offset: number) {
  return records.find((record) => offset >= record.from && offset < record.end)?.line ?? Math.max(records.length - 1, 0);
}

function collectPatternRanges(
  line: string,
  lineOffset: number,
  pattern: RegExp,
  ranges: Array<{ from: number; to: number }>,
) {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    ranges.push({ from: lineOffset + match.index, to: lineOffset + match.index + match[0].length });
  }
}

function mergeRanges(ranges: Array<{ from: number; to: number }>) {
  const sorted = ranges.filter((range) => range.to > range.from).sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.from > previous.to) merged.push({ ...range });
    else previous.to = Math.max(previous.to, range.to);
  }
  return merged;
}

function rangeContainsOffset(ranges: Array<{ from: number; to: number }>, offset: number) {
  return ranges.some((range) => offset >= range.from && offset < range.to);
}

function rangeOverlaps(ranges: Array<{ from: number; to: number }>, from: number, to: number) {
  return ranges.some((range) => from < range.to && to > range.from);
}

function findUnescapedCharacter(value: string, character: string, start: number) {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] !== character) continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashCount += 1;
    if (slashCount % 2 === 0) return index;
  }
  return -1;
}

function parseWikiLinkBody(body: string): WikiLinkTarget | null {
  const [pagePart, headingPart] = body.split("#", 2);
  const page = pagePart.trim();
  if (!page) return null;
  const heading = headingPart?.trim() || undefined;
  return { page, heading };
}

function compareWikiCandidatePaths(left: string, right: string) {
  const leftDepth = left.replace(/\\/g, "/").split("/").length;
  const rightDepth = right.replace(/\\/g, "/").split("/").length;
  return leftDepth - rightDepth || left.localeCompare(right, "zh-Hans-CN");
}

function createWikiDocumentEntry(path: string, root: string): WikiDocumentEntry {
  const name = fileStem(path);
  return {
    path,
    name,
    relativePath: relativeWikiPath(path, root),
    normalizedName: normalizeWikiPageName(name),
    aliases: [],
    normalizedAliases: [],
    tags: [],
    normalizedTags: [],
    links: [],
    searchableSegments: [],
    linePreviews: [],
    indexed: false,
  };
}

function aliasesFromValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function tagsFromValue(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? item.split(/[\s,]+/) : []);
  return [];
}

function uniqueAliases(values: string[]) {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const normalized = normalizeWikiPageName(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function uniqueTags(values: string[]) {
  const seen = new Set<string>();
  return values.map((value) => value.trim().replace(/^#+/, "")).filter((value) => {
    const normalized = normalizeTagName(value);
    if (!normalized || !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(value) || !/\p{L}/u.test(value) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function normalizeTagName(value: string) {
  return value.trim().replace(/^#+/, "").toLocaleLowerCase();
}

function normalizeQuickOpenText(value: string) {
  return value.replace(/\\/g, "/").toLocaleLowerCase();
}

function quickOpenSubsequenceScore(value: string, query: string) {
  let valueIndex = 0;
  let score = 0;
  let previousMatch = -1;
  for (const char of query) {
    const match = value.indexOf(char, valueIndex);
    if (match < 0) return Number.POSITIVE_INFINITY;
    score += match;
    if (previousMatch >= 0) score += Math.max(0, match - previousMatch - 1);
    previousMatch = match;
    valueIndex = match + 1;
  }
  return score + value.length / 1000;
}

function isEligibleMentionName(value: string) {
  const length = [...value.trim()].length;
  return /[^\x00-\x7f]/.test(value) ? length >= 2 : length >= 3;
}

function mentionBoundariesMatch(text: string, from: number, to: number, name: string) {
  if (/[^\x00-\x7f]/.test(name)) return true;
  const previous = text[from - 1] || "";
  const next = text[to] || "";
  return !/[\p{L}\p{N}_]/u.test(previous) && !/[\p{L}\p{N}_]/u.test(next);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relativeWikiPath(path: string, root: string) {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalizedRoot && normalizedPath.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return fileName(path);
}

function samePath(left: string, right: string) {
  return left.replace(/\\/g, "/").toLocaleLowerCase() === right.replace(/\\/g, "/").toLocaleLowerCase();
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
