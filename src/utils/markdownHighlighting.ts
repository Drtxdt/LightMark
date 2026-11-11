import hljs from 'highlight.js/lib/core';
import { ensureLowlightLanguage } from '../editor/lowlightLanguages';

const highlighter = {
  registered: (language: string) => Boolean(hljs.getLanguage(language)),
  register: (language: string, grammar: unknown) => hljs.registerLanguage(language, grammar as Parameters<typeof hljs.registerLanguage>[1]),
  highlight: (language: string, value: string) => hljs.highlight(value, { language }),
};

/** Loading grammar code is a preview/export boundary, never an input rule. */
export async function prepareMarkdownLanguages(markdown: string) {
  const languages = new Set<string>();
  for (const match of markdown.matchAll(/^\s*(?:`{3,}|~{3,})\s*([\w+-]+)/gm)) languages.add(match[1]);
  await Promise.all([...languages].map(language => ensureLowlightLanguage(highlighter, language)));
}
