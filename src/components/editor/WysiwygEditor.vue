<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import { Extension, Mark, mergeAttributes, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import Heading from "@tiptap/extension-heading";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import TurndownService from "turndown";
import { all, createLowlight } from "lowlight";
import { AllSelection, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { appStore, setContent } from "../../stores/appStore";
import { renderMarkdownForEditor } from "../../utils/markdown";
import { MarkdownHeading } from "../../extensions/MarkdownHeading";
import { BlockMath, InlineMath } from "../../extensions/MathNodes";
import { MermaidNode } from "../../extensions/MermaidNode";

const lowlight = createLowlight(all);

const TyporaHeading = Heading.extend({
  addInputRules() {
    return [];
  },
});

const HighlightMark = Mark.create({
  name: "highlight",
  parseHTML() {
    return [{ tag: "mark" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes), 0];
  },
});

const SuperscriptMark = Mark.create({
  name: "superscript",
  parseHTML() {
    return [{ tag: "sup" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes), 0];
  },
});

const SubscriptMark = Mark.create({
  name: "subscript",
  parseHTML() {
    return [{ tag: "sub" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sub", mergeAttributes(HTMLAttributes), 0];
  },
});

const TaskStateMark = Mark.create({
  name: "taskState",
  addAttributes() {
    return {
      state: {
        default: "unchecked",
        parseHTML: (element) => element.getAttribute("data-task-item") || "unchecked",
        renderHTML: (attributes) => ({ "data-task-item": attributes.state }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-task-item]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
});

const FrontMatterNode = Node.create({
  name: "frontMatter",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      yaml: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-yaml") || element.textContent || "",
        renderHTML: (attributes) => ({
          "data-type": "front-matter",
          "data-yaml": attributes.yaml,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-type="front-matter"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes), HTMLAttributes.yaml || ""];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("section");
      dom.className = "front-matter-node";
      dom.contentEditable = "false";
      const open = document.createElement("div");
      open.className = "front-matter-fence";
      open.textContent = "---";
      const pre = document.createElement("pre");
      pre.textContent = node.attrs.yaml || "";
      const close = document.createElement("div");
      close.className = "front-matter-fence";
      close.textContent = "---";
      dom.append(open, pre, close);
      return { dom, ignoreMutation: () => true };
    };
  },
});

const TableOfContentsNode = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'nav[data-type="table-of-contents"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["nav", mergeAttributes(HTMLAttributes, { "data-type": "table-of-contents" }), "[TOC]"];
  },

  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement("nav");
      dom.className = "toc-node";
      dom.contentEditable = "false";
      const render = () => {
        const headings: Array<{ level: number; text: string }> = [];
        editor.state.doc.descendants((node: any) => {
          if (node.type.name === "heading" || node.type.name === "markdownHeading") {
            headings.push({ level: node.attrs.level || 1, text: node.textContent });
          }
          return true;
        });
        dom.innerHTML = "";
        const label = document.createElement("div");
        label.className = "toc-node-label";
        label.textContent = "[TOC]";
        dom.appendChild(label);
        headings.forEach((heading) => {
          const item = document.createElement("div");
          item.className = `toc-node-item toc-node-item-${heading.level}`;
          item.textContent = heading.text;
          dom.appendChild(item);
        });
      };
      render();
      return { dom, update: () => (render(), true), ignoreMutation: () => true };
    };
  },
});

const HtmlBlockNode = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      html: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-html") || "",
        renderHTML: (attributes) => ({
          "data-type": "html-block",
          "data-html": attributes.html,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="html-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes), HTMLAttributes.html || ""];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("section");
      dom.className = "html-block-node";
      dom.contentEditable = "false";
      const label = document.createElement("div");
      label.className = "html-block-label";
      label.textContent = "HTML";
      const pre = document.createElement("pre");
      pre.textContent = node.attrs.html || "";
      dom.append(label, pre);
      return { dom, ignoreMutation: () => true };
    };
  },
});

