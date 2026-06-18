<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { appStore, setContent } from "../../stores/appStore";
import { findOptions, findReplaceStore, setFindResult } from "../../stores/findReplaceStore";
import { findTextMatches, normalizeMatchIndex, replacementForMatch, type TextMatch } from "../../utils/findReplace";
import { getImageFilesFromClipboard, getImageFilesFromDrop, imagePathsAsMarkdown, saveImagesAsMarkdown } from "../../utils/imageAssets";

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
let applyingExternalChange = false;
let sourceFindMatches: TextMatch[] = [];

const setSourceFindDecorations = StateEffect.define<DecorationSet>();
const sourceFindField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSourceFindDecorations)) return effect.value;
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

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
    "--lm-cm-html-tag": "#8f6b3d",
    "--lm-cm-html-attr": "#756f66",
    "--lm-cm-html-comment": "#8c9473",
    backgroundColor: "transparent",
    color: "#1f1e1b",
    fontSize: "15px",
  },
  ".cm-content": {
    caretColor: "#1f1e1b",
    maxWidth: "var(--lm-editor-width)",
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
    fontFamily: "var(--lm-editor-code-font-family)",
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
    "--lm-cm-html-tag": "#d6b985",
    "--lm-cm-html-attr": "#b9b3a8",
    "--lm-cm-html-comment": "#8d9b78",
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
  { tag: t.tagName, color: "var(--lm-cm-html-tag)", fontWeight: "600" },
  { tag: t.attributeName, color: "var(--lm-cm-html-attr)" },
  { tag: t.comment, color: "var(--lm-cm-html-comment)" },
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
    sourceFindField,
    markdown(),
    syntaxHighlighting(markdownHighlightStyle),
    EditorView.lineWrapping,
    EditorView.domEventHandlers({
      paste(event, currentView) {
        const files = getImageFilesFromClipboard(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertImageFilesIntoSource(files, currentView);
        return true;
      },
      dragover(event) {
        if (getImageFilesFromDrop(event.dataTransfer).length === 0) return false;
        event.preventDefault();
        return true;
      },
      drop(event, currentView) {
        const files = getImageFilesFromDrop(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const position = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
        void insertImageFilesIntoSource(files, currentView, position ?? currentView.state.doc.length);
        return true;
      },
    }),
    minimalTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingExternalChange) {
        setContent(update.state.doc.toString(), true);
        if (findReplaceStore.open && findReplaceStore.query) window.setTimeout(refreshSourceFind, 0);
      }
    }),
  ];
}

async function insertImageFilesIntoSource(files: File[], currentView: EditorView, position?: number) {
  const markdown = await saveImagesAsMarkdown(files);
  if (!markdown) return;
  insertImageMarkdownIntoSource(markdown, currentView, position);
}

async function insertImagePathsIntoSource(paths: string[], currentView: EditorView, position?: number) {
  const markdown = await imagePathsAsMarkdown(paths);
  if (!markdown) return;
  insertImageMarkdownIntoSource(markdown, currentView, position);
}

function insertImageMarkdownIntoSource(markdown: string, currentView: EditorView, position?: number) {
  const state = currentView.state;
  const from = position ?? state.selection.main.from;
  const to = position ?? state.selection.main.to;
  const insert = withBlockSpacing(state.doc.toString(), from, to, markdown);
  currentView.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
  });
  currentView.focus();
}

