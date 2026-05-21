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
    name: "Word Count",
    version: "0.1.0",
    description: "Shows word, character, and line counts for the current document.",
    author: "LightMark",
  },
  activate(context) {
    context.registerCommand("Show Word Count", () => {
      appStore.wordCountOpen = true;
    });
  },
};