const TyporaSourceMarkers = Extension.create({
  name: "typoraSourceMarkers",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            if (!state.selection.empty) return null;

            const decorations = [
              ...createMarkDecorations(state, "bold", "**", "**"),
              ...createMarkDecorations(state, "italic", "*", "*"),
              ...createMarkDecorations(state, "code", "`", "`"),
              ...createMarkDecorations(state, "highlight", "==", "=="),
              ...createMarkDecorations(state, "superscript", "^", "^"),
              ...createMarkDecorations(state, "subscript", "~", "~"),
              ...createLinkDecorations(state),
            ];

            return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          return convertMarkdownHeading(newState) || convertInlineMarkdownSyntax(newState);
        },
      }),
    ];
  },
});

const TyporaInlineCode = Extension.create({
  name: "typoraInlineCode",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (event.key !== "`" || event.ctrlKey || event.metaKey || event.altKey) return false;
            if (!convertInlineCodeBeforeCursor(view)) return false;
            event.preventDefault();
            return true;
          },
          handleTextInput: (view, from, to, text) => {
            if (text !== "`") return false;
            return convertInlineCodeBeforeCursor(view);
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;

          const codeMark = newState.schema.marks.code;
          if (!codeMark) return null;

          let tr = newState.tr;
          let converted = false;
          const inlineCodePattern = /(^|[^`])`([^`\n]+)`/g;

          newState.doc.descendants((node, pos) => {
            if (converted) return false;
            if (!node.isTextblock) return true;
            if (node.type.name === "codeBlock") return false;

            const text = node.textContent;
            inlineCodePattern.lastIndex = 0;
            const match = inlineCodePattern.exec(text);
            if (!match) return true;

            const full = match[0];
            const leadingLength = match[1].length;
            const code = match[2];
            const from = pos + 1 + match.index + leadingLength;
            const to = pos + 1 + match.index + full.length;
            tr = tr.insertText(code, from, to);
            tr = tr.addMark(from, from + code.length, codeMark.create());
            converted = true;
            return false;
          });

          return converted ? tr : null;
        },
      }),
    ];
  },
});

const TyporaHorizontalRule = Node.create({
  name: "horizontalRule",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: "hr" }, { tag: 'div[data-type="horizontal-rule"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["hr", mergeAttributes(HTMLAttributes)];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (event.key !== "Enter") return false;

            const { state } = view;
            const { $from, empty } = state.selection;
            if (!empty || !$from.parent.isTextblock) return false;
            if (!/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test($from.parent.textContent)) return false;

            event.preventDefault();
            const from = $from.before();
            const to = $from.after();
            const rule = state.schema.nodes.horizontalRule.create();
            let tr = state.tr.replaceWith(from, to, rule);
            const after = from + rule.nodeSize;
            if (state.schema.nodes.paragraph) {
              tr = tr.insert(after, state.schema.nodes.paragraph.create());
              tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createHorizontalRuleView(Boolean(node.attrs.editing), editor, getPos);
  },
});

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.escape = (text) => text;

turndown.addRule("horizontalRule", {
  filter: "hr",
  replacement: () => "\n\n---\n\n",
});

turndown.addRule("highlight", {
  filter: "mark",
  replacement: (content) => `==${content}==`,
});

turndown.addRule("superscript", {
  filter: "sup",
  replacement: (content) => `^${content}^`,
});

turndown.addRule("subscript", {
  filter: "sub",
  replacement: (content) => `~${content}~`,
});

turndown.addRule("taskState", {
  filter: (node) => node instanceof HTMLElement && node.hasAttribute("data-task-item"),
  replacement: (content, node) => {
    const checked = node instanceof HTMLElement && node.dataset.taskItem === "checked";
    return `${checked ? "[x]" : "[ ]"} ${content.replace(/^[☐☑]\s*/, "")}`;
  },
});

turndown.addRule("frontMatter", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "front-matter",
  replacement: (_content, node) => {
    const yaml = node instanceof HTMLElement ? node.dataset.yaml || node.textContent || "" : "";
    return `---\n${yaml.trim()}\n---\n\n`;
  },
});

turndown.addRule("tableOfContents", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "table-of-contents",
  replacement: () => "\n\n[TOC]\n\n",
});

