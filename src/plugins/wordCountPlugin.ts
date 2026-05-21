import { appStore } from "../stores/appStore";
import type { LightMarkPlugin } from "./types";

export function getWordStats(content: string) {
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  return {
    words,
    chars: content.length,
    lines: content ? content.split(/\r?\n/).length : 0,
  };
}

export const wordCountPlugin: LightMarkPlugin = {
  manifest: {
    id: "word-count-plugin",
    name: "字数统计",
    version: "0.1.0",
    description: "显示当前文档的词数、字符数和行数。",
    author: "LightMark",
  },
  activate(context) {
    context.registerCommand("显示字数统计", () => {
      appStore.wordCountOpen = true;
    });
  },
};
