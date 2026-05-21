<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TurndownService from "turndown";
import { appStore, setContent } from "../../stores/appStore";
import { renderMarkdown } from "../../utils/markdown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

const editor = useEditor({
  extensions: [
    StarterKit,
    Link.configure({ openOnClick: false }),
    Image,
  ],
  content: renderMarkdown(appStore.currentContent),
  editorProps: {
    attributes: {
      class: "prose prose-slate dark:prose-invert mx-auto min-h-full max-w-[860px] px-8 py-10 focus:outline-none",
    },
  },
  onUpdate({ editor }) {
    setContent(turndown.turndown(editor.getHTML()), true);
  },
});

watch(
  () => appStore.currentFilePath,
  () => {
    editor.value?.commands.setContent(renderMarkdown(appStore.currentContent), { emitUpdate: false });
  },
);

watch(
  () => appStore.editorMode,
  () => {
    if (appStore.editorMode === "wysiwyg") {
      editor.value?.commands.setContent(renderMarkdown(appStore.currentContent), { emitUpdate: false });
    }
  },
);

onBeforeUnmount(() => editor.value?.destroy());
</script>

<template>
  <div class="h-full overflow-auto bg-white dark:bg-zinc-950">
    <EditorContent :editor="editor" />
  </div>
</template>
