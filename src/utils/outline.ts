import type { OutlineItem } from "../types";

export function extractOutline(markdown: string): OutlineItem[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^(#{1,3})\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match, index) => {
      const text = match[2].replace(/[#*_`[\]()]/g, "").trim();
      return {
        id: `heading-${index}-${slugify(text)}`,
        text,
        level: match[1].length as 1 | 2 | 3,
      };
    });
}

export function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
}
