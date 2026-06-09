import { mergeAttributes, Node } from "@tiptap/core";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import {
  decodeHtmlEntities,
  findInlineHtmlMatch,
  findRawHtmlMatch,
  rawHtmlKind,
  renderInlineMarkdownInHtml,
  sanitizeInlineHtmlSource,
} from "../utils/html";

type InlineHtmlAttrs = {
  html: string;
  editing?: boolean;
};

type NodeViewPosition = (() => number | undefined) | boolean;

export const InlineHtmlNode = Node.create({
  name: "inlineHtml",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      html: { default: "" },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="inline-html"]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          return { html: sanitizeInlineHtmlSource(decodeHtmlEntities(element.getAttribute("data-html") || element.textContent || "")) };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const html = sanitizeInlineHtmlSource(HTMLAttributes.html || "");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "inline-html",
        "data-html": html,
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;

          let tr = newState.tr;
          let converted = false;

          newState.doc.descendants((node, pos) => {
            if (converted) return false;
            if (!node.isTextblock) return true;
            if (node.type.name === "codeBlock" || textblockHasCodeMark(node)) return false;

            const match = findInlineHtmlMatch(node.textContent);
            if (!match) return true;

            const html = sanitizeInlineHtmlSource(match.html);
            if (!html.includes("<")) return true;

            const from = pos + 1 + match.from;
            const to = pos + 1 + match.to;
            tr = tr.replaceWith(from, to, this.type.create({ html, editing: false }));
            tr = tr.setSelection(NodeSelection.create(tr.doc, from));
            converted = true;
            return false;
          });

          return converted ? tr : null;
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createInlineHtmlView(node.attrs as InlineHtmlAttrs, editor, getPos);
  },
});

export const RawHtmlNode = Node.create({
  name: "rawHtml",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      html: { default: "" },
      kind: { default: "html" },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="raw-html"]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const html = decodeHtmlEntities(element.getAttribute("data-html") || element.textContent || "");
          return { html, kind: element.getAttribute("data-kind") || rawHtmlKind(html) };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const html = decodeHtmlEntities(HTMLAttributes.html || "");
    const kind = HTMLAttributes.kind || rawHtmlKind(html);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "raw-html",
        "data-kind": kind,
        "data-html": html,
        class: kind === "comment" ? "raw-html-node raw-html-node-comment" : "raw-html-node",
      }),
      html,
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;

          let tr = newState.tr;
          let converted = false;

          newState.doc.descendants((node, pos) => {
            if (converted) return false;
            if (!node.isTextblock) return true;
            if (node.type.name === "codeBlock" || textblockHasCodeMark(node)) return false;

            const match = findRawHtmlMatch(node.textContent);
            if (!match) return true;

            const html = match.html;
            const from = pos + 1 + match.from;
            const to = pos + 1 + match.to;
            tr = tr.replaceWith(from, to, this.type.create({ html, kind: rawHtmlKind(html) }));
            tr = tr.setSelection(NodeSelection.create(tr.doc, from));
            converted = true;
            return false;
          });

          return converted ? tr : null;
        },
      }),
    ];
  },
});

