import type { OutlineItem } from "../types";

export interface OutlineItemWithLine extends OutlineItem {
  line: number;
}

export interface BreadcrumbItem extends OutlineItemWithLine {}

export function extractOutline(markdown: string): OutlineItem[] {
  return extractOutlineWithLines(markdown).map(({ line: _line, ...item }) => item);
}

export function extractOutlineWithLines(markdown: string): OutlineItemWithLine[] {
  const items: OutlineItemWithLine[] = [];
  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; length: number } | null = null;
  let frontMatter = lines[0]?.trim() === "---";
  let mathBlock = false;
  let htmlBlock = false;

  lines.forEach((line, lineIndex) => {
    if (frontMatter) {
      if (lineIndex > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontMatter = false;
      return;
    }
    if (fence) {
      const close = line.match(/^\s*(`+|~+)\s*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
      return;
    }
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      return;
    }
    if (mathBlock) {
      if (/^\s*\$\$\s*$/.test(line)) mathBlock = false;
      return;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      mathBlock = true;
      return;
    }
    if (htmlBlock) {
      if (!line.trim() || /-->\s*$/.test(line) || /<\/[^>]+>\s*$/.test(line)) htmlBlock = false;
      return;
    }
    if (isHtmlBlockStart(line)) {
      htmlBlock = !(/-->\s*$/.test(line) || /<\/[^>]+>\s*$/.test(line));
      return;
    }

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) return;
    const text = match[2].replace(/[#*_`[\]()]/g, "").trim();
    items.push({
      id: `heading-${items.length}-${slugify(text)}`,
      text,
      level: match[1].length as OutlineItem["level"],
      line: lineIndex,
    });
  });
  return items;
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

function isHtmlBlockStart(line: string) {
  return /^\s*(?:<!--|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|>|\/))/i.test(line);
}
