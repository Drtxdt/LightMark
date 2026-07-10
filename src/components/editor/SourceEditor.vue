<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import {
  appStore,
  consumePanePendingEditorPosition,
  getPaneContent,
  getPaneDocumentMode,
  getPaneEditorMode,
  getPanePendingModeCursor,
  getPaneTab,
  setPaneContent,
  setPanePendingModeCursor,
  updatePanePosition,
} from "../../stores/appStore";
import { findOptions, findReplaceStore, setFindResult } from "../../stores/findReplaceStore";
import { findTextMatches, normalizeMatchIndex, replacementForMatch, type TextMatch } from "../../utils/findReplace";
import { getImageFilesFromClipboard, getImageFilesFromDrop, imagePathsAsMarkdown, saveImagesAsMarkdown } from "../../utils/imageAssets";
import { buildEditorPositionSnapshot, scrollTopFromSnapshot } from "../../utils/editorPosition";
import { flattenMarkdownFiles } from "../../utils/wikiLinks";
import type { EditorPaneId } from "../../types";

const props = withDefaults(defineProps<{ paneId?: EditorPaneId }>(), {
  paneId: "main",
});

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
let applyingExternalChange = false;
let sourceFindMatches: TextMatch[] = [];
const wikiCompletion = ref({
  visible: false,
  query: "",
  from: 0,
  to: 0,
  x: 0,
  y: 0,
  highlightedIndex: 0,
});

const wikiCompletionCandidates = computed(() => {
  const query = wikiCompletion.value.query.trim().toLocaleLowerCase();
  return flattenMarkdownFiles(appStore.fileTree)
    .map((path) => fileStem(path))
    .filter((name, index, names) => names.findIndex((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase()) === index)
    .filter((name) => !query || name.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))
    .slice(0, 8);
});
const paneTab = computed(() => getPaneTab(props.paneId));
const paneContent = computed(() => getPaneContent(props.paneId));
const paneEditorMode = computed(() => getPaneEditorMode(props.paneId));
const paneDocumentMode = computed(() => getPaneDocumentMode(props.paneId));

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
      keydown(event, currentView) {
        if (!wikiCompletion.value.visible) return false;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveWikiCompletion(1);
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveWikiCompletion(-1);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          chooseWikiCompletion(currentView);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeWikiCompletion();
          return true;
        }
        return false;
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
      scroll(_event, currentView) {
        captureSourcePosition(currentView);
        return false;
      },
    }),
    minimalTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingExternalChange) {
        setPaneContent(props.paneId, update.state.doc.toString(), true);
        if (findReplaceStore.open && findReplaceStore.query) window.setTimeout(refreshSourceFind, 0);
      }
      if (update.docChanged || update.selectionSet) updateWikiCompletion(update.view);
      if (update.docChanged || update.selectionSet) captureSourcePosition(update.view);
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
      doc: paneContent.value,
      extensions: extensions(),
    }),
  });
  restorePendingSourceCursor();
  restorePendingSourcePosition();
  window.addEventListener("lightmark:capture-mode-cursor", handleModeCursorCapture as EventListener);
  window.addEventListener("lightmark:restore-position", handleRestorePosition as EventListener);
  window.addEventListener("lightmark:insert-images", handleGlobalImageInsert as EventListener);
  window.addEventListener("lightmark:find-command", handleFindCommand as EventListener);
  window.addEventListener("lightmark:jump-line", handleJumpLine as EventListener);
  window.addEventListener("lightmark:jump-heading", handleJumpHeading as EventListener);
});

watch(
  () => paneTab.value?.id || "",
  () => {
    if (!view) return;
    applyingExternalChange = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: paneContent.value },
    });
    applyingExternalChange = false;
    restorePendingSourcePosition();
  },
);

onBeforeUnmount(() => {
  window.removeEventListener("lightmark:capture-mode-cursor", handleModeCursorCapture as EventListener);
  window.removeEventListener("lightmark:restore-position", handleRestorePosition as EventListener);
  window.removeEventListener("lightmark:insert-images", handleGlobalImageInsert as EventListener);
  window.removeEventListener("lightmark:find-command", handleFindCommand as EventListener);
  window.removeEventListener("lightmark:jump-line", handleJumpLine as EventListener);
  window.removeEventListener("lightmark:jump-heading", handleJumpHeading as EventListener);
  view?.destroy();
  view = null;
});

function handleModeCursorCapture(event: CustomEvent<{ from?: string; to?: string; paneId?: EditorPaneId }>) {
  if (event.detail?.paneId !== props.paneId || paneEditorMode.value !== "source" || event.detail?.to !== "wysiwyg" || !view) return;
  setPaneContent(props.paneId, view.state.doc.toString(), true);
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.anchor);
  setPanePendingModeCursor(props.paneId, {
    targetMode: "wysiwyg",
    markdownAnchor: selection.anchor,
    markdownHead: selection.head,
    markdownLine: line.number,
    markdownColumn: selection.anchor - line.from,
    markdownLineText: line.text,
    reason: "mode-switch",
  });
}

