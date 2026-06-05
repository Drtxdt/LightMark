<script setup lang="ts">
import { computed, ref, onBeforeUnmount, watch } from "vue";
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
import { openUrl } from "@tauri-apps/plugin-opener";
import TurndownService from "turndown";
import { all, createLowlight } from "lowlight";
import { AllSelection, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { DOMSerializer } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { appStore, setContent } from "../../stores/appStore";
import { renderMarkdownForEditor } from "../../utils/markdown";
import { MarkdownHeading } from "../../extensions/MarkdownHeading";
import { BlockMath, InlineMath } from "../../extensions/MathNodes";
import { MermaidNode } from "../../extensions/MermaidNode";

const lowlight = createLowlight(all);

type ContextMenuMode = "default" | "code";

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  mode: "default" as ContextMenuMode,
  inTable: false,
});
const savedSelection = ref<{ from: number; to: number } | null>(null);
const linkUrl = ref("");
const canUseTableMenu = computed(() => contextMenu.value.inTable && contextMenu.value.mode !== "code");

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
    return [{ tag: "sup:not([data-footnote-ref])" }];
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
    const checked = HTMLAttributes["data-task-item"] === "checked";
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "task-state" }),
      ["input", { type: "checkbox", checked: checked ? "checked" : null, contenteditable: "false", "data-task-checkbox": "true" }],
      ["span", { class: "task-state-content" }, 0],
    ];
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
      editing: {
        default: false,
        rendered: false,
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
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("section");
      dom.contentEditable = "false";
      let yaml = node.attrs.yaml || "";
      let editing = Boolean(node.attrs.editing);

      const updateYaml = () => {
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { yaml, editing: false }));
      };

      const renderDisplay = () => {
        dom.innerHTML = "";
        dom.className = "front-matter-node";
        const pre = document.createElement("pre");
        pre.className = yaml.trim() ? "" : "front-matter-placeholder";
        pre.textContent = yaml.trim() ? yaml : "请输入yaml";
        dom.append(pre);
      };

      const renderEditor = () => {
        dom.innerHTML = "";
        dom.className = "front-matter-node front-matter-node-editing";
        const textarea = document.createElement("textarea");
        textarea.className = "front-matter-editor";
        textarea.placeholder = "请输入yaml";
        textarea.value = yaml;
        textarea.rows = Math.max(3, yaml.split(/\r?\n/).length);
        textarea.spellcheck = false;
        textarea.addEventListener("input", () => {
          yaml = textarea.value;
          textarea.rows = Math.max(3, yaml.split(/\r?\n/).length);
        });
        textarea.addEventListener("blur", () => {
          editing = false;
          updateYaml();
          renderDisplay();
        });
        dom.append(textarea);
        requestAnimationFrame(() => textarea.focus());
      };

      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        renderEditor();
      });

      editing ? renderEditor() : renderDisplay();
      return {
        dom,
        update(nextNode: any) {
          yaml = nextNode.attrs.yaml || "";
          editing = Boolean(nextNode.attrs.editing);
          editing ? renderEditor() : renderDisplay();
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
      };
    };
  },
});

const FrontMatterInput = Extension.create({
  name: "frontMatterInput",
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            return convertLeadingFrontMatter(view, event);
          },
        },
      }),
    ];
  },
});

const FencedCodeBlockInput = Extension.create({
  name: "fencedCodeBlockInput",
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            return convertFencedCodeBlock(view, event);
          },
        },
      }),
    ];
  },
});

function isLeadingFrontMatterFence(state: any) {
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  const firstNode = state.doc.firstChild;
  if (!firstNode || $from.depth !== 1 || $from.before(1) !== 0) return false;
  if ($from.parent !== firstNode || !firstNode.isTextblock) return false;
  if ($from.parentOffset !== firstNode.content.size) return false;
  return firstNode.textContent.trim() === "---";
}

