<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { appStore, setContent } from "../../stores/appStore";

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
let applyingExternalChange = false;

const minimalTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "#1f1e1b",
  },
  ".cm-content": {
    caretColor: "#1f1e1b",
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
  ".cm-line": {
    padding: "0 2px",
  },
  ".dark &": {
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
});

function extensions() {
  return [
    lineNumbers(),
    keymap.of([]),
    markdown(),
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