function restorePendingSourceCursor() {
  const pending = getPanePendingModeCursor(props.paneId);
  if (!view || !pending || pending.targetMode !== "source") return;
  setPanePendingModeCursor(props.paneId, null);
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

function captureSourcePosition(currentView = view) {
  if (!currentView || paneEditorMode.value !== "source" || paneDocumentMode.value !== "normal") return;
  const scroller = currentView.scrollDOM;
  const selection = currentView.state.selection.main;
  updatePanePosition(
    props.paneId,
    buildEditorPositionSnapshot({
      editorMode: "source",
      markdown: currentView.state.doc.toString(),
      markdownAnchor: selection.anchor,
      markdownHead: selection.head,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    }),
  );
}

function restorePendingSourcePosition() {
  const position = consumePanePendingEditorPosition(props.paneId, "source");
  if (position) restoreSourcePosition(position);
}

function handleRestorePosition(event: CustomEvent) {
  if (event.detail?.paneId && event.detail.paneId !== props.paneId) return;
  if (paneEditorMode.value !== "source" || paneDocumentMode.value !== "normal") return;
  restoreSourcePosition(event.detail);
}

function restoreSourcePosition(position: any) {
  if (!view || !position || position.editorMode !== "source") return;
  const docLength = view.state.doc.length;
  const anchor = clampOffset(position.markdownAnchor, docLength);
  const head = clampOffset(position.markdownHead, docLength);
  window.requestAnimationFrame(() => {
    if (!view) return;
    view.dispatch({ selection: { anchor, head } });
    view.scrollDOM.scrollTop = scrollTopFromSnapshot(position, view.scrollDOM.scrollHeight, view.scrollDOM.clientHeight);
    view.focus();
  });
}

function handleFindCommand(event: CustomEvent<string>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "source" || paneDocumentMode.value !== "normal" || !view) return;
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

function handleJumpLine(event: CustomEvent<number>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "source" || paneDocumentMode.value !== "normal" || !view) return;
  const targetLine = Math.max(1, Math.min(Math.floor(event.detail) + 1, view.state.doc.lines));
  const line = view.state.doc.line(targetLine);
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  });
  view.focus();
}

function handleJumpHeading(event: CustomEvent<{ line?: number }>) {
  if (typeof event.detail?.line !== "number") return;
  handleJumpLine(new CustomEvent("lightmark:jump-line", { detail: event.detail.line }));
}

function updateWikiCompletion(currentView: EditorView) {
  if (!appStore.currentWorkspace) {
    closeWikiCompletion();
    return;
  }
  const selection = currentView.state.selection.main;
  if (!selection.empty) {
    closeWikiCompletion();
    return;
  }
  const line = currentView.state.doc.lineAt(selection.from);
  const before = line.text.slice(0, selection.from - line.from);
  const open = before.lastIndexOf("[[");
  if (open < 0 || before.slice(open + 2).includes("]]")) {
    closeWikiCompletion();
    return;
  }
  const query = before.slice(open + 2);
  if (/[\[\]\n]/.test(query)) {
    closeWikiCompletion();
    return;
  }
  const coords = currentView.coordsAtPos(selection.from);
  wikiCompletion.value = {
    visible: true,
    query,
    from: line.from + open + 2,
    to: selection.from,
    x: coords?.left ?? 24,
    y: (coords?.bottom ?? 24) + 6,
    highlightedIndex: Math.min(wikiCompletion.value.highlightedIndex, Math.max(wikiCompletionCandidates.value.length - 1, 0)),
  };
}

function moveWikiCompletion(delta: 1 | -1) {
  const count = wikiCompletionCandidates.value.length;
  if (count === 0) return;
  const next = wikiCompletion.value.highlightedIndex + delta;
  wikiCompletion.value.highlightedIndex = (next + count) % count;
}

function chooseWikiCompletion(currentView: EditorView, candidate = wikiCompletionCandidates.value[wikiCompletion.value.highlightedIndex]) {
  if (!candidate) return;
  const insert = `${candidate}]]`;
  currentView.dispatch({
    changes: { from: wikiCompletion.value.from, to: wikiCompletion.value.to, insert },
    selection: { anchor: wikiCompletion.value.from + insert.length },
  });
  closeWikiCompletion();
  currentView.focus();
}

function closeWikiCompletion() {
  if (!wikiCompletion.value.visible) return;
  wikiCompletion.value.visible = false;
}

function fileStem(path: string) {
  return (path.split(/[\\/]/).pop() || path).replace(/\.(md|markdown)$/i, "");
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
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "source" || paneDocumentMode.value !== "normal" || !view) return;
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
  <div ref="host" class="lm-editor-scroll h-full text-base" />
  <div
    v-if="wikiCompletion.visible && wikiCompletionCandidates.length > 0"
    class="fixed z-50 max-h-64 w-64 overflow-auto rounded-md border border-paper-200 bg-paper-50 p-1 shadow-[0_14px_36px_rgba(31,30,27,0.16)] dark:border-paper-800 dark:bg-paper-900"
    :style="{ left: `${wikiCompletion.x}px`, top: `${wikiCompletion.y}px` }"
  >
    <button
      v-for="(candidate, index) in wikiCompletionCandidates"
      :key="candidate"
      class="block w-full truncate rounded px-2 py-1.5 text-left text-sm"
      :class="index === wikiCompletion.highlightedIndex
        ? 'bg-paper-200 text-ink-900 dark:bg-paper-800 dark:text-ink-100'
        : 'text-ink-700 hover:bg-paper-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100'"
      @mousedown.prevent="view && chooseWikiCompletion(view, candidate)"
    >
      {{ candidate }}
    </button>
  </div>
</template>