function getFencedCodeLanguage(text: string) {
  const match = text.match(/^```([A-Za-z0-9_+-]*)\s*$/);
  return match ? match[1] : null;
}

function convertFencedCodeBlock(view: any, event: KeyboardEvent) {
  if (event.key !== "Enter") return false;
  const { state } = view;
  const { selection, schema } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;

  const language = getFencedCodeLanguage($from.parent.textContent.trim());
  if (language === null) return false;

  const codeBlockType = schema.nodes.codeBlock;
  if (!codeBlockType) return false;

  const from = $from.before();
  const to = $from.after();
  const codeBlock = codeBlockType.create(language ? { language } : undefined);
  const tr = state.tr.replaceWith(from, to, codeBlock);
  tr.setSelection(TextSelection.create(tr.doc, from + 1));
  view.dispatch(tr.scrollIntoView());
  event.preventDefault();
  return true;
}

function convertLeadingFrontMatter(view: any, event: KeyboardEvent) {
  if (event.key !== "Enter") return false;
  const { state } = view;
  if (!isLeadingFrontMatterFence(state)) return false;

  const { schema } = state;
  const firstNode = state.doc.firstChild;
  const frontMatterType = schema.nodes.frontMatter;
  const paragraphType = schema.nodes.paragraph;
  if (!firstNode || !frontMatterType || !paragraphType) return false;

  const frontMatter = frontMatterType.create({ yaml: "", editing: true });
  const paragraph = paragraphType.create();
  const tr = state.tr.replaceWith(0, firstNode.nodeSize, [frontMatter, paragraph]);
  tr.setSelection(NodeSelection.create(tr.doc, 0));
  view.dispatch(tr.scrollIntoView());
  event.preventDefault();
  return true;
}

const TableOfContentsNode = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'nav[data-type="table-of-contents"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["nav", mergeAttributes(HTMLAttributes, { "data-type": "table-of-contents" }), "[TOC]"];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("nav");
      dom.className = "toc-node";
      dom.contentEditable = "false";
      let editing = Boolean(node.attrs.editing);

      const updateAttrs = (nextEditing: boolean) => {
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { editing: nextEditing }));
      };

      const render = () => {
        dom.className = editing ? "toc-node toc-node-editing" : "toc-node";
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
        if (editing) {
          const input = document.createElement("input");
          input.className = "toc-node-editor";
          input.value = "[TOC]";
          input.spellcheck = false;
          input.addEventListener("blur", () => {
            window.setTimeout(() => {
              if (document.activeElement === input) return;
              if (input.value.trim().toUpperCase() !== "[TOC]") {
                replaceTocWithText(editor, getPos, input.value);
                return;
              }
              editing = false;
              updateAttrs(false);
              render();
            }, 100);
          });
          dom.appendChild(input);
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
          return;
        }
        headings.forEach((heading) => {
          const item = document.createElement("div");
          item.className = `toc-node-item toc-node-item-${heading.level}`;
          item.textContent = heading.text;
          dom.appendChild(item);
        });
      };
      const refresh = () => {
        if (!editing) render();
      };
      editor.on?.("update", refresh);
      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        updateAttrs(true);
        render();
      });
      render();
      return {
        dom,
        update: (nextNode: any) => {
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
        destroy() {
          editor.off?.("update", refresh);
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLInputElement,
      };
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
      editing: {
        default: false,
        rendered: false,
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
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("section");
      dom.contentEditable = "false";
      let html = node.attrs.html || "";
      let editing = Boolean(node.attrs.editing);

      const updateAttrs = (next: { html?: string; editing?: boolean }) => {
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { html, editing, ...next }));
      };

      const renderDisplay = () => {
        dom.innerHTML = "";
        dom.className = "html-block-node";
        const rendered = document.createElement("div");
        rendered.className = "html-block-rendered";
        rendered.innerHTML = html;
        dom.appendChild(rendered);
      };

      const renderEditor = () => {
        dom.innerHTML = "";
        dom.className = "html-block-node html-block-node-editing";
        const label = document.createElement("div");
        label.className = "html-block-label";
        label.textContent = "HTML";
        const textarea = document.createElement("textarea");
        textarea.className = "html-block-editor";
        textarea.value = html;
        textarea.rows = Math.max(3, html.split(/\r?\n/).length);
        textarea.spellcheck = false;
        textarea.addEventListener("input", () => {
          html = textarea.value;
          textarea.rows = Math.max(3, html.split(/\r?\n/).length);
        });
        textarea.addEventListener("blur", () => {
          editing = false;
          updateAttrs({ html, editing: false });
          renderDisplay();
        });
        dom.append(label, textarea);
        requestAnimationFrame(() => textarea.focus());
      };

      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        updateAttrs({ editing: true });
        renderEditor();
      });

      editing ? renderEditor() : renderDisplay();
      return {
        dom,
        update(nextNode: any) {
          html = nextNode.attrs.html || "";
          editing = Boolean(nextNode.attrs.editing);
          editing ? renderEditor() : renderDisplay();
          return true;
        },
        selectNode() {
          editing = true;
          updateAttrs({ editing: true });
          renderEditor();
        },
        deselectNode() {
          if (!editing) return;
          editing = false;
          updateAttrs({ html, editing: false });
          renderDisplay();
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
      };
    };
  },
});

const StrikeMark = Mark.create({
  name: "strike",
  parseHTML() {
    return [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["s", mergeAttributes(HTMLAttributes), 0];
  },
});

const FootnoteRefNode = Node.create({
  name: "footnoteRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  priority: 10000,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-footnote-ref") || "",
        renderHTML: () => ({}),
      },
      index: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-footnote-index") || element.textContent?.replace(/\D/g, "") || "",
        renderHTML: () => ({}),
      },
      refId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-ref-id") || element.querySelector("a")?.getAttribute("id") || "",
        renderHTML: () => ({}),
      },
      preview: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-preview") || "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="footnote-ref"]' }, { tag: "sup[data-footnote-ref]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id || HTMLAttributes.id || "";
    const index = node.attrs.index || HTMLAttributes.index || "";
    const refId = node.attrs.refId || HTMLAttributes.refId || `fnref-${id}-1`;
    const preview = node.attrs.preview || HTMLAttributes.preview || "";
    return [
      "span",
      {
        "data-type": "footnote-ref",
        "data-footnote-ref": id,
        "data-footnote-index": index,
        "data-ref-id": refId,
        "data-preview": preview,
      },
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("sup");
      const id = node.attrs.id || "";
      const index = node.attrs.index || id;
      const refId = node.attrs.refId || `fnref-${id}-1`;
      let editing = false;
      dom.dataset.footnoteRef = id;
      dom.dataset.footnoteIndex = String(index);
      dom.dataset.preview = node.attrs.preview || "";
      dom.contentEditable = "false";
      dom.className = "footnote-ref-node";

      const link = document.createElement("a");
      link.href = `#fn-${id}`;
      link.id = refId;
      link.dataset.footnoteLink = "ref";
      link.title = formatFootnotePreview(node.attrs.preview || id);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) {
          scrollInternalLink(`#fn-${id}`);
          return;
        }
        editing = !editing;
        render();
      });
      dom.addEventListener("dblclick", (event) => {
        event.preventDefault();
        scrollInternalLink(`#fn-${id}`);
      });

      const preview = document.createElement("span");
      preview.className = "footnote-ref-preview";
      preview.innerHTML = renderMarkdownForEditor(node.attrs.preview || "");

      const render = () => {
        link.textContent = editing ? `[^${id}]` : `[${index}]`;
        dom.classList.toggle("footnote-ref-node-editing", editing);
      };
      dom.appendChild(link);
      if (node.attrs.preview) dom.appendChild(preview);
      render();
      return { dom, ignoreMutation: () => true };
    };
  },
});

