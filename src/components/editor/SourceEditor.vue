<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { appStore, setContent } from "../../stores/appStore";

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
let applyingExternalChange = false;

const minimalTheme = EditorView.theme({
  "&": {
    "--lm-cm-heading-1": "#1f1e1b",
    "--lm-cm-heading-2": "#2b2925",
    "--lm-cm-heading": "#3b3833",
    "--lm-cm-strong": "#2b2925",
    "--lm-cm-emphasis": "#3b3833",
    "--lm-cm-muted": "#756f66",
    "--lm-cm-faint": "#b9b3a8",
    "--lm-cm-punctuation": "#9b9488",
    "--lm-cm-accent": "#8f6b3d",
    "--lm-cm-accent-dark": "#77573a",
    "--lm-cm-code": "#5b4630",
    "--lm-cm-code-bg": "rgba(143, 107, 61, 0.11)",
    backgroundColor: "transparent",
    color: "#1f1e1b",
    fontSize: "15px",
  },
  ".cm-content": {
    caretColor: "#1f1e1b",
    maxWidth: "860px",
    margin: "0 auto",
    padding: "0 32px",
  },
  ".cm-cursor": {
    borderLeftColor: "#1f1e1b",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#ebe7df",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "#756f66",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "#b9b3a8",
    border: "0",
  },
  ".cm-scroller": {
    fontFamily: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Consolas, monospace",
    lineHeight: "1.75",
    padding: "32px 0",
  },
  ".cm-line": {
    padding: "0 2px",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "#f5f3ee",
    borderColor: "#e7e1d7",
    color: "#756f66",
  },
  ".dark &": {
    "--lm-cm-heading-1": "#f5f1e8",
    "--lm-cm-heading-2": "#eee7dc",
    "--lm-cm-heading": "#e8e5df",
    "--lm-cm-strong": "#f5f1e8",
    "--lm-cm-emphasis": "#e8e5df",
    "--lm-cm-muted": "#b9b3a8",
    "--lm-cm-faint": "#756f66",
    "--lm-cm-punctuation": "#8b8377",
    "--lm-cm-accent": "#d6b985",
    "--lm-cm-accent-dark": "#c9a66d",
    "--lm-cm-code": "#f0d49c",
    "--lm-cm-code-bg": "rgba(214, 185, 133, 0.12)",
    color: "#e8e5df",
  },
  ".dark & .cm-content": {
    caretColor: "#e8e5df",
  },
  ".dark & .cm-cursor": {
    borderLeftColor: "#e8e5df",
  },
  ".dark & .cm-selectionBackground, .dark &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#2a2926",
  },
  ".dark & .cm-foldPlaceholder": {
    backgroundColor: "#1b1a18",
    borderColor: "#3b3833",
    color: "#b9b3a8",
  },
});

const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.35em", fontWeight: "700", color: "var(--lm-cm-heading-1)" },
  { tag: t.heading2, fontSize: "1.2em", fontWeight: "700", color: "var(--lm-cm-heading-2)" },
  { tag: t.heading3, fontSize: "1.08em", fontWeight: "700", color: "var(--lm-cm-heading)" },
  { tag: t.heading, fontWeight: "700", color: "var(--lm-cm-heading)" },
  { tag: t.strong, fontWeight: "700", color: "var(--lm-cm-strong)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--lm-cm-emphasis)" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--lm-cm-muted)" },
  { tag: t.monospace, color: "var(--lm-cm-code)", backgroundColor: "var(--lm-cm-code-bg)" },
  { tag: t.link, color: "var(--lm-cm-accent-dark)", textDecoration: "underline", textUnderlineOffset: "3px" },
  { tag: t.url, color: "var(--lm-cm-accent)" },
  { tag: t.quote, color: "var(--lm-cm-muted)", fontStyle: "italic" },
  { tag: t.list, color: "var(--lm-cm-accent)", fontWeight: "600" },
  { tag: t.processingInstruction, color: "var(--lm-cm-faint)" },
  { tag: t.meta, color: "var(--lm-cm-faint)" },
  { tag: t.punctuation, color: "var(--lm-cm-punctuation)" },
  { tag: t.keyword, color: "var(--lm-cm-accent-dark)", fontWeight: "600" },
  { tag: t.atom, color: "var(--lm-cm-accent)" },
  { tag: t.contentSeparator, color: "var(--lm-cm-faint)" },
]);

function extensions() {
  return [
    lineNumbers(),
    keymap.of([]),
    markdown(),
    syntaxHighlighting(markdownHighlightStyle),
    EditorView.lineWrapping,
    minimalTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingExternalChange) {
        setContent(update.state.doc.toString(), true);
      }
    }),
  ];
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: appStore.currentContent,
      extensions: extensions(),
    }),
  });
});

watch(
  () => appStore.currentFilePath,
  () => {
    if (!view) return;
    applyingExternalChange = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: appStore.currentContent },
    });
    applyingExternalChange = false;
  },
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="host" class="h-full bg-paper-50 text-base dark:bg-paper-950" />
</template>