turndown.addRule("htmlBlock", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "html-block",
  replacement: (_content, node) => {
    const html = node instanceof HTMLElement ? node.dataset.html || node.textContent || "" : "";
    return `\n\n${html.trim()}\n\n`;
  },
});

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
      codeBlock: false,
      horizontalRule: false,
    }),
    CodeBlockLowlight.configure({
      lowlight,
      defaultLanguage: "plaintext",
    }),
    TyporaHeading.configure({
      levels: [1, 2, 3, 4, 5, 6],
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
    HighlightMark,
    SuperscriptMark,
    SubscriptMark,
    TaskStateMark,
    FrontMatterNode,
    TableOfContentsNode,
    HtmlBlockNode,
    TyporaInlineCode,
    TyporaHorizontalRule,
    TyporaSourceMarkers,
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

function convertInlineCodeBeforeCursor(view: any) {
  const { state } = view;
  const { $from, empty } = state.selection;
  const codeMark = state.schema.marks.code;
  if (!empty || !codeMark || !$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return false;

  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
  const openerOffset = findInlineCodeOpener(before);
  if (openerOffset < 0) return false;

  const code = before.slice(openerOffset + 1);
  if (!code || /`/.test(code)) return false;

  const cursorPos = state.selection.from;
  const openerPos = cursorPos - (before.length - openerOffset);
  const tr = state.tr.insertText(code, openerPos, cursorPos);
  tr.addMark(openerPos, openerPos + code.length, codeMark.create());
  tr.removeStoredMark(codeMark);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function findInlineCodeOpener(text: string) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] !== "`") continue;
    if (index > 0 && text[index - 1] === "\\") continue;
    return index;
  }
  return -1;
}

function createMarkDecorations(state: any, markName: string, open: string, close: string) {
  const range = getActiveMarkRange(state, markName);
  if (!range) return [];
  return [
    Decoration.widget(range.from, () => createSourceMarker(open), { side: -1, key: `${markName}-open-${range.from}` }),
    Decoration.widget(range.to, () => createSourceMarker(close), { side: 1, key: `${markName}-close-${range.to}` }),
  ];
}

function createLinkDecorations(state: any) {
  const range = getActiveMarkRange(state, "link");
  if (!range) return [];
  const href = range.mark.attrs.href || "";
  return [
    Decoration.widget(range.from, () => createSourceMarker("["), { side: -1, key: `link-open-${range.from}` }),
    Decoration.widget(range.to, () => createSourceMarker(`](${href})`), { side: 1, key: `link-close-${range.to}` }),
  ];
}

function getActiveMarkRange(state: any, markName: string) {
  const markType = state.schema.marks[markName];
  if (!markType || !state.selection.empty) return null;

  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return null;

  const activeMark = (state.storedMarks || $from.marks()).find((mark: any) => mark.type === markType);
  if (!activeMark) return null;

  const parentStart = $from.start();
  const cursorOffset = $from.parentOffset;
  const children: Array<{ node: any; offset: number }> = [];
  $from.parent.forEach((node: any, offset: number) => children.push({ node, offset }));

  const hasActiveMark = (node: any) => Boolean(activeMark.isInSet(node.marks));
  let activeIndex = children.findIndex(({ node, offset }) => {
    return hasActiveMark(node) && cursorOffset >= offset && cursorOffset <= offset + node.nodeSize;
  });

  if (activeIndex < 0) {
    activeIndex = children.findIndex(({ node, offset }) => {
      return hasActiveMark(node) && (cursorOffset === offset || cursorOffset === offset + node.nodeSize);
    });
  }

  if (activeIndex < 0) return null;

  let startIndex = activeIndex;
  let endIndex = activeIndex;
  while (startIndex > 0 && hasActiveMark(children[startIndex - 1].node)) startIndex -= 1;
  while (endIndex < children.length - 1 && hasActiveMark(children[endIndex + 1].node)) endIndex += 1;

  const from = parentStart + children[startIndex].offset;
  const endChild = children[endIndex];
  const to = parentStart + endChild.offset + endChild.node.nodeSize;
  return { from, to, mark: activeMark };
}

function createSourceMarker(text: string) {
  const marker = document.createElement("span");
  marker.className = "md-live-marker";
  marker.textContent = text;
  marker.contentEditable = "false";
  return marker;
}

function convertInlineMarkdownSyntax(state: any) {
  const linkMark = state.schema.marks.link;
  const converters = [
    {
      mark: state.schema.marks.highlight,
      pattern: /(^|[\s(])==([^=\n]+)==/g,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.superscript,
      pattern: /(^|[\s(])\^([^^\n]+)\^/g,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.subscript,
      pattern: /(^|[\s(])~([^~\n]+)~/g,
      attrs: () => ({}),
    },
    {
      mark: linkMark,
      pattern: /(^|[\s(])\[([^\]\n]+)\]\(([^)\s]+)\)/g,
      attrs: (match: RegExpExecArray) => ({ href: match[3] }),
    },
  ];

  let tr = state.tr;
  let converted = false;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;

    const text = node.textContent;
    for (const converter of converters) {
      if (!converter.mark) continue;
      converter.pattern.lastIndex = 0;
      const match = converter.pattern.exec(text);
      if (!match) continue;

      const full = match[0];
      const leadingLength = match[1].length;
      const label = match[2];
      const from = pos + 1 + match.index + leadingLength;
      const to = pos + 1 + match.index + full.length;

      tr = tr.insertText(label, from, to);
      tr = tr.addMark(from, from + label.length, converter.mark.create(converter.attrs(match)));
      converted = true;
      return false;
    }
    return true;
  });

  return converted ? tr : null;
}

function convertMarkdownHeading(state: any) {
  const heading = state.schema.nodes.heading;
  if (!heading) return null;

  let tr = state.tr;
  let converted = false;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;

    const match = node.textContent.match(/^(#{1,6})\s+(.+)$/);
    if (!match) return true;

    const level = match[1].length;
    const textStart = pos + 1 + match[1].length + 1;
    const textEnd = pos + node.nodeSize - 1;
    tr = tr.delete(pos + 1, textStart);
    tr = tr.setNodeMarkup(pos, heading, { level }, node.marks);
    if (textEnd >= textStart) {
      const mapped = tr.mapping.map(textEnd);
      tr = tr.setSelection(TextSelection.create(tr.doc, Math.min(mapped, tr.doc.content.size)));
    }
    converted = true;
    return false;
  });

  return converted ? tr : null;
}

function createHorizontalRuleView(editing: boolean, editor: any, getPos: (() => number | undefined) | boolean) {
  const dom = document.createElement("div");
  dom.className = "typora-hr-node";
  dom.contentEditable = "false";

  const updateAttrs = (nextEditing: boolean) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { editing: nextEditing }));
  };

  const render = () => {
    dom.innerHTML = "";
    dom.className = editing ? "typora-hr-node typora-hr-node-editing" : "typora-hr-node";
    if (editing) {
      const marker = document.createElement("span");
      marker.className = "typora-hr-source";
      marker.textContent = "---";
      const line = document.createElement("span");
      line.className = "typora-hr-line";
      dom.append(marker, line);
    } else {
      dom.appendChild(document.createElement("hr"));
    }
  };

  dom.addEventListener("mousedown", (event) => {
    if (editing) return;
    event.preventDefault();
    editing = true;
    selectHorizontalRule(editor, getPos, true);
    render();
  });

  render();

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "horizontalRule") return false;
      editing = Boolean(nextNode.attrs.editing);
      render();
      return true;
    },
    selectNode() {
      editing = true;
      updateAttrs(true);
      render();
    },
    deselectNode() {
      if (!editing) return;
      editing = false;
      updateAttrs(false);
      render();
    },
    ignoreMutation: () => true,
  };
}

function selectHorizontalRule(editor: any, getPos: (() => number | undefined) | boolean, editing: boolean) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;
  const { state } = editor.view;
  const tr = state.tr
    .setSelection(NodeSelection.create(state.doc, pos))
    .setNodeMarkup(pos, undefined, { editing });
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}
</script>

<template>
  <div class="h-full overflow-auto bg-paper-50 dark:bg-paper-950">
    <EditorContent :editor="editor" />
  </div>
</template>