const FootnotesNode = Node.create({
  name: "footnotes",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      markdown: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-markdown") || "",
        renderHTML: (attributes) => ({
          "data-type": "footnotes",
          "data-markdown": attributes.markdown,
        }),
      },
      html: {
        default: "",
        parseHTML: (element) => element.innerHTML || "",
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-type="footnotes"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes), ""];
  },

  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("section");
      dom.className = "footnotes";
      dom.dataset.type = "footnotes";
      dom.dataset.markdown = node.attrs.markdown || "";
      dom.contentEditable = "false";
      let markdown = node.attrs.markdown || "";
      let fallbackHtml = node.attrs.html || "";
      let frame = 0;
      const render = () => renderFootnotesView(dom, markdown, fallbackHtml);
      const scheduleRender = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          render();
        });
      };
      const refreshAfterMount = () => {
        render();
        scheduleRender();
        window.setTimeout(scheduleRender, 80);
      };
      refreshAfterMount();
      dom.addEventListener("click", (event) => {
        const target = getEventElement(event);
        const link = target?.closest<HTMLAnchorElement>("a[href^='#'],button[data-footnote-target]");
        if (!link) return;
        event.preventDefault();
        const href = link instanceof HTMLButtonElement ? link.dataset.footnoteTarget || "" : link.getAttribute("href") || "";
        scrollInternalLink(href);
      });
      editor.on?.("update", scheduleRender);
      return {
        dom,
        update(nextNode: any) {
          markdown = nextNode.attrs.markdown || "";
          fallbackHtml = nextNode.attrs.html || "";
          dom.dataset.markdown = markdown;
          scheduleRender();
          return true;
        },
        destroy() {
          if (frame) cancelAnimationFrame(frame);
          editor.off?.("update", scheduleRender);
        },
        ignoreMutation: () => true,
      };
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
            const decorations = [
              ...createOutlineHeadingDecorations(state),
            ];

            if (state.selection.empty) {
              decorations.push(
                ...createMarkDecorations(state, "bold", "**", "**"),
                ...createMarkDecorations(state, "italic", "*", "*"),
                ...createMarkDecorations(state, "code", "`", "`"),
                ...createMarkDecorations(state, "strike", "~~", "~~"),
                ...createMarkDecorations(state, "highlight", "==", "=="),
                ...createMarkDecorations(state, "superscript", "^", "^"),
                ...createMarkDecorations(state, "subscript", "~", "~"),
                ...createLinkDecorations(state),
                ...createHeadingDecorations(state),
              );
            }

            return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          return convertInlineMarkdownSyntax(newState);
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
          return convertInlineCodeSyntax(newState);
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
            if (isLeadingFrontMatterFence(state)) return false;
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

turndown.addRule("strike", {
  filter: ["s", "del"],
  replacement: (content) => `~~${content}~~`,
});

turndown.addRule("superscript", {
  filter: (node) => node.nodeName === "SUP" && !(node instanceof HTMLElement && node.hasAttribute("data-footnote-ref")),
  replacement: (content) => `^${content}^`,
});

turndown.addRule("footnoteRef", {
  filter: (node) =>
    node instanceof HTMLElement &&
    ((node.dataset.type === "footnote-ref" && node.hasAttribute("data-footnote-ref")) || node.hasAttribute("data-footnote-ref")),
  replacement: (_content, node) => {
    const id = node instanceof HTMLElement ? node.dataset.footnoteRef || "" : "";
    return id ? `[^${id}]` : "";
  },
});

turndown.addRule("footnotes", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "footnotes",
  replacement: (_content, node) => {
    const markdown = node instanceof HTMLElement ? node.dataset.markdown || "" : "";
    const source = normalizeFootnoteSource(markdown);
    return source ? `\n\n${source}\n\n` : "";
  },
});

turndown.addRule("subscript", {
  filter: "sub",
  replacement: (content) => `~${content}~`,
});

turndown.addRule("taskState", {
  filter: (node) => node instanceof HTMLElement && node.hasAttribute("data-task-item"),
  replacement: (content, node) => {
    const checked = node instanceof HTMLElement && node.dataset.taskItem === "checked";
    const text = content.replace(/^[☐☑]\s*/, "").trim();
    return `${checked ? "[x]" : "[ ]"}${text ? ` ${text}` : ""}`;
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
  enableInputRules: ["blockquote", "bulletList", "orderedList"],
  extensions: [
    StarterKit.configure({
      heading: false,
      codeBlock: false,
      horizontalRule: false,
      strike: false,
      link: false,
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
    FootnoteRefNode,
    HighlightMark,
    StrikeMark,
    SuperscriptMark,
    SubscriptMark,
    TaskStateMark,
    FrontMatterNode,
    TableOfContentsNode,
    HtmlBlockNode,
    FootnotesNode,
    TyporaInlineCode,
    TyporaHorizontalRule,
    FrontMatterInput,
    FencedCodeBlockInput,
    TyporaSourceMarkers,
  ],
  content: renderMarkdownForEditor(appStore.currentContent),
  editorProps: {
    attributes: {
      class: "prose prose-stone dark:prose-invert mx-auto min-h-full max-w-[860px] px-8 pb-12 pt-6 focus:outline-none",
    },
    handleKeyDown(view, event) {
      if (convertLeadingFrontMatter(view, event)) return true;
      if (convertFencedCodeBlock(view, event)) return true;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
        return true;
      }
      if (event.key === "ArrowRight" && moveOutOfMarkAtRightBoundary(view, ["bold", "strike"])) {
        event.preventDefault();
        return true;
      }
      if (event.key === "Enter") {
        if (continueTaskItem(view)) {
          event.preventDefault();
          return true;
        }

        const headingTr = convertMarkdownHeading(view.state, {
          force: true,
          onlySelectionBlock: true,
          insertParagraph: true,
        });
        if (headingTr) {
          event.preventDefault();
          view.dispatch(headingTr.scrollIntoView());
          return true;
        }
        window.setTimeout(() => clearStoredMarks(view, ["strike"]), 0);
      }
      return false;
    },
    handleDOMEvents: {
      contextmenu(view, event) {
        const mouseEvent = event as MouseEvent;
        const target = getEventElement(mouseEvent);
        if (!target || !view.dom.contains(target)) return false;

        mouseEvent.preventDefault();
        const position = view.posAtCoords({ left: mouseEvent.clientX, top: mouseEvent.clientY });
        if (position && !isPositionInsideSelection(view.state.selection, position.pos)) {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position.pos))));
        }
          savedSelection.value = {
            from: view.state.selection.from,
            to: view.state.selection.to,
          };
        const mode: ContextMenuMode =
          target.closest("pre, code") || view.state.selection.$from.parent.type.name === "codeBlock" ? "code" : "default";

        contextMenu.value = {
          visible: true,
          x: Math.min(mouseEvent.clientX, window.innerWidth - 260),
          y: Math.min(mouseEvent.clientY, window.innerHeight - 360),
          mode,
          inTable: Boolean(target.closest("table")),
        };
        return true;
      },
      click(view, event) {
        hideContextMenu();
        const mouseEvent = event as MouseEvent;
        const target = getEventElement(mouseEvent);
        const link = target?.closest<HTMLAnchorElement>("a[href]");
        if (link) {
          mouseEvent.preventDefault();
          const href = link.getAttribute("href") || "";
          if (href.startsWith("#")) {
            scrollInternalLink(href);
            return true;
          }
          if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
            mouseEvent.stopPropagation();
            void openExternalLink(link.href);
            return true;
          }
          return false;
        }
        return false;
      },
      blur(view) {
        window.setTimeout(() => {
          if (view.hasFocus()) return;
          if (convertPendingInlineMarkdown(view)) return;

          const headingTr = convertMarkdownHeading(view.state, { force: true });
          if (headingTr) view.dispatch(headingTr);
        }, 0);
        return false;
      },
    },
    handleClick(view, _pos, event) {
      const target = getEventElement(event);
      const heading = target?.closest<HTMLElement>("h1,h2,h3,h4,h5,h6");
      if (heading && view.dom.contains(heading)) {
        event.preventDefault();
        editHeadingAsMarkdown(view, heading);
        return true;
      }

      const checkbox = target?.closest<HTMLInputElement>("input[data-task-checkbox]");
      const task = checkbox?.closest<HTMLElement>("[data-task-item]");
      if (checkbox && task) {
        event.preventDefault();
        toggleTaskItem(view, task);
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
    setContent(editorHtmlToMarkdown(editor.getHTML()), true);
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

function hideContextMenu() {
  contextMenu.value.visible = false;
}

function isPositionInsideSelection(selection: any, pos: number) {
  return !selection.empty && pos >= selection.from && pos <= selection.to;
}

function restoreEditorSelection() {
  const activeEditor = editor.value;
  if (!activeEditor || !savedSelection.value) {
    activeEditor?.view.focus();
    return;
  }

  const { state, view } = activeEditor;
  const docSize = state.doc.content.size;
  const from = Math.max(0, Math.min(savedSelection.value.from, docSize));
  const to = Math.max(from, Math.min(savedSelection.value.to, docSize));

  try {
    const selection = TextSelection.between(
      state.doc.resolve(from),
      state.doc.resolve(to),
      -1,
    );
    view.dispatch(state.tr.setSelection(selection));
  } catch {
    view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(from))));
  }

  activeEditor.view.focus();
}

