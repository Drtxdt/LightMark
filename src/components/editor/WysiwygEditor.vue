<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import TurndownService from "turndown";
import { AllSelection } from "@tiptap/pm/state";
import { appStore, setContent } from "../../stores/appStore";
import { renderMarkdownForEditor } from "../../utils/markdown";
import { MarkdownHeading } from "../../extensions/MarkdownHeading";
import { BlockMath, InlineMath } from "../../extensions/MathNodes";
import { MermaidNode } from "../../extensions/MermaidNode";

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

turndown.escape = (text) => text;

turndown.addRule("fencedCodeBlock", {
  filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
  replacement: (_content, node) => {
    const code = node.firstChild?.textContent || "";
    const className = node.firstChild instanceof HTMLElement ? node.firstChild.className : "";
    const language = className.match(/language-([^\s]+)/)?.[1] || "";
    return `\n\n\`\`\`${language}\n${code.replace(/\n$/, "")}\n\`\`\`\n\n`;
  },
});

turndown.addRule("inlineMath", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "inline-math",
  replacement: (content, node) => {
    const tex = node instanceof HTMLElement ? node.dataset.tex || node.textContent || content || "" : content;
    return `$${tex}$`;
  },
});

turndown.addRule("mermaid", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "mermaid",
  replacement: (content, node) => {
    const code = node instanceof HTMLElement ? node.dataset.code || node.textContent || content || "" : content;
    return `\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\n`;
  },
});

turndown.addRule("table", {
  filter: "table",
  replacement: (_content, node) => {
    if (!(node instanceof HTMLTableElement)) return "";
    const rows = Array.from(node.rows).map((row) =>
      Array.from(row.cells).map((cell) => normalizeTableCell(cell.textContent || "")),
    );
    if (rows.length === 0) return "";

    const columnCount = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, columnCount - row.length)).fill("")]);
    const header = normalized[0];
    const divider = Array(columnCount).fill("---");
    const body = normalized.slice(1);
    const lines = [header, divider, ...body].map((row) => `| ${row.join(" | ")} |`);
    return `\n\n${lines.join("\n")}\n\n`;
  },
});

turndown.addRule("blockMath", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "block-math",
  replacement: (content, node) => {
    const tex = node instanceof HTMLElement ? node.dataset.tex || node.textContent || content || "" : content;
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
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    MarkdownHeading,
    InlineMath,
    BlockMath,
    MermaidNode,
  ],
  content: renderMarkdownForEditor(appStore.currentContent),
  editorProps: {
    attributes: {
      class: "prose prose-stone dark:prose-invert mx-auto min-h-full max-w-[860px] px-8 pb-12 pt-6 focus:outline-none",
    },
    handleKeyDown(view, event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
        return true;
      }
      return false;
    },
    handlePaste(view, event) {
      const text = event.clipboardData?.getData("text/plain");
      if (!text || !looksLikeMarkdown(text)) return false;
      event.preventDefault();
      const { from, to } = view.state.selection;
      editor.value?.commands.insertContentAt({ from, to }, renderMarkdownForEditor(text));
      return true;
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

function looksLikeMarkdown(text: string) {
  return /(^|\n)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\||!\[[^\]]*\]\(|\[[^\]]+\]\(|\$\$)/.test(text) || /`[^`\n]+`|\*\*[^*]+\*\*|\$[^$\n]+\$/.test(text);
}

function normalizeTableCell(value: string) {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}
</script>

<template>
  <div class="h-full overflow-auto bg-paper-50 dark:bg-paper-950">
    <EditorContent :editor="editor" />
  </div>
</template>
