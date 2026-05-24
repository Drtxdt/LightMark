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
import { openUrl } from "@tauri-apps/plugin-opener";
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
      ["input", { type: "checkbox", checked: checked ? "checked" : null, contenteditable: "false" }],
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
      let editing = false;

      const updateYaml = () => {
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { yaml }));
      };

      const renderDisplay = () => {
        dom.innerHTML = "";
        dom.className = "front-matter-node";
        const open = document.createElement("div");
        open.className = "front-matter-fence";
        open.textContent = "---";
        const pre = document.createElement("pre");
        pre.textContent = yaml;
        const close = document.createElement("div");
        close.className = "front-matter-fence";
        close.textContent = "---";
        dom.append(open, pre, close);
      };

      const renderEditor = () => {
        dom.innerHTML = "";
        dom.className = "front-matter-node front-matter-node-editing";
        const open = document.createElement("div");
        open.className = "front-matter-fence";
        open.textContent = "---";
        const textarea = document.createElement("textarea");
        textarea.className = "front-matter-editor";
        textarea.value = yaml;
        textarea.rows = Math.max(3, yaml.split(/\r?\n/).length);
        textarea.spellcheck = false;
        const close = document.createElement("div");
        close.className = "front-matter-fence";
        close.textContent = "---";
        textarea.addEventListener("input", () => {
          yaml = textarea.value;
          textarea.rows = Math.max(3, yaml.split(/\r?\n/).length);
        });
        textarea.addEventListener("blur", () => {
          editing = false;
          updateYaml();
          renderDisplay();
        });
        dom.append(open, textarea, close);
        requestAnimationFrame(() => textarea.focus());
      };

      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        renderEditor();
      });

      renderDisplay();
      return {
        dom,
        update(nextNode: any) {
          yaml = nextNode.attrs.yaml || "";
          editing ? renderEditor() : renderDisplay();
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
      };
    };
  },
});

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
      preview.textContent = formatFootnotePreview(node.attrs.preview || "");

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
          if (transactions.some((transaction) => transaction.selectionSet)) return null;
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
    return markdown ? `\n\n${markdown.trim()}\n\n` : "";
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
      if (event.key === "ArrowRight" && moveOutOfMarkAtRightBoundary(view, ["bold", "strike"])) {
        event.preventDefault();
        return true;
      }
      if (event.key === "Enter") {
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
      click(view, event) {
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

      const task = target?.closest<HTMLElement>("[data-task-item]");
      if (task) {
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

function looksLikeMarkdown(text: string) {
  return /(^|\n)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\||!\[[^\]]*\]\(|\[[^\]]+\]\(|\[\^[^\]]+\]:|\$\$)/.test(text) || /\[\^[^\]]+\]|`[^`\n]+`|\*\*[^*]+\*\*|\$[^$\n]+\$/.test(text);
}

function normalizeTableCell(value: string) {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function editorHtmlToMarkdown(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");

  document.querySelectorAll<HTMLElement>('span[data-type="footnote-ref"], sup[data-footnote-ref]').forEach((node) => {
    const id = node.dataset.footnoteRef || "";
    node.replaceWith(document.createTextNode(id ? `[^${id}]` : ""));
  });

  document.querySelectorAll<HTMLElement>('section[data-type="footnotes"]').forEach((node) => {
    const markdown = node.dataset.markdown || "";
    node.replaceWith(document.createTextNode(markdown ? `\n\n${markdown.trim()}\n\n` : ""));
  });

  return turndown.turndown(document.body.innerHTML);
}

function renderFootnotesView(dom: HTMLElement, markdown: string, fallbackHtml: string) {
  dom.innerHTML = "";
  const source = markdown.trim();
  if (!source) {
    dom.innerHTML = fallbackHtml;
    return;
  }

  const list = document.createElement("div");
  list.className = "footnotes-source";
  parseFootnoteSource(source).forEach((definition) => {
    const block = document.createElement("div");
    block.className = "footnote-source-item";
    const sourceBlock = document.createElement("div");
    sourceBlock.className = "footnote-source-text";
    sourceBlock.title = definition.refs.length > 0 ? "点击返回正文引用" : "";
    sourceBlock.addEventListener("click", () => {
      const firstRef = definition.refs[0];
      if (firstRef) scrollInternalLink(`#${firstRef}`);
    });
    renderFootnoteSourceLines(sourceBlock, definition.raw);
    block.appendChild(sourceBlock);
    definition.refs.forEach((refId, index) => {
      const backref = document.createElement("button");
      backref.type = "button";
      backref.className = "footnote-backref";
      backref.dataset.footnoteTarget = `#${refId}`;
      backref.textContent = `返回${definition.refs.length > 1 ? index + 1 : ""}`;
      backref.addEventListener("click", () => scrollInternalLink(`#${refId}`));
      block.appendChild(backref);
    });
    list.appendChild(block);
  });
  dom.appendChild(list);
}

function parseFootnoteSource(markdown: string) {
  const definitions = markdown.split(/\n{2,}(?= {0,3}\[\^[^\]]+\]:)/).map((item) => item.trim()).filter(Boolean);
  return definitions.map((raw) => {
    const id = raw.match(/^ {0,3}\[\^([^\]]+)\]:/)?.[1] || "";
    const escapedId = cssEscape(id);
    const refs = Array.from(
      document.querySelectorAll<HTMLElement>(
        `sup[data-footnote-ref="${escapedId}"] a[id], span[data-type="footnote-ref"][data-footnote-ref="${escapedId}"][data-ref-id]`,
      ),
    )
      .map((item) => item.id || item.dataset.refId || "")
      .filter(Boolean);
    return { id, raw, refs };
  });
}

function renderFootnoteSourceLines(container: HTMLElement, raw: string) {
  raw.split(/\r?\n/).forEach((line, index) => {
    const row = document.createElement("div");
    row.className = index === 0 ? "footnote-source-line footnote-source-heading" : "footnote-source-line";
    row.textContent = line || " ";
    container.appendChild(row);
  });
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

function createHeadingDecorations(state: any) {
  if (!state.selection.empty) return [];
  const { $from } = state.selection;
  if ($from.parent.type.name !== "heading") return [];

  const level = $from.parent.attrs.level || 1;
  return [
    Decoration.widget($from.start(), () => createSourceMarker(`${"#".repeat(level)} `), {
      side: -1,
      key: `heading-marker-${$from.before()}`,
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
      mark: state.schema.marks.strike,
      pattern: /(^|[\s(])~~([^~\n]+)~~/g,
      attrs: () => ({}),
    },
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
  <div class="h-full overflow-auto bg-paper-50 dark:bg-paper-950">
    <EditorContent :editor="editor" />
  </div>
</template>