function runMenuCommand(command: () => void | Promise<void>, keepOpen = false) {
  restoreEditorSelection();
  void Promise.resolve(command()).finally(() => {
    if (!keepOpen) hideContextMenu();
  });
}

async function writeClipboard(text: string, html?: string) {
  if (html && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Plain text fallback below.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

async function readClipboardText() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

function getSelectedHtml() {
  const activeEditor = editor.value;
  if (!activeEditor) return "";
  const { state } = activeEditor.view;
  const fragment = state.selection.content().content;
  if (!fragment.size) return "";
  const div = document.createElement("div");
  const serializer = DOMSerializer.fromSchema(state.schema);
  div.appendChild(serializer.serializeFragment(fragment));
  return div.innerHTML;
}

function getSelectedMarkdown() {
  const html = getSelectedHtml();
  if (!html) return "";
  return editorHtmlToMarkdown(html).trim();
}

function getSelectedPlainText() {
  const activeEditor = editor.value;
  if (!activeEditor) return "";
  const { from, to } = activeEditor.state.selection;
  return activeEditor.state.doc.textBetween(from, to, "\n", "\n");
}

async function cutSelection() {
  await copySelectionAsMarkdown();
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  if (state.selection.empty) return;
  activeEditor.view.dispatch(state.tr.deleteSelection().scrollIntoView());
}

async function copySelectionAsMarkdown() {
  const markdown = getSelectedMarkdown() || getSelectedPlainText();
  await writeClipboard(markdown);
}

async function copySelectionClean() {
  await copySelectionAsMarkdown();
}

async function copySelectionAsHtml() {
  const html = getSelectedHtml();
  const markdown = getSelectedMarkdown() || getSelectedPlainText();
  await writeClipboard(markdown, html);
}

async function pasteFromClipboard(clean: boolean) {
  const text = await readClipboardText();
  if (!text) return;
  if (clean) {
    (editor.value as any)?.commands.insertContent(renderMarkdownForEditor(text));
    return;
  }
  (editor.value as any)?.commands.insertContent(text);
}

function insertMarkdownText(text: string, selectFromOffset?: number, selectToOffset?: number) {
  const activeEditor = editor.value;
  if (!activeEditor) return;

  const view = activeEditor.view;
  const { state } = view;
  const from = state.selection.from;
  const to = state.selection.to;
  let tr = state.tr.insertText(text, from, to);

  if (typeof selectFromOffset === "number" && typeof selectToOffset === "number") {
    const selectFrom = from + selectFromOffset;
    const selectTo = from + selectToOffset;
    tr = tr.setSelection(TextSelection.create(tr.doc, selectFrom, selectTo));
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function runFormatCommand(commandName: string) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const chain = activeEditor.chain().focus();
  switch (commandName) {
    case "bold":
      chain.toggleBold().run();
      break;
    case "italic":
      chain.toggleItalic().run();
      break;
    case "code":
      chain.toggleCode().run();
      break;
    case "blockquote":
      chain.toggleBlockquote().run();
      break;
    case "orderedList":
      chain.toggleOrderedList().run();
      break;
    case "bulletList":
      chain.toggleBulletList().run();
      break;
    default:
      break;
  }
}

function toggleLink() {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const selectedText = getSelectedPlainText().trim();
  const label = selectedText || "链接文本";
  const snippet = `[${label}](https://example.com)`;
  const labelStart = 1;
  const labelEnd = labelStart + label.length;
  insertMarkdownText(snippet, selectedText ? snippet.length - "https://example.com)".length : labelStart, selectedText ? snippet.length - 1 : labelEnd);
}

function insertTaskItem() {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  activeEditor.commands.insertContent(renderMarkdownForEditor("- [ ] "));
}

function setHeadingLevel(level: number | null) {
  const chain = (editor.value as any)?.chain().focus();
  if (!chain) return;
  if (level === null) {
    chain.setParagraph().run();
    return;
  }
  chain.toggleHeading({ level }).run();
}

function insertImageByUrl() {
  insertMarkdownText("![图片描述](image-url)", 2, 6);
}

function insertParagraphAround(position: "before" | "after") {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return;
  const { $from } = state.selection;
  const insertAt = position === "before" ? $from.before() : $from.after();
  const tr = state.tr.insert(insertAt, paragraph.create());
  activeEditor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, insertAt + 1)).scrollIntoView());
  activeEditor.view.focus();
}

