import { mergeAttributes, Node } from "@tiptap/core";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import katex from "katex";

type MathAttrs = {
  tex: string;
  editing?: boolean;
};

export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      tex: { default: "" },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="inline-math"]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          return { tex: element.dataset.tex || element.textContent || "" };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const tex = HTMLAttributes.tex || "";
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "inline-math",
        "data-tex": tex,
      }),
      tex,
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;

          let tr = newState.tr;
          let converted = false;
          const inlineMathPattern = /(^|[^$])\$([^$\n]+?)\$/g;

          newState.doc.descendants((node, pos) => {
            if (converted) return false;
            if (!node.isTextblock) return true;
            if (node.type.name === "codeBlock") return false;

            const text = node.textContent;
            inlineMathPattern.lastIndex = 0;
            const match = inlineMathPattern.exec(text);
            if (!match) return true;

            const full = match[0];
            const leadingLength = match[1].length;
            const tex = match[2].trim();
            if (!tex) return true;

            const from = pos + 1 + match.index + leadingLength;
            const to = pos + 1 + match.index + full.length;
            tr = tr.replaceWith(from, to, this.type.create({ tex, editing: true }));
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
    return ({ node, editor, getPos }) => createInlineMathView(node.attrs as MathAttrs, editor, getPos);
  },
});

export const BlockMath = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      tex: { default: "" },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="block-math"]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          return { tex: element.dataset.tex || element.textContent || "" };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const tex = HTMLAttributes.tex || "";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "block-math",
        "data-tex": tex,
      }),
      tex,
    ];
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

            const text = $from.parent.textContent;
            if (text.trim() !== "$$" || $from.parentOffset < text.length) return false;

            event.preventDefault();
            const from = $from.before();
            const to = $from.after();
            const node = state.schema.nodes.blockMath.create({ tex: "", editing: true });
            const tr = state.tr.replaceWith(from, to, node);
            view.dispatch(tr.scrollIntoView());
            requestAnimationFrame(() => {
              view.dom.querySelector<HTMLTextAreaElement>(".math-block-editor")?.focus();
            });
            return true;
          },
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createBlockMathView(node.attrs as MathAttrs, editor, getPos);
  },
});

type NodeViewPosition = (() => number | undefined) | boolean;

function createInlineMathView(attrs: MathAttrs, editor: any, getPos: NodeViewPosition) {
  const dom = document.createElement("span");
  dom.className = "math-node math-node-inline";
  dom.contentEditable = "false";

  let tex = attrs.tex || "";
  let editing = Boolean(attrs.editing);

  const updateAttrs = (next: Partial<MathAttrs>) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { tex, editing, ...next }));
  };

  const exitToDocument = (side: "before" | "after") => {
    editing = false;
    updateAttrs({ tex, editing: false });
    renderDisplay();
    setInlineSelection(editor, getPos, side);
  };

  const renderDisplay = () => {
    dom.innerHTML = "";
    dom.className = "math-node math-node-inline";
    const rendered = document.createElement("span");
    rendered.className = "math-render math-render-inline";
    renderKatex(rendered, tex, false);
    dom.appendChild(rendered);
  };

  const renderEditor = () => {
    dom.innerHTML = "";
    dom.className = "math-node math-node-inline math-node-inline-editing";

    const source = document.createElement("span");
    source.className = "math-inline-source-editor";
    source.textContent = tex;
    source.spellcheck = false;
    source.contentEditable = "true";

    const preview = document.createElement("span");
    preview.className = "math-live-preview math-live-preview-inline";
    const label = document.createElement("span");
    label.className = "math-live-preview-label";
    label.textContent = "预览";
    const body = document.createElement("span");
    body.className = "math-live-preview-body";
    preview.append(label, body);

    const refresh = () => {
      tex = source.textContent || "";
      renderKatex(body, tex, false, "公式预览");
    };

    source.addEventListener("input", refresh);
    source.addEventListener("keydown", (event) => {
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
      updateAttrs({ tex, editing: false });
      renderDisplay();
    });

    dom.append(source, preview);
    renderKatex(body, tex, false, "公式预览");
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
      if (nextNode.type.name !== "inlineMath") return false;
      const nextEditing = Boolean(nextNode.attrs.editing);
      tex = nextNode.attrs.tex || "";
      if (editing && nextEditing && dom.querySelector(".math-inline-source-editor")) return true;
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
      updateAttrs({ editing: false });
      renderDisplay();
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof HTMLElement && Boolean(event.target.closest(".math-inline-source-editor")),
  };
}