function createInlineHtmlView(attrs: InlineHtmlAttrs, editor: any, getPos: NodeViewPosition) {
  const dom = document.createElement("span");
  dom.contentEditable = "false";

  let html = sanitizeInlineHtmlSource(attrs.html || "");
  let editing = Boolean(attrs.editing);

  const updateAttrs = (next: Partial<InlineHtmlAttrs>) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { html, editing, ...next }));
  };

  const exitToDocument = (side: "before" | "after") => {
    editing = false;
    html = sanitizeInlineHtmlSource(html);
    updateAttrs({ html, editing: false });
    renderDisplay();
    setInlineSelection(editor, getPos, side);
  };

  const renderDisplay = () => {
    dom.innerHTML = "";
    dom.className = "inline-html-node";
    const rendered = document.createElement("span");
    rendered.className = "inline-html-rendered";
    rendered.innerHTML = renderInlineMarkdownInHtml(html, { inlineOnly: true });
    dom.appendChild(rendered);
  };

  const renderEditor = () => {
    dom.innerHTML = "";
    dom.className = "inline-html-node inline-html-node-editing";

    const source = document.createElement("span");
    source.className = "inline-html-source-editor";
    source.textContent = html;
    source.spellcheck = false;
    source.contentEditable = "true";

    const preview = document.createElement("span");
    preview.className = "inline-html-live-preview";
    const label = document.createElement("span");
    label.className = "inline-html-live-preview-label";
    label.textContent = "HTML";
    const body = document.createElement("span");
    body.className = "inline-html-live-preview-body";
    preview.append(label, body);

    const refresh = () => {
      html = source.textContent || "";
      body.innerHTML = renderInlineMarkdownInHtml(html, { inlineOnly: true }) || "HTML 预览";
      body.classList.toggle("inline-html-live-preview-empty", !html.trim());
    };

    source.addEventListener("input", refresh);
    source.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !html.trim() && isCaretAtStart(source)) {
        event.preventDefault();
        deleteInlineHtmlNode(editor, getPos);
        return;
      }
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        source.blur();
        return;
      }
      if (event.key === "ArrowRight" && isCaretAtEnd(source)) {
        event.preventDefault();
        exitToDocument("after");
        return;
      }
      if (event.key === "ArrowLeft" && isCaretAtStart(source)) {
        event.preventDefault();
        exitToDocument("before");
      }
    });
    source.addEventListener("blur", () => {
      editing = false;
      html = sanitizeInlineHtmlSource(html);
      updateAttrs({ html, editing: false });
      renderDisplay();
    });

    dom.append(source, preview);
    refresh();
    requestAnimationFrame(() => focusEditableAtEnd(source));
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
      if (nextNode.type.name !== "inlineHtml") return false;
      const nextEditing = Boolean(nextNode.attrs.editing);
      html = sanitizeInlineHtmlSource(nextNode.attrs.html || "");
      if (editing && nextEditing && dom.querySelector(".inline-html-source-editor")) return true;
      editing = nextEditing;
      editing ? renderEditor() : renderDisplay();
      return true;
    },
    selectNode() {
      if (editing) return;
      editing = true;
      updateAttrs({ editing: true });
      renderEditor();
    },
    deselectNode() {
      if (!editing) return;
      editing = false;
      html = sanitizeInlineHtmlSource(html);
      updateAttrs({ html, editing: false });
      renderDisplay();
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof HTMLElement && Boolean(event.target.closest(".inline-html-source-editor")),
  };
}

function textblockHasCodeMark(node: any) {
  let found = false;
  node.descendants((child: any) => {
    if (found || !child.isText) return !found;
    found = child.marks.some((mark: any) => mark.type.name === "code");
    return !found;
  });
  return found;
}

function deleteInlineHtmlNode(editor: any, getPos: NodeViewPosition) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;
  const { state } = editor.view;
  const node = state.doc.nodeAt(pos);
  if (!node) return;
  const tr = state.tr.delete(pos, pos + node.nodeSize);
  const selectionPos = Math.max(0, Math.min(pos, tr.doc.content.size));
  tr.setSelection(TextSelection.near(tr.doc.resolve(selectionPos), -1));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

function setInlineSelection(editor: any, getPos: NodeViewPosition, side: "before" | "after") {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;

  const doc = editor.view.state.doc;
  const resolved = doc.resolve(side === "before" ? pos : pos + 1);
  const selection = TextSelection.near(resolved, side === "before" ? -1 : 1);
  editor.view.dispatch(editor.view.state.tr.setSelection(selection).scrollIntoView());
  editor.view.focus();
}

function focusEditableAtEnd(element: HTMLElement) {
  element.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function isCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.endContainer)) return false;

  const probe = range.cloneRange();
  probe.selectNodeContents(element);
  probe.setStart(range.endContainer, range.endOffset);
  return probe.toString().length === 0;
}

function isCaretAtStart(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return false;

  const probe = range.cloneRange();
  probe.selectNodeContents(element);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length === 0;
}