function runTableCommand(commandName: string) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const chain = activeEditor.chain().focus();
  switch (commandName) {
    case "addRowBefore":
      chain.addRowBefore().run();
      break;
    case "addRowAfter":
      chain.addRowAfter().run();
      break;
    case "addColumnBefore":
      chain.addColumnBefore().run();
      break;
    case "addColumnAfter":
      chain.addColumnAfter().run();
      break;
    case "deleteRow":
      chain.deleteRow().run();
      break;
    case "deleteColumn":
      chain.deleteColumn().run();
      break;
    case "deleteTable":
      chain.deleteTable().run();
      break;
    default:
      break;
  }
}

function copyCurrentTable() {
  const table = getCurrentTableElement();
  if (!table) return;
  void writeClipboard(turndown.turndown(table.outerHTML).trim(), table.outerHTML);
}

function copyFormattedTableSource() {
  const table = getCurrentTableElement();
  if (!table) return;
  void writeClipboard(formatMarkdownTable(table));
}

function getCurrentTableElement() {
  const activeEditor = editor.value;
  if (!activeEditor) return null;
  const dom = activeEditor.view.domAtPos(activeEditor.state.selection.from).node;
  const element = dom instanceof HTMLElement ? dom : dom.parentElement;
  return element?.closest("table");
}

function formatMarkdownTable(table: HTMLTableElement) {
  const rows = Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => normalizeTableCell(cell.textContent || "")),
  );
  if (!rows.length) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, columnCount - row.length)).fill("")]);
  const widths = Array.from({ length: columnCount }, (_item, index) =>
    Math.max(3, ...normalized.map((row) => row[index].length)),
  );
  const renderRow = (row: string[]) => `| ${row.map((cell, index) => cell.padEnd(widths[index], " ")).join(" | ")} |`;
  return [renderRow(normalized[0]), renderRow(widths.map((width) => "-".repeat(width))), ...normalized.slice(1).map(renderRow)].join("\n");
}

function moveCurrentTableRow(direction: -1 | 1) {
  const table = getCurrentTableElement();
  const activeCell = getCurrentTableCell();
  if (!table || !activeCell) return;
  const rowIndex = activeCell.parentElement ? Array.from(table.rows).indexOf(activeCell.parentElement as HTMLTableRowElement) : -1;
  const targetIndex = rowIndex + direction;
  if (rowIndex < 0 || targetIndex < 0 || targetIndex >= table.rows.length) return;
  swapTableRowContent(table.rows[rowIndex], table.rows[targetIndex]);
  replaceCurrentTableFromDom(table);
}

function moveCurrentTableColumn(direction: -1 | 1) {
  const table = getCurrentTableElement();
  const activeCell = getCurrentTableCell();
  if (!table || !activeCell) return;
  const columnIndex = activeCell.cellIndex;
  const targetIndex = columnIndex + direction;
  if (targetIndex < 0) return;
  Array.from(table.rows).forEach((row) => {
    if (targetIndex >= row.cells.length) return;
    const left = row.cells[columnIndex];
    const right = row.cells[targetIndex];
    if (!left || !right) return;
    const temp = left.innerHTML;
    left.innerHTML = right.innerHTML;
    right.innerHTML = temp;
  });
  replaceCurrentTableFromDom(table);
}

function swapTableRowContent(a: HTMLTableRowElement, b: HTMLTableRowElement) {
  const valuesA = Array.from(a.cells).map((cell) => cell.innerHTML);
  const valuesB = Array.from(b.cells).map((cell) => cell.innerHTML);
  Array.from(a.cells).forEach((cell, index) => {
    cell.innerHTML = valuesB[index] || "";
  });
  Array.from(b.cells).forEach((cell, index) => {
    cell.innerHTML = valuesA[index] || "";
  });
}

function getCurrentTableCell() {
  const activeEditor = editor.value;
  if (!activeEditor) return null;
  const dom = activeEditor.view.domAtPos(activeEditor.state.selection.from).node;
  const element = dom instanceof HTMLElement ? dom : dom.parentElement;
  return element?.closest("td,th") as HTMLTableCellElement | null;
}

function replaceCurrentTableFromDom(table: HTMLTableElement) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const pos = activeEditor.view.posAtDOM(table, 0);
  const node = activeEditor.state.doc.nodeAt(pos);
  if (!node) return;
  (activeEditor as any).commands.insertContentAt({ from: pos, to: pos + node.nodeSize }, table.outerHTML);
}

function indentCode(scope: "selection" | "block", delta: 1 | -1) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const { from, to, $from } = state.selection;
  const blockFrom = scope === "block" ? $from.before() + 1 : from;
  const blockTo = scope === "block" ? $from.after() - 1 : to;
  const text = state.doc.textBetween(blockFrom, blockTo, "\n", "\n");
  const next = text
    .split("\n")
    .map((line) => (delta > 0 ? `  ${line}` : line.replace(/^ {1,2}/, "")))
    .join("\n");
  activeEditor.view.dispatch(state.tr.insertText(next, blockFrom, blockTo).scrollIntoView());
}

function deleteCodeBlock() {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const { $from } = state.selection;
  if ($from.parent.type.name !== "codeBlock") return;
  activeEditor.view.dispatch(state.tr.delete($from.before(), $from.after()).scrollIntoView());
}