function createBlockMathView(attrs: MathAttrs, editor: any, getPos: NodeViewPosition) {
  const dom = document.createElement("section");
  dom.className = "math-node math-node-block";
  dom.contentEditable = "false";

  let tex = attrs.tex || "";
  let editing = attrs.editing || !tex;

  const updateAttrs = (next: Partial<MathAttrs>) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { tex, editing, ...next }));
  };

  const exitToNextParagraph = () => {
    editing = false;
    updateAttrs({ tex, editing: false });
    if (tex.trim()) renderDisplay();
    setBlockSelectionAfter(editor, getPos);
  };

  const exitToPreviousParagraph = () => {
    editing = false;
    updateAttrs({ tex, editing: false });
    if (tex.trim()) renderDisplay();
    setBlockSelectionBefore(editor, getPos);
  };

  const renderDisplay = () => {
    dom.innerHTML = "";
    dom.className = "math-node math-node-block";
    const rendered = document.createElement("div");
    rendered.className = "math-render math-render-block";
    renderKatex(rendered, tex, true);
    dom.appendChild(rendered);
  };

  const renderEditor = () => {
    dom.innerHTML = "";
    dom.className = "math-node math-node-block math-node-block-editing";

    const textarea = document.createElement("textarea");
    textarea.className = "math-block-editor";
    textarea.value = tex;
    textarea.rows = Math.max(2, tex.split(/\r?\n/).length);
    textarea.spellcheck = false;

    const preview = document.createElement("div");
    preview.className = "math-live-preview math-live-preview-block";
    const label = document.createElement("span");
    label.className = "math-live-preview-label";
    label.textContent = "预览";
    const body = document.createElement("div");
    body.className = "math-live-preview-body math-live-preview-body-block";
    preview.append(label, body);

    const refresh = () => {
      tex = textarea.value;
      textarea.rows = Math.max(2, tex.split(/\r?\n/).length);
      renderKatex(body, tex, true, "公式预览");
      updateAttrs({ tex, editing: true });
    };

    textarea.addEventListener("input", refresh);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        textarea.blur();
        return;
      }
      if (event.key === "ArrowRight" && textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length) {
        event.preventDefault();
        exitToNextParagraph();
        return;
      }
      if (event.key === "ArrowLeft" && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        event.preventDefault();
        exitToPreviousParagraph();
      }
    });
    textarea.addEventListener("blur", () => {
      editing = false;
      updateAttrs({ tex, editing: false });
      if (tex.trim()) renderDisplay();
    });

    dom.append(textarea, preview);
    renderKatex(body, tex, true, "公式预览");
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
      if (nextNode.type.name !== "blockMath") return false;
      const nextEditing = Boolean(nextNode.attrs.editing) || !nextNode.attrs.tex;
      tex = nextNode.attrs.tex || "";
      if (editing && nextEditing && dom.querySelector(".math-block-editor")) return true;
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
      if (!editing || !tex.trim()) return;
      editing = false;
      updateAttrs({ editing: false });
      renderDisplay();
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
  };
}

function renderKatex(target: HTMLElement, tex: string, displayMode: boolean, emptyText = tex) {
  target.innerHTML = "";
  if (!tex.trim()) {
    target.textContent = emptyText;
    target.classList.add("math-live-preview-empty");
    return;
  }
  target.classList.remove("math-live-preview-empty");

  try {
    katex.render(tex, target, {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    target.textContent = tex;
    target.classList.add("math-render-error");
  }
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

function setBlockSelectionAfter(editor: any, getPos: NodeViewPosition) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;

  const { state } = editor.view;
  const node = state.doc.nodeAt(pos);
  if (!node) return;

  let tr = state.tr;
  const after = pos + node.nodeSize;
  const paragraph = state.schema.nodes.paragraph;

  if (paragraph && after >= tr.doc.content.size) {
    tr = tr.insert(after, paragraph.create());
    tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
  } else {
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after), 1));
  }

  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

function setBlockSelectionBefore(editor: any, getPos: NodeViewPosition) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;

  const { state } = editor.view;
  const paragraph = state.schema.nodes.paragraph;
  let tr = state.tr;

  if (paragraph && pos <= 0) {
    tr = tr.insert(0, paragraph.create());
    tr = tr.setSelection(TextSelection.create(tr.doc, 1));
  } else {
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos), -1));
  }

  editor.view.dispatch(tr.scrollIntoView());
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
