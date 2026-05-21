<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TurndownService from "turndown";
import { appStore, setContent } from "../../stores/appStore";
import { renderMarkdownForEditor } from "../../utils/markdown";
import { MarkdownHeading } from "../../extensions/MarkdownHeading";
import { BlockMath, InlineMath } from "../../extensions/MathNodes";

const TyporaHeading = Heading.extend({
  addInputRules() {
    return [];
  },
});

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.addRule("inlineMath", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "inline-math",
  replacement: (_content, node) => {
    const tex = node instanceof HTMLElement ? node.dataset.tex || "" : "";
    return `$${tex}$`;
  },
});

turndown.addRule("blockMath", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "block-math",
  replacement: (_content, node) => {
    const tex = node instanceof HTMLElement ? node.dataset.tex || "" : "";
    return `\n\n$$\n${tex}\n$$\n\n`;
  },
});

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: false,
    }),
    TyporaHeading.configure({
      levels: [1, 2, 3],
    }),
    Link.configure({ openOnClick: false }),
    Image,
    MarkdownHeading,
    InlineMath,
    BlockMath,
  ],
  content: renderMarkdownForEditor(appStore.currentContent),
  editorProps: {
    attributes: {
      class: "prose prose-stone dark:prose-invert mx-auto min-h-full max-w-[860px] px-8 py-12 focus:outline-none",
    },
  },
  onUpdate({ editor }) {
    setContent(turndown.turndown(editor.getHTML()), true);
  },
});

watch(
  () => appStore.currentFilePath,
  () => {
    editor.value?.commands.setContent(renderMarkdownForEditor(appStore.currentContent), { emitUpdate: false });
  },
);

watch(
  () => appStore.editorMode,
  () => {
    if (appStore.editorMode === "wysiwyg") {
      editor.value?.commands.setContent(renderMarkdownForEditor(appStore.currentContent), { emitUpdate: false });
    }
  },
);

onBeforeUnmount(() => editor.value?.destroy());
</script>

<template>
  <div class="h-full overflow-auto bg-paper-50 dark:bg-paper-950">
    <EditorContent :editor="editor" />
  </div>
</template>