function looksLikeMarkdown(text: string) {
  return /(^|\n)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\||!\[[^\]]*\]\(|\[[^\]]+\]\(|\[\^[^\]]+\]:|\$\$)/.test(text) || /\[\^[^\]]+\]|`[^`\n]+`|\*\*[^*]+\*\*|\$[^$\n]+\$/.test(text);
}

function normalizeTableCell(value: string) {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function normalizeFootnoteSource(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function editorHtmlToMarkdown(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const footnoteSources: string[] = [];

  document.querySelectorAll<HTMLElement>('span[data-type="footnote-ref"], sup[data-footnote-ref]').forEach((node) => {
    const id = node.dataset.footnoteRef || "";
    node.replaceWith(document.createTextNode(id ? `[^${id}]` : ""));
  });

  document.querySelectorAll<HTMLElement>('section[data-type="footnotes"]').forEach((node) => {
    const token = `@@LIGHTMARK_TURNDOWN_FOOTNOTE_${footnoteSources.length}@@`;
    footnoteSources.push(normalizeFootnoteSource(node.dataset.markdown || ""));
    node.replaceWith(document.createTextNode(token));
  });

  let markdown = turndown.turndown(document.body.innerHTML);
  footnoteSources.forEach((source, index) => {
    const token = `@@LIGHTMARK_TURNDOWN_FOOTNOTE_${index}@@`;
    markdown = markdown.split(token).join(source ? `\n\n${source}\n\n` : "");
  });
  return markdown;
}

function renderFootnotesView(dom: HTMLElement, markdown: string, fallbackHtml: string) {
  dom.innerHTML = "";
  const source = markdown.trim();
  if (!source) {
    dom.innerHTML = fallbackHtml;
    return;
  }

  const list = document.createElement("ol");
  list.className = "footnotes-list";
  parseFootnoteSource(source).forEach((definition) => {
    const block = document.createElement("li");
    block.id = `fn-${definition.id}`;
    block.className = "footnote-item";
    const index = definition.order || definition.id;

    const marker = document.createElement("span");
    marker.className = "footnote-id";
    marker.textContent = `[${index}]`;

    const content = document.createElement("div");
    content.className = "footnote-content";
    content.innerHTML = renderMarkdownForEditor(definition.content || " ");
    content.title = definition.refs.length > 0 ? "点击返回正文引用" : "";
    content.addEventListener("click", () => {
      const firstRef = definition.refs[0];
      if (firstRef) scrollInternalLink(`#${firstRef}`);
    });

    block.append(marker, content);
    const backrefs = document.createElement("div");
    backrefs.className = "footnote-backrefs";
    definition.refs.forEach((refId, index) => {
      const backref = document.createElement("button");
      backref.type = "button";
      backref.className = "footnote-backref";
      backref.dataset.footnoteTarget = `#${refId}`;
      backref.textContent = `返回${index + 1}`;
      backref.addEventListener("click", () => scrollInternalLink(`#${refId}`));
      backrefs.appendChild(backref);
    });
    block.appendChild(backrefs);
    list.appendChild(block);
  });
  dom.appendChild(list);
}

function parseFootnoteSource(markdown: string) {
  const definitions = markdown.split(/\n{2,}(?= {0,3}\[\^[^\]]+\]:)/).map((item) => item.trim()).filter(Boolean);
  const refMeta = collectFootnoteRefMeta();
  return definitions.map((raw, orderIndex) => {
    const id = raw.match(/^ {0,3}\[\^([^\]]+)\]:/)?.[1] || "";
    const content = raw
      .replace(/^ {0,3}\[\^[^\]]+\]:\s*/, "")
      .replace(/^\n+/, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^( {4}|\t)/, ""))
      .join("\n")
      .trim();
    const meta = refMeta.get(id);
    return { id, raw, content, refs: meta?.refs || [], order: meta?.order || orderIndex + 1 };
  }).sort((left, right) => left.order - right.order);
}

function collectFootnoteRefMeta() {
  const meta = new Map<string, { order: number; refs: string[] }>();
  document.querySelectorAll<HTMLElement>('span[data-type="footnote-ref"][data-footnote-ref][data-ref-id]').forEach((item) => {
    const id = item.dataset.footnoteRef || "";
    if (!id) return;
    const order = Number(item.dataset.footnoteIndex || meta.size + 1);
    const entry = meta.get(id) || { order, refs: [] };
    entry.order = Math.min(entry.order, order);
    if (item.dataset.refId) entry.refs.push(item.dataset.refId);
    meta.set(id, entry);
  });
  document.querySelectorAll<HTMLElement>('sup[data-footnote-ref][data-footnote-index]').forEach((item) => {
    const id = item.dataset.footnoteRef || "";
    if (!id) return;
    const order = Number(item.dataset.footnoteIndex || meta.size + 1);
    const entry = meta.get(id) || { order, refs: [] };
    entry.order = Math.min(entry.order, order);
    item.querySelectorAll<HTMLElement>("a[id]").forEach((link) => {
      if (link.id) entry.refs.push(link.id);
    });
    meta.set(id, entry);
  });
  return meta;
}

function formatFootnotePreview(value: string) {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
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
  if (!range) return createStoredMarkDecorations(state, markName, open, close);
  return [
    Decoration.widget(range.from, () => createSourceMarker(open), createMarkerSpec(-1, `${markName}-open-${range.from}`)),
    Decoration.widget(range.to, () => createSourceMarker(close), createMarkerSpec(1, `${markName}-close-${range.to}`)),
  ];
}

function createStoredMarkDecorations(state: any, markName: string, open: string, close: string) {
  if (!state.selection.empty) return [];
  const markType = state.schema.marks[markName];
  if (!markType || !(state.storedMarks || []).some((mark: any) => mark.type === markType)) return [];

  const pos = state.selection.from;
  return [
    Decoration.widget(pos, () => createSourceMarker(open), createMarkerSpec(-1, `${markName}-stored-open-${pos}`)),
    Decoration.widget(pos, () => createSourceMarker(close), createMarkerSpec(1, `${markName}-stored-close-${pos}`)),
  ];
}

function createLinkDecorations(state: any) {
  const range = getActiveMarkRange(state, "link");
  if (!range) return [];
  const href = range.mark.attrs.href || "";
  return [
    Decoration.widget(range.from, () => createSourceMarker("["), createMarkerSpec(-1, `link-open-${range.from}`)),
    Decoration.widget(range.to, () => createSourceMarker(`](${href})`), createMarkerSpec(1, `link-close-${range.to}`)),
  ];
}

