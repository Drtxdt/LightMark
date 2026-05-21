<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { appStore, setContent } from "../../stores/appStore";

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
let applyingExternalChange = false;

function extensions() {
  return [
    lineNumbers(),
    keymap.of([]),
    markdown(),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingExternalChange) {
        setContent(update.state.doc.toString(), true);
      }
    }),
    ...(document.documentElement.classList.contains("dark") ? [oneDark] : []),
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
  <div ref="host" class="h-full bg-white text-base dark:bg-zinc-950" />
</template>
