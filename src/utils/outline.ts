import type { OutlineItem } from "../types";

export interface OutlineItemWithLine extends OutlineItem {
}

export interface BreadcrumbItem extends OutlineItemWithLine {}

export interface OutlineScanState {
  fence: { marker: string; length: number } | null;
  frontMatter: boolean;
  mathBlock: boolean;
  htmlBlock: boolean;
}

export function createOutlineScanState(firstLine = ""): OutlineScanState {
  return {
    fence: null,
    frontMatter: firstLine.trim() === "---",
    mathBlock: false,
    htmlBlock: false,
  };
}

export function scanOutlineLine(line: string, lineIndex: number, state: OutlineScanState): OutlineItemWithLine | null {
  if (state.frontMatter) {
    if (lineIndex > 0 && /^(---|\.\.\.)\s*$/.test(line)) state.frontMatter = false;
    return null;
  }
  if (state.fence) {
    const close = line.match(/^\s*(`+|~+)\s*$/);
    if (close && close[1][0] === state.fence.marker && close[1].length >= state.fence.length) state.fence = null;
    return null;
  }
  const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
  if (fenceMatch) {
    state.fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
    return null;
  }
  if (state.mathBlock) {
    if (/^\s*\$\$\s*$/.test(line)) state.mathBlock = false;
    return null;
  }
  if (/^\s*\$\$\s*$/.test(line)) {
    state.mathBlock = true;
    return null;
  }
  if (state.htmlBlock) {
    if (!line.trim() || /-->\s*$/.test(line) || /<\/[^>]+>\s*$/.test(line)) state.htmlBlock = false;
    return null;
  }
  if (isHtmlBlockStart(line)) {
    state.htmlBlock = !(/-->\s*$/.test(line) || /<\/[^>]+>\s*$/.test(line));
    return null;
  }
  const match = line.match(/^(#{1,6})\s+(.+)$/);
  if (!match) return null;
  const text = match[2].replace(/[#*_`[\]()]/g, "").trim();
  return {
    id: `heading-${lineIndex}-${slugify(text)}`,
    text,
    level: match[1].length as OutlineItem["level"],
    line: lineIndex,
  };
}

export interface StructuredOutlineItem extends OutlineItemWithLine {
  key: string;
  parentKey: string | null;
  ancestorKeys: string[];
  sectionEndLine: number;
  hasChildren: boolean;
}

export function extractOutline(markdown: string): OutlineItem[] {
  return extractOutlineWithLines(markdown);
}

export function extractOutlineWithLines(markdown: string): OutlineItemWithLine[] {
  const items: OutlineItemWithLine[] = [];
  const lines = markdown.split(/\r?\n/);
  const state = createOutlineScanState(lines[0]);

  lines.forEach((line, lineIndex) => {
    const item = scanOutlineLine(line, lineIndex, state);
    if (item) items.push(item);
  });
  return items;
}

export function structureOutline(
  items: OutlineItemWithLine[],
  totalLines = Math.max(1, items.at(-1)?.line ?? 0) + 1,
): StructuredOutlineItem[] {
  const result: StructuredOutlineItem[] = [];
  const ancestors: StructuredOutlineItem[] = [];
  const siblingCounts = new Map<string, number>();

  for (const item of items) {
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= item.level) ancestors.pop();
    const parentKey = ancestors.at(-1)?.key ?? null;
    const segment = `${item.level}:${normalizeHeadingKeyText(item.text) || "untitled"}`;
    const siblingScope = `${parentKey ?? "root"}\u0000${segment}`;
    const occurrence = siblingCounts.get(siblingScope) ?? 0;
    siblingCounts.set(siblingScope, occurrence + 1);
    const key = `${parentKey ? `${parentKey}/` : ""}${segment}[${occurrence}]`;
    const structured: StructuredOutlineItem = {
      ...item,
      key,
      parentKey,
      ancestorKeys: ancestors.map((ancestor) => ancestor.key),
      sectionEndLine: totalLines,
      hasChildren: false,
    };
    result.push(structured);
    ancestors.push(structured);
  }

  const openSections: StructuredOutlineItem[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const item = result[index];
    item.hasChildren = Boolean(result[index + 1] && result[index + 1].level > item.level);
    while (openSections.length > 0 && openSections[openSections.length - 1].level >= item.level) {
      openSections.pop()!.sectionEndLine = item.line;
    }
    openSections.push(item);
  }

  return result;
}

export function visibleOutlineItems(
  outline: StructuredOutlineItem[],
  collapsedKeys: Iterable<string>,
) {
  const collapsed = collapsedKeys instanceof Set ? collapsedKeys : new Set(collapsedKeys);
  return outline.filter((item) => !item.ancestorKeys.some((key) => collapsed.has(key)));
}

export function resolveActiveOutlineItem(
  outline: StructuredOutlineItem[],
  line: number,
) {
  const targetLine = Math.max(0, Number.isFinite(line) ? Math.floor(line) : 0);
  let active: StructuredOutlineItem | null = null;
  for (const item of outline) {
    if (item.line > targetLine) break;
    active = item;
  }
  return active;
}

export function resolveHeadingSection(
  outline: StructuredOutlineItem[],
  line: number,
) {
  const active = resolveActiveOutlineItem(outline, line);
  return active && line < active.sectionEndLine ? active : null;
}

export function reconcileCollapsedKeys(
  outline: StructuredOutlineItem[],
  keys: Iterable<string>,
) {
  const valid = new Set(outline.map((item) => item.key));
  return Array.from(new Set(keys)).filter((key) => valid.has(key));
}

export function resolveHeadingBreadcrumb(outline: OutlineItemWithLine[], line: number): BreadcrumbItem[] {
  const trail: BreadcrumbItem[] = [];
  const targetLine = Math.max(0, Number.isFinite(line) ? Math.floor(line) : 0);
  for (const item of outline) {
    if (item.line > targetLine) break;
    while (trail.length > 0 && trail[trail.length - 1].level >= item.level) trail.pop();
    trail.push(item);
  }
  return trail;
}

export function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeHeadingKeyText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[/%[\]\u0000-\u001f]/g, "-")
    .trim();
}

function isHtmlBlockStart(line: string) {
  return /^\s*(?:<!--|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|>|\/))/i.test(line);
}