function createHeadingDecorations(state: any) {
  if (!state.selection.empty) return [];
  const { $from } = state.selection;
  if ($from.parent.type.name !== "heading") return [];

  const level = $from.parent.attrs.level || 1;
  return [
    Decoration.widget($from.start(), () => createSourceMarker(`${"#".repeat(level)} `), {
      side: -1,
      key: `heading-marker-${$from.before()}`,
      ignoreSelection: true,
    }),
  ];
}

function createOutlineHeadingDecorations(state: any) {
  const decorations: any[] = [];
  let index = 0;
  state.doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "heading") return true;
    const text = sanitizeOutlineText(node.textContent);
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        "data-outline-id": `heading-${index}-${slugify(text)}`,
      }),
    );
    index += 1;
    return true;
  });
  return decorations;
}

function sanitizeOutlineText(value: string) {
  return value.replace(/[#*_`[\]()]/g, "").trim();
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
}

function getEventElement(event: Event) {
  const target = event.target;
  if (target instanceof HTMLElement) return target;
  if (target instanceof Text) return target.parentElement;
  return null;
}

function scrollInternalLink(href: string) {
  if (!href.startsWith("#")) return;
  const id = decodeURIComponent(href.slice(1));
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function openExternalLink(href: string) {
  try {
    await openUrl(href);
  } catch (error) {
    console.error("打开链接失败", error);
  }
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

function moveOutOfMarkAtRightBoundary(view: any, markNames: string[]) {
  const { state } = view;
  if (!state.selection.empty) return false;

  for (const markName of markNames) {
    const range = getActiveMarkRange(state, markName);
    if (!range || range.to !== state.selection.from) continue;

    const markType = state.schema.marks[markName];
    let tr = state.tr.setSelection(TextSelection.create(state.doc, range.to));
    if (markType) tr = tr.removeStoredMark(markType);
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  return false;
}

function clearStoredMarks(view: any, markNames: string[]) {
  const { state } = view;
  let tr = state.tr;
  let changed = false;
  markNames.forEach((markName) => {
    const markType = state.schema.marks[markName];
    if (!markType) return;
    tr = tr.removeStoredMark(markType);
    changed = true;
  });
  if (changed) view.dispatch(tr);
}

function createMarkerSpec(side: -1 | 1, key: string) {
  return { side, key, ignoreSelection: true };
}

function createSourceMarker(text: string) {
  const marker = document.createElement("span");
  marker.className = "md-live-marker";
  marker.textContent = text;
  marker.contentEditable = "false";
  marker.draggable = false;
  return marker;
}

function convertInlineMarkdownSyntax(state: any) {
  const linkMark = state.schema.marks.link;
  const converters = [
    {
      mark: state.schema.marks.bold,
      pattern: /(?<!\*)\*\*([^*\n]+)\*\*/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.italic,
      pattern: /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.strike,
      pattern: /(?<!~)~~([^~\n]+)~~/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.highlight,
      pattern: /(?<!=)==([^=\n]+)==/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.superscript,
      pattern: /(?<!\^)\^([^^\n]+)\^/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.subscript,
      pattern: /(?<!~)~([^~\n]+)~(?!~)/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: linkMark,
      pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
      labelIndex: 1,
      attrs: (match: RegExpExecArray) => ({ href: match[2] }),
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
      const label = match[converter.labelIndex];
      const from = pos + 1 + match.index;
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

function convertPendingInlineMarkdown(view: any) {
  let converted = false;
  for (let index = 0; index < 12; index += 1) {
    const tr = convertInlineCodeSyntax(view.state) || convertInlineMarkdownSyntax(view.state);
    if (!tr) break;
    view.dispatch(tr);
    converted = true;
  }
  return converted;
}

function convertInlineCodeSyntax(state: any) {
  const codeMark = state.schema.marks.code;
  if (!codeMark) return null;

  let tr = state.tr;
  let converted = false;
  const inlineCodePattern = /`([^`\n]+)`/g;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock) return true;
    if (node.type.name === "codeBlock") return false;

    const text = node.textContent;
    inlineCodePattern.lastIndex = 0;
    const match = inlineCodePattern.exec(text);
    if (!match) return true;

    const full = match[0];
    const code = match[1];
    const from = pos + 1 + match.index;
    const to = pos + 1 + match.index + full.length;
    tr = tr.insertText(code, from, to);
    tr = tr.addMark(from, from + code.length, codeMark.create());
    converted = true;
    return false;
  });

  return converted ? tr : null;
}

function convertMarkdownHeading(
  state: any,
  options: { force?: boolean; onlySelectionBlock?: boolean; insertParagraph?: boolean } = {},
) {
  const { force = false, onlySelectionBlock = false, insertParagraph = false } = options;
  const heading = state.schema.nodes.heading;
  if (!heading) return null;

  let tr = state.tr;
  let converted = false;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;

    const match = node.textContent.match(/^(#{1,6})\s+(.+)$/);
    if (!match) return true;
    if (!force && state.selection.from >= pos && state.selection.from <= pos + node.nodeSize) return true;

    const level = match[1].length;
    const text = match[2];
    const headingNode = heading.create({ level }, state.schema.text(text), node.marks);
    tr = tr.replaceWith(pos, pos + node.nodeSize, headingNode);
    if (insertParagraph) {
      const paragraph = state.schema.nodes.paragraph;
      const after = pos + headingNode.nodeSize;
      if (paragraph) {
        tr = tr.insert(after, paragraph.create());
        tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
      }
    }
    converted = true;
    return false;
  });

  return converted ? tr : null;
}

function editHeadingAsMarkdown(view: any, element: HTMLElement) {
  const pos = view.posAtDOM(element, 0);
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "heading") return;

  let tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + node.nodeSize - 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function getTaskMarkAtSelection(state: any) {
  const taskMark = state.schema.marks.taskState;
  if (!taskMark || !state.selection.empty) return null;
  const { $from } = state.selection;
  return (state.storedMarks || $from.marks()).find((mark: any) => mark.type === taskMark) || null;
}

function continueTaskItem(view: any) {
  const taskMark = getTaskMarkAtSelection(view.state);
  if (!taskMark) return false;

  const listItem = view.state.schema.nodes.listItem;
  if (!listItem) return false;

  const splitCommand = (editor.value as any)?.commands?.splitListItem;
  if (typeof splitCommand === "function" && splitCommand("listItem")) {
    const { state } = view;
    const mark = state.schema.marks.taskState.create({ state: "unchecked" });
    const insertAt = state.selection.from;
    let tr = state.tr
      .insertText(" ", insertAt, insertAt)
      .addMark(insertAt, insertAt + 1, mark);
    tr = tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  return false;
}

function replaceTocWithText(editor: any, getPos: (() => number | undefined) | boolean, value: string) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;
  const { state } = editor.view;
  const node = state.doc.nodeAt(pos);
  const paragraph = state.schema.nodes.paragraph;
  if (!node || !paragraph) return;

  const text = value.trim();
  const replacement = text ? paragraph.create(null, state.schema.text(text)) : paragraph.create();
  const tr = state.tr.replaceWith(pos, pos + node.nodeSize, replacement);
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

function toggleTaskItem(view: any, element: HTMLElement) {
  const state = view.state;
  const taskMark = state.schema.marks.taskState;
  if (!taskMark) return;

  const pos = view.posAtDOM(element.firstChild || element, 0);
  const from = Math.max(0, pos - 2);
  const to = Math.min(state.doc.content.size, pos + element.textContent.length + 2);
  let tr = state.tr;
  let handled = false;

  state.doc.nodesBetween(from, to, (node: any, nodePos: number) => {
    if (handled || !node.isText) return true;
    const mark = node.marks.find((candidate: any) => candidate.type === taskMark);
    if (!mark) return true;

    const checked = mark.attrs.state === "checked";
    const nextState = checked ? "unchecked" : "checked";
    const textFrom = nodePos;
    const textTo = nodePos + node.nodeSize;
    const nextText = node.text.replace(/^\s+/, "");
    tr = tr.insertText(nextText, textFrom, textTo);
    tr = tr.addMark(textFrom, textFrom + nextText.length, taskMark.create({ state: nextState }));
    handled = true;
    return false;
  });

  if (handled) view.dispatch(tr.scrollIntoView());
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
  <div class="relative h-full overflow-auto bg-paper-50 dark:bg-paper-950" @click="hideContextMenu">
    <EditorContent :editor="editor" />
    <div
      v-if="contextMenu.visible"
      class="lm-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
      @mousedown.prevent
      @contextmenu.prevent
    >
      <template v-if="contextMenu.mode === 'code'">
        <button class="lm-menu-item" @click="runMenuCommand(cutSelection)">剪切</button>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">复制</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsMarkdown)">以 Markdown 复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionClean)">简化格式并复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsHtml)">以 HTML 复制</button>
          </div>
        </div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">粘贴</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(false))">普通粘贴</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(true))">清洗格式并粘贴</button>
          </div>
        </div>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('selection', 1))">为选中内容增加缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('selection', -1))">为选中内容减少缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('block', 1))">为整个代码块增加缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('block', -1))">为整个代码块减少缩进</button>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item lm-menu-danger" @click="runMenuCommand(deleteCodeBlock)">删除代码块</button>
      </template>

      <template v-else>
        <button class="lm-menu-item" @click="runMenuCommand(cutSelection)">剪切</button>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">复制</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsMarkdown)">以 Markdown 复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionClean)">简化格式并复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsHtml)">以 HTML 复制</button>
          </div>
        </div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">粘贴</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(false))">普通粘贴</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(true))">清洗格式并粘贴</button>
          </div>
        </div>

        <div class="lm-menu-separator"></div>
        <div class="lm-format-grid" aria-label="格式">
          <button title="加粗" @click="runMenuCommand(() => runFormatCommand('bold'))"><span class="lm-ico lm-ico-bold">B</span></button>
          <button title="斜体" @click="runMenuCommand(() => runFormatCommand('italic'))"><span class="lm-ico lm-ico-italic">I</span></button>
          <button title="行内代码" @click="runMenuCommand(() => runFormatCommand('code'))"><span class="lm-ico lm-ico-code"></span></button>
          <button title="链接" @click="runMenuCommand(toggleLink)"><span class="lm-ico lm-ico-link"></span></button>
          <button title="引用" @click="runMenuCommand(() => runFormatCommand('blockquote'))"><span class="lm-ico lm-ico-quote"></span></button>
          <button title="有序列表" @click="runMenuCommand(() => runFormatCommand('orderedList'))"><span class="lm-ico lm-ico-ol"></span></button>
          <button title="无序列表" @click="runMenuCommand(() => runFormatCommand('bulletList'))"><span class="lm-ico lm-ico-ul"></span></button>
          <button title="任务清单" @click="runMenuCommand(insertTaskItem)"><span class="lm-ico lm-ico-task"></span></button>
        </div>

        <div class="lm-menu-separator"></div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item" :class="{ 'lm-menu-disabled': !canUseTableMenu }">表格</button>
          <div class="lm-menu-pop lm-menu-pop-wide" v-if="canUseTableMenu">
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addRowBefore'))">上方插入行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addRowAfter'))">下方插入行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addColumnBefore'))">左侧插入列</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addColumnAfter'))">右侧插入列</button>
            <div class="lm-menu-separator"></div>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableRow(-1))">上移该行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableRow(1))">下移该行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableColumn(-1))">左移该列</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableColumn(1))">右移该列</button>
            <div class="lm-menu-separator"></div>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('deleteRow'))">删除行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('deleteColumn'))">删除列</button>
            <button class="lm-menu-item" @click="runMenuCommand(copyCurrentTable)">复制表格</button>
            <button class="lm-menu-item" @click="runMenuCommand(copyFormattedTableSource)">格式化表格源码</button>
            <button class="lm-menu-item lm-menu-danger" @click="runMenuCommand(() => runTableCommand('deleteTable'))">删除表格</button>
          </div>
        </div>

        <div class="lm-menu-sub">
          <button class="lm-menu-item">插入</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(insertImageByUrl)">图片</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => insertParagraphAround('before'))">上方段落</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => insertParagraphAround('after'))">下方段落</button>
          </div>
        </div>

        <div class="lm-menu-sub">
          <button class="lm-menu-item">标题</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(1))">一级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(2))">二级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(3))">三级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(4))">四级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(5))">五级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(6))">六级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(null))">正文</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