function withBlockSpacing(documentText: string, from: number, to: number, markdown: string) {
  const before = documentText.slice(0, from);
  const after = documentText.slice(to);
  const prefix = before.trim().length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = after.trim().length === 0 ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${markdown}${suffix}`;
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
  restorePendingSourceCursor();
  window.addEventListener("lightmark:capture-mode-cursor", handleModeCursorCapture as EventListener);
  window.addEventListener("lightmark:insert-images", handleGlobalImageInsert as EventListener);
  window.addEventListener("lightmark:find-command", handleFindCommand as EventListener);
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
  window.removeEventListener("lightmark:capture-mode-cursor", handleModeCursorCapture as EventListener);
  window.removeEventListener("lightmark:insert-images", handleGlobalImageInsert as EventListener);
  window.removeEventListener("lightmark:find-command", handleFindCommand as EventListener);
  view?.destroy();
  view = null;
});

function handleModeCursorCapture(event: CustomEvent<{ from?: string; to?: string }>) {
  if (appStore.editorMode !== "source" || event.detail?.to !== "wysiwyg" || !view) return;
  setContent(view.state.doc.toString(), true);
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.anchor);
  appStore.pendingModeCursor = {
    targetMode: "wysiwyg",
    markdownAnchor: selection.anchor,
    markdownHead: selection.head,
    markdownLine: line.number,
    markdownColumn: selection.anchor - line.from,
    markdownLineText: line.text,
    reason: "mode-switch",
  };
}

function restorePendingSourceCursor() {
  const pending = appStore.pendingModeCursor;
  if (!view || !pending || pending.targetMode !== "source") return;
  appStore.pendingModeCursor = null;
  const docLength = view.state.doc.length;
  const anchor = clampOffset(pending.markdownAnchor, docLength);
  const head = clampOffset(pending.markdownHead, docLength);
  window.requestAnimationFrame(() => {
    if (!view) return;
    view.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    view.focus();
  });
}

function clampOffset(value: number, max: number) {
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, max));
}

function handleFindCommand(event: CustomEvent<string>) {
  if (appStore.editorMode !== "source" || appStore.documentMode !== "normal" || !view) return;
  const command = event.detail || "refresh";
  if (command === "next" || command === "previous") {
    navigateSourceFind(command === "next" ? 1 : -1);
    return;
  }
  if (command === "replaceCurrent") {
    replaceCurrentSourceFind();
    return;
  }
  if (command === "replaceAll") {
    replaceAllSourceFind();
    return;
  }
  refreshSourceFind();
}

function refreshSourceFind() {
  if (!view) return;
  if (!findReplaceStore.open || !findReplaceStore.query) {
    sourceFindMatches = [];
    setFindResult(0, -1, "");
    applySourceFindDecorations(-1);
    return;
  }
  const result = findTextMatches(view.state.doc.toString(), findReplaceStore.query, findOptions());
  sourceFindMatches = result.matches;
  const current = findReplaceStore.currentIndex < 0 ? 0 : normalizeMatchIndex(findReplaceStore.currentIndex, sourceFindMatches.length);
  setFindResult(sourceFindMatches.length, current, result.error);
  applySourceFindDecorations(current);
}

function navigateSourceFind(delta: 1 | -1) {
  if (!view) return;
  refreshSourceFind();
  if (findReplaceStore.error || sourceFindMatches.length === 0) return;
  const current = normalizeMatchIndex(findReplaceStore.currentIndex + delta, sourceFindMatches.length);
  const match = sourceFindMatches[current];
  setFindResult(sourceFindMatches.length, current, "");
  applySourceFindDecorations(current);
  view.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: EditorView.scrollIntoView(match.from, { y: "center" }),
  });
  view.focus();
}

function replaceCurrentSourceFind() {
  if (!view) return;
  refreshSourceFind();
  const current = normalizeMatchIndex(findReplaceStore.currentIndex, sourceFindMatches.length);
  const match = sourceFindMatches[current];
  if (!match || findReplaceStore.error) return;
  const insert = replacementForMatch(match, findReplaceStore.replaceText, findReplaceStore.regex);
  view.dispatch({
    changes: { from: match.from, to: match.to, insert },
    selection: { anchor: match.from + insert.length },
    scrollIntoView: true,
  });
  refreshSourceFind();
}

function replaceAllSourceFind() {
  if (!view) return;
  refreshSourceFind();
  if (findReplaceStore.error || sourceFindMatches.length === 0) return;
  const changes = [...sourceFindMatches].reverse().map((match) => ({
    from: match.from,
    to: match.to,
    insert: replacementForMatch(match, findReplaceStore.replaceText, findReplaceStore.regex),
  }));
  view.dispatch({ changes, scrollIntoView: true });
  appStore.statusMessage = `已替换 ${changes.length} 处`;
  refreshSourceFind();
}

function applySourceFindDecorations(currentIndex: number) {
  if (!view) return;
  const decorations = sourceFindMatches.map((match, index) =>
    Decoration.mark({
      class: index === currentIndex ? "lm-find-match lm-find-match-current" : "lm-find-match",
    }).range(match.from, match.to),
  );
  view.dispatch({ effects: setSourceFindDecorations.of(Decoration.set(decorations, true)) });
}

function handleGlobalImageInsert(event: CustomEvent<{ files?: File[]; paths?: string[]; position?: { x?: number; y?: number } }>) {
  if (appStore.editorMode !== "source" || appStore.documentMode !== "normal" || !view) return;
  const files = event.detail?.files || [];
  const paths = event.detail?.paths || [];
  if (files.length === 0 && paths.length === 0) return;
  const position =
    typeof event.detail?.position?.x === "number" && typeof event.detail.position.y === "number"
      ? view.posAtCoords({ x: event.detail.position.x, y: event.detail.position.y }) ?? view.state.doc.length
      : view.state.doc.length;
  if (paths.length > 0) {
    void insertImagePathsIntoSource(paths, view, position);
    return;
  }
  void insertImageFilesIntoSource(files, view, position);
}
</script>

<template>
  <div ref="host" class="h-full bg-paper-50 text-base dark:bg-paper-950" />
</template>
