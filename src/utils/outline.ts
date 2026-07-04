import type { OutlineItem } from "../types";

export interface OutlineItemWithLine extends OutlineItem {
  line: number;
}

export function extractOutline(markdown: string): OutlineItem[] {
  return extractOutlineWithLines(markdown).map(({ line: _line, ...item }) => item);
}

export function extractOutlineWithLines(markdown: string): OutlineItemWithLine[] {
  return markdown
    .split(/\r?\n/)
    .map((line, lineIndex) => ({ lineIndex, match: line.match(/^(#{1,6})\s+(.+)$/) }))
    .filter((item): item is { lineIndex: number; match: RegExpMatchArray } => Boolean(item.match))
    .map(({ lineIndex, match }, index) => {
      const text = match[2].replace(/[#*_`[\]()]/g, "").trim();
      return {
        id: `heading-${index}-${slugify(text)}`,
        text,
        level: match[1].length as any,
        line: lineIndex,
      };
    });
}

export function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
}
