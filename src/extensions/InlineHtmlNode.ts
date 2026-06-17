import { mergeAttributes, Node } from "@tiptap/core";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import {
  decodeHtmlEntities,
  findInlineHtmlMatch,
  findRawHtmlMatch,
  rawHtmlKind,
  renderInlineMarkdownInHtml,
  renderRawHtmlSource,
  sanitizeInlineHtmlSource,
} from "../utils/html";

type InlineHtmlAttrs = {
  html: string;
  editing?: boolean;
};

type RawHtmlAttrs = {
  html: string;
  kind?: string;
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
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="raw-html"]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const html = decodeHtmlEntities(element.getAttribute("data-html") || element.textContent || "");
          return { html, kind: element.getAttribute("data-kind") || rawHtmlKind(html), editing: false };
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

  addNodeView() {
    return ({ node, editor, getPos }) => createRawHtmlView(node.attrs as RawHtmlAttrs, editor, getPos);
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

function createRawHtmlView(attrs: RawHtmlAttrs, editor: any, getPos: NodeViewPosition) {
  const dom = document.createElement("span");
  dom.contentEditable = "false";
  let html = decodeHtmlEntities(attrs.html || "");
  let kind = attrs.kind || rawHtmlKind(html);
  let editing = Boolean(attrs.editing);

  const updateAttrs = (next: Partial<RawHtmlAttrs>) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { html, kind, editing, ...next }));
  };

  const replaceWithInlineIfValid = () => {
    if (typeof getPos !== "function") return false;
    const trimmed = html.trim();
    const match = findInlineHtmlMatch(trimmed);
    if (!match || match.from !== 0 || match.to !== trimmed.length) return false;
    const sanitized = sanitizeInlineHtmlSource(trimmed);
    if (!sanitized.includes("<")) return false;
    const pos = getPos();
    if (typeof pos !== "number") return false;
    const inlineType = editor.view.state.schema.nodes.inlineHtml;
    if (!inlineType) return false;
    editor.view.dispatch(editor.view.state.tr.replaceWith(pos, pos + 1, inlineType.create({ html: sanitized, editing: false })));
    return true;
  };

  const commit = () => {
    if (!editing) return;
    editing = false;
    kind = rawHtmlKind(html);
    if (replaceWithInlineIfValid()) return;
    updateAttrs({ html, kind, editing: false });
    renderDisplay();
  };

  const renderDisplay = () => {
    dom.innerHTML = "";
    kind = rawHtmlKind(html);
    dom.className = kind === "comment" ? "raw-html-node raw-html-node-comment" : "raw-html-node";
    dom.innerHTML = renderRawHtmlSource(html);
  };

  const renderEditor = () => {
    dom.innerHTML = "";
    dom.className = "raw-html-node raw-html-node-editing";
    const source = document.createElement("span");
    source.className = kind === "comment" ? "raw-html-source-editor raw-html-source-editor-comment" : "raw-html-source-editor";
    source.textContent = html;
    source.spellcheck = false;
    source.contentEditable = "true";
    source.addEventListener("input", () => {
      html = source.textContent || "";
    });
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
        commit();
        setInlineSelection(editor, getPos, "after");
        return;
      }
      if (event.key === "ArrowLeft" && isCaretAtStart(source)) {
        event.preventDefault();
        commit();
        setInlineSelection(editor, getPos, "before");
      }
    });
    source.addEventListener("blur", commit);
    dom.append(source);
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
      if (nextNode.type.name !== "rawHtml") return false;
      html = decodeHtmlEntities(nextNode.attrs.html || "");
      kind = nextNode.attrs.kind || rawHtmlKind(html);
      const nextEditing = Boolean(nextNode.attrs.editing);
      if (editing && nextEditing && dom.querySelector(".raw-html-source-editor")) return true;
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
      commit();
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof HTMLElement && Boolean(event.target.closest(".raw-html-source-editor")),
  };
}

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

    const refresh = () => {
      html = source.textContent || "";
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

    dom.append(source);
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
