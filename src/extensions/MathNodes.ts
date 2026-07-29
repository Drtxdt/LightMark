import { mergeAttributes, Node } from "@tiptap/core";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { createVNode, render, type Component } from "vue";
import { CodeXml, Copy, RefreshCw, Sigma } from "@lucide/vue";
import {
  createLatexSuggestController,
  getContentEditableCaret,
  setContentEditableCaret,
  type LatexSuggestController,
  type LatexSuggestion,
} from "./LatexSuggest";
import {
  evaluateMathTokens,
  mathTokenFromParts,
  parseInlineMathText,
  serializeMathToken,
  type MathEvaluationEntry,
  type MathDelimiter,
  type MarkdownMathToken,
} from "../utils/mathMarkdown";
import { appStore, recordNavigationLocation } from "../stores/appStore";

type MathAttrs = {
  tex: string;
  editing?: boolean;
  delimiter?: MathDelimiter;
  raw?: string;
  originalTex?: string;
  displayMode?: boolean;
};

function findInlineMathMatch(text: string, isAllowedRange: (from: number, to: number) => boolean = () => true) {
  return parseInlineMathText(text)
    .find((token) => isAllowedRange(token.from, token.to) && !isWholeTextBlockMathDelimiter(text, token.from, token.to))
    ?? null;
}

function isWholeTextBlockMathDelimiter(text: string, from: number, to: number) {
  return from === 0 && to === text.length && /^\s*\$\$\s*$/.test(text);
}

function isBlockMathOpeningDelimiter(text: string) {
  return /^\s*(\$\$|\\\[)\s*$/.test(text);
}

export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      tex: { default: "" },
      delimiter: { default: "inline-dollar" },
      raw: { default: "" },
      originalTex: { default: "" },
      displayMode: { default: false },
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
          const tex = element.dataset.tex || element.textContent || "";
          return {
            tex,
            delimiter: element.dataset.mathDelimiter || "inline-dollar",
            raw: element.dataset.mathRaw || "",
            originalTex: element.dataset.originalTex ?? tex,
            displayMode: element.dataset.displayMode === "true",
          };
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
        "data-original-tex": HTMLAttributes.originalTex ?? tex,
        "data-math-raw": HTMLAttributes.raw || "",
        "data-math-delimiter": HTMLAttributes.delimiter || "inline-dollar",
        "data-display-mode": String(Boolean(HTMLAttributes.displayMode)),
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

          newState.doc.descendants((node, pos) => {
            if (converted) return false;
            if (!node.isTextblock) return true;
            if (node.type.name === "codeBlock") return false;

            const text = node.textContent;
            const codeRanges = getCodeMarkRanges(node);
            const match = findInlineMathMatch(text, (from, to) => !rangeOverlapsCodeMark(codeRanges, from, to));
            if (!match) return true;

            const tex = match.tex;
            if (!tex.trim()) return true;

            const from = pos + 1 + match.from;
            const to = pos + 1 + match.to;
            tr = tr.replaceWith(from, to, this.type.create({
              tex,
              editing: true,
              delimiter: match.delimiter,
              raw: match.raw,
              originalTex: tex,
              displayMode: match.displayMode,
            }));
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

function getCodeMarkRanges(node: any) {
  const ranges: Array<{ from: number; to: number }> = [];
  node.forEach((child: any, offset: number) => {
    if (!child.isText) return;
    if (!child.marks.some((mark: any) => mark.type.name === "code")) return;
    ranges.push({ from: offset, to: offset + child.text.length });
  });
  return ranges;
}

function rangeOverlapsCodeMark(ranges: Array<{ from: number; to: number }>, from: number, to: number) {
  return ranges.some((range) => from < range.to && to > range.from);
}

export const BlockMath = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      tex: { default: "" },
      delimiter: { default: "display-dollar" },
      raw: { default: "" },
      originalTex: { default: "" },
      displayMode: { default: true },
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
          const tex = element.dataset.tex || element.textContent || "";
          return {
            tex,
            delimiter: element.dataset.mathDelimiter || "display-dollar",
            raw: element.dataset.mathRaw || "",
            originalTex: element.dataset.originalTex ?? tex,
            displayMode: true,
          };
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
        "data-original-tex": HTMLAttributes.originalTex ?? tex,
        "data-math-raw": HTMLAttributes.raw || "",
        "data-math-delimiter": HTMLAttributes.delimiter || "display-dollar",
        "data-display-mode": "true",
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
            if (!isBlockMathOpeningDelimiter(text) || $from.parentOffset < text.length) return false;

            event.preventDefault();
            const from = $from.before();
            const to = $from.after();
            const delimiter: MathDelimiter = text.trim() === "\\[" ? "display-bracket" : "display-dollar";
            const node = state.schema.nodes.blockMath.create({
              tex: "",
              editing: true,
              delimiter,
              raw: "",
              originalTex: "",
              displayMode: true,
            });
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

type EditorMathEvaluation = {
  entriesByPos: Map<number, MathEvaluationEntry>;
  numberingMode: typeof appStore.settings.markdown.mathNumbering;
};

const editorMathEvaluationCache = new WeakMap<object, EditorMathEvaluation>();

function evaluateEditorMath(editor: any): EditorMathEvaluation {
  const doc = editor.view.state.doc as object;
  const cached = editorMathEvaluationCache.get(doc);
  const numberingMode = appStore.settings.markdown.mathNumbering;
  if (cached?.numberingMode === numberingMode) return cached;

  const tokens: MarkdownMathToken[] = [];
  editor.view.state.doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "inlineMath" && node.type.name !== "blockMath") return true;
    tokens.push(positionMathToken(
      mathTokenFromParts({
        tex: node.attrs.tex || "",
        delimiter: node.attrs.delimiter,
        raw: node.attrs.raw,
        displayMode: node.type.name === "blockMath" || Boolean(node.attrs.displayMode),
      }),
      pos,
      node.nodeSize,
    ));
    return false;
  });
  const evaluated = evaluateMathTokens(tokens, { numberingMode });
  const value = {
    entriesByPos: new Map(evaluated.entries.map((entry) => [entry.token.from, entry])),
    numberingMode,
  };
  editorMathEvaluationCache.set(doc, value);
  return value;
}

function evaluateEditorMathAt(
  editor: any,
  getPos: NodeViewPosition,
  tex?: string,
  delimiter?: MathDelimiter,
  displayMode?: boolean,
) {
  if (typeof getPos !== "function") return null;
  const targetPos = getPos();
  if (typeof targetPos !== "number") return null;
  if (tex === undefined) return evaluateEditorMath(editor).entriesByPos.get(targetPos) ?? null;

  const tokens: MarkdownMathToken[] = [];
  editor.view.state.doc.descendants((node: any, pos: number) => {
    if (pos > targetPos) return false;
    if (node.type.name !== "inlineMath" && node.type.name !== "blockMath") return true;
    const isTarget = pos === targetPos;
    tokens.push(positionMathToken(
      mathTokenFromParts({
        tex: isTarget ? tex : node.attrs.tex || "",
        delimiter: isTarget ? delimiter : node.attrs.delimiter,
        raw: isTarget ? "" : node.attrs.raw,
        displayMode: isTarget
          ? displayMode
          : node.type.name === "blockMath" || Boolean(node.attrs.displayMode),
      }),
      pos,
      node.nodeSize,
    ));
    return !isTarget;
  });
  return evaluateMathTokens(tokens, {
    numberingMode: appStore.settings.markdown.mathNumbering,
  }).entries.at(-1) ?? null;
}

function positionMathToken(token: MarkdownMathToken, pos: number, nodeSize: number): MarkdownMathToken {
  const contentOffset = token.contentFrom - token.from;
  const contentLength = token.contentTo - token.contentFrom;
  return {
    ...token,
    from: pos,
    to: pos + nodeSize,
    contentFrom: pos + contentOffset,
    contentTo: pos + contentOffset + contentLength,
  };
}

function createInlineMathView(attrs: MathAttrs, editor: any, getPos: NodeViewPosition) {
  const dom = document.createElement("span");
  dom.className = "math-node math-node-inline";
  dom.contentEditable = "false";

  let tex = attrs.tex || "";
  let delimiter = attrs.delimiter || "inline-dollar";
  let raw = attrs.raw || "";
  let originalTex = attrs.originalTex ?? tex;
  let displayMode = Boolean(attrs.displayMode);
  let editing = Boolean(attrs.editing);
  let suggest: LatexSuggestController | null = null;

  const updateAttrs = (next: Partial<MathAttrs>) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, {
      tex,
      delimiter,
      raw,
      originalTex,
      displayMode,
      editing,
      ...next,
    }));
  };

  const exitToDocument = (side: "before" | "after") => {
    editing = false;
    raw = tex === originalTex ? raw : "";
    updateAttrs({ tex, raw, editing: false });
    renderDisplay();
    setInlineSelection(editor, getPos, side);
  };

  const renderDisplay = () => {
    suggest?.destroy();
    suggest = null;
    dom.innerHTML = "";
    dom.className = "math-node math-node-inline";
    const rendered = document.createElement("span");
    rendered.className = "math-render math-render-inline";
    renderKatex(rendered, tex, displayMode, tex, {
      delimiter,
      raw,
      evaluation: evaluateEditorMathAt(editor, getPos),
    });
    dom.appendChild(rendered);
    appendMathTools(dom, rendered, { tex, delimiter, raw, displayMode }, () => {
      editorMathEvaluationCache.delete(editor.view.state.doc);
      renderDisplay();
    });
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
      renderKatex(body, tex, displayMode, "公式预览", {
        delimiter,
        raw: "",
        evaluation: evaluateEditorMathAt(editor, getPos, tex, delimiter, displayMode),
      });
      suggest?.sync();
    };

    suggest = createLatexSuggestController({
      host: dom,
      anchor: source,
      getValue: () => source.textContent || "",
      setValue: (value) => {
        source.textContent = value;
        tex = value;
      },
      getCaret: () => getContentEditableCaret(source),
      setCaret: (position) => setContentEditableCaret(source, position),
      focus: () => focusEditableAtEnd(source),
      onChange: refresh,
      getAdditionalSuggestions: () => documentMacroSuggestions(
        evaluateEditorMathAt(editor, getPos, tex, delimiter, displayMode)?.availableMacroNames ?? [],
      ),
    });

    source.addEventListener("input", refresh);
    source.addEventListener("keydown", (event) => {
      if (suggest?.handleKeyDown(event)) return;
      if (event.key === "Backspace" && !tex.trim() && isCaretAtStart(source)) {
        event.preventDefault();
        deleteMathNode(editor, getPos);
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
      window.setTimeout(() => suggest?.close(), 120);
      editing = false;
      raw = tex === originalTex ? raw : "";
      updateAttrs({ tex, raw, editing: false });
      renderDisplay();
    });

    dom.append(source, preview);
    const evaluation = evaluateEditorMathAt(editor, getPos, tex, delimiter, displayMode);
    renderKatex(body, tex, displayMode, "公式预览", { delimiter, raw: "", evaluation });
    const diagnostic = evaluation?.diagnostic ?? null;
    requestAnimationFrame(() => {
      source.focus();
      setContentEditableCaret(source, diagnostic?.texOffset ?? tex.length);
    });
  };

  dom.addEventListener("mousedown", (event) => {
    if (editing) return;
    const reference = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a.math-ref-link");
    if (reference) {
      event.preventDefault();
      event.stopPropagation();
      recordNavigationLocation();
      window.dispatchEvent(new CustomEvent("lightmark:jump-math", {
        detail: {
          targetId: reference.hash.slice(1),
          paneId: appStore.splitLayout.activePaneId,
        },
      }));
      return;
    }
    event.preventDefault();
    editing = true;
    updateAttrs({ editing: true });
    renderEditor();
  });

  editing ? renderEditor() : renderDisplay();
  const refreshFromDocument = ({ transaction }: { transaction: { docChanged?: boolean } }) => {
    if (!transaction.docChanged || editing) return;
    window.queueMicrotask(renderDisplay);
  };
  editor.on?.("transaction", refreshFromDocument);
  const refreshFromMathSettings = () => {
    if (!editing) renderDisplay();
  };
  window.addEventListener("lightmark:math-settings-changed", refreshFromMathSettings);
  const refreshFromMathTools = () => {
    editorMathEvaluationCache.delete(editor.view.state.doc);
    if (!editing) renderDisplay();
  };
  window.addEventListener("lightmark:refresh-math", refreshFromMathTools);

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "inlineMath") return false;
      const nextEditing = Boolean(nextNode.attrs.editing);
      tex = nextNode.attrs.tex || "";
      delimiter = nextNode.attrs.delimiter || "inline-dollar";
      raw = nextNode.attrs.raw || "";
      originalTex = nextNode.attrs.originalTex ?? tex;
      displayMode = Boolean(nextNode.attrs.displayMode);
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
    destroy() {
      suggest?.destroy();
      editor.off?.("transaction", refreshFromDocument);
      window.removeEventListener("lightmark:math-settings-changed", refreshFromMathSettings);
      window.removeEventListener("lightmark:refresh-math", refreshFromMathTools);
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof HTMLElement && Boolean(event.target.closest(".math-inline-source-editor,.math-suggest,.math-tools")),
  };
}

function createBlockMathView(attrs: MathAttrs, editor: any, getPos: NodeViewPosition) {
  const dom = document.createElement("section");
  dom.className = "math-node math-node-block";
  dom.contentEditable = "false";

  let tex = attrs.tex || "";
  let delimiter = attrs.delimiter || "display-dollar";
  let raw = attrs.raw || "";
  let originalTex = attrs.originalTex ?? tex;
  let editing = attrs.editing || !tex;
  let suggest: LatexSuggestController | null = null;

  const updateAttrs = (next: Partial<MathAttrs>) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, {
      tex,
      delimiter,
      raw,
      originalTex,
      displayMode: true,
      editing,
      ...next,
    }));
  };

  const exitToNextParagraph = () => {
    editing = false;
    raw = tex === originalTex ? raw : "";
    updateAttrs({ tex, raw, editing: false });
    if (tex.trim()) renderDisplay();
    setBlockSelectionAfter(editor, getPos);
  };

  const exitToPreviousParagraph = () => {
    editing = false;
    raw = tex === originalTex ? raw : "";
    updateAttrs({ tex, raw, editing: false });
    if (tex.trim()) renderDisplay();
    setBlockSelectionBefore(editor, getPos);
  };

  const renderDisplay = () => {
    suggest?.destroy();
    suggest = null;
    dom.innerHTML = "";
    dom.className = "math-node math-node-block";
    const rendered = document.createElement("div");
    rendered.className = "math-render math-render-block";
    renderKatex(rendered, tex, true, tex, {
      delimiter,
      raw,
      evaluation: evaluateEditorMathAt(editor, getPos),
    });
    dom.appendChild(rendered);
    appendMathTools(dom, rendered, { tex, delimiter, raw, displayMode: true }, () => {
      editorMathEvaluationCache.delete(editor.view.state.doc);
      renderDisplay();
    });
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
      renderKatex(body, tex, true, "公式预览", {
        delimiter,
        raw: "",
        evaluation: evaluateEditorMathAt(editor, getPos, tex, delimiter, true),
      });
      updateAttrs({ tex, raw: "", editing: true });
      suggest?.sync();
    };

    suggest = createLatexSuggestController({
      host: dom,
      anchor: textarea,
      getValue: () => textarea.value,
      setValue: (value) => {
        textarea.value = value;
        tex = value;
      },
      getCaret: () => textarea.selectionStart,
      setCaret: (position) => textarea.setSelectionRange(position, position),
      focus: () => textarea.focus(),
      onChange: refresh,
      getAdditionalSuggestions: () => documentMacroSuggestions(
        evaluateEditorMathAt(editor, getPos, tex, delimiter, true)?.availableMacroNames ?? [],
      ),
    });

    textarea.addEventListener("input", refresh);
    textarea.addEventListener("keydown", (event) => {
      if (suggest?.handleKeyDown(event)) return;
      if (event.key === "Backspace" && !tex.trim() && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        event.preventDefault();
        deleteMathNode(editor, getPos);
        return;
      }
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
      window.setTimeout(() => suggest?.close(), 120);
      editing = false;
      raw = tex === originalTex ? raw : "";
      updateAttrs({ tex, raw, editing: false });
      if (tex.trim()) renderDisplay();
    });

    dom.append(textarea, preview);
    const evaluation = evaluateEditorMathAt(editor, getPos, tex, delimiter, true);
    renderKatex(body, tex, true, "公式预览", { delimiter, raw: "", evaluation });
    const diagnostic = evaluation?.diagnostic ?? null;
    requestAnimationFrame(() => {
      textarea.focus();
      const offset = diagnostic?.texOffset ?? tex.length;
      textarea.setSelectionRange(offset, offset);
    });
  };

  dom.addEventListener("mousedown", (event) => {
    if (editing) return;
    const reference = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a.math-ref-link");
    if (reference) {
      event.preventDefault();
      event.stopPropagation();
      recordNavigationLocation();
      window.dispatchEvent(new CustomEvent("lightmark:jump-math", {
        detail: {
          targetId: reference.hash.slice(1),
          paneId: appStore.splitLayout.activePaneId,
        },
      }));
      return;
    }
    event.preventDefault();
    editing = true;
    updateAttrs({ editing: true });
    renderEditor();
  });

  editing ? renderEditor() : renderDisplay();
  const refreshFromDocument = ({ transaction }: { transaction: { docChanged?: boolean } }) => {
    if (!transaction.docChanged || editing) return;
    window.queueMicrotask(renderDisplay);
  };
  editor.on?.("transaction", refreshFromDocument);
  const refreshFromMathSettings = () => {
    if (!editing) renderDisplay();
  };
  window.addEventListener("lightmark:math-settings-changed", refreshFromMathSettings);
  const refreshFromMathTools = () => {
    editorMathEvaluationCache.delete(editor.view.state.doc);
    if (!editing) renderDisplay();
  };
  window.addEventListener("lightmark:refresh-math", refreshFromMathTools);

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "blockMath") return false;
      const nextEditing = Boolean(nextNode.attrs.editing) || !nextNode.attrs.tex;
      tex = nextNode.attrs.tex || "";
      delimiter = nextNode.attrs.delimiter || "display-dollar";
      raw = nextNode.attrs.raw || "";
      originalTex = nextNode.attrs.originalTex ?? tex;
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
    destroy() {
      suggest?.destroy();
      editor.off?.("transaction", refreshFromDocument);
      window.removeEventListener("lightmark:math-settings-changed", refreshFromMathSettings);
      window.removeEventListener("lightmark:refresh-math", refreshFromMathTools);
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof HTMLElement && Boolean(event.target.closest(".math-block-editor,.math-suggest,.math-tools")),
  };
}

function appendMathTools(
  host: HTMLElement,
  rendered: HTMLElement,
  source: { tex: string; delimiter: MathDelimiter; raw: string; displayMode: boolean },
  refresh: () => void,
) {
  const tools = document.createElement("span");
  tools.className = "math-tools";
  tools.setAttribute("role", "toolbar");
  tools.setAttribute("aria-label", "公式工具");

  const valid = !rendered.classList.contains("math-render-error");
  const sourceText = serializeMathToken(
    { tex: source.tex, delimiter: source.delimiter, raw: source.raw },
    source.tex,
    Boolean(source.raw),
  );
  const actions = [
    {
      label: "复制公式源码",
      icon: Copy,
      disabled: false,
      run: () => copyMathText(sourceText, "已复制公式源码"),
    },
    {
      label: valid ? "复制 KaTeX HTML" : "公式有错误，无法复制 HTML",
      icon: CodeXml,
      disabled: !valid,
      run: () => copyMathText(rendered.innerHTML, "已复制公式 HTML"),
    },
    {
      label: valid ? "复制 MathML" : "公式有错误，无法复制 MathML",
      icon: Sigma,
      disabled: !valid,
      run: () => {
        const math = rendered.querySelector<HTMLElement>(".katex-mathml math");
        return copyMathText(math?.outerHTML ?? "", "已复制公式 MathML");
      },
    },
    {
      label: "刷新当前文档全部公式",
      icon: RefreshCw,
      disabled: false,
      run: () => {
        refresh();
        appStore.statusMessage = "已刷新当前文档全部公式";
      },
    },
  ];

  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "math-tool-button";
    const iconHost = document.createElement("span");
    iconHost.className = "math-tool-icon";
    iconHost.setAttribute("aria-hidden", "true");
    render(createVNode(action.icon as Component, {
      size: 15,
      strokeWidth: 1.75,
      "aria-hidden": "true",
      focusable: "false",
    }), iconHost);
    button.appendChild(iconHost);
    button.title = action.label;
    button.setAttribute("aria-label", action.label);
    button.disabled = action.disabled;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void action.run();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      (event.currentTarget as HTMLButtonElement).blur();
      host.focus();
    });
    tools.appendChild(button);
  }
  host.appendChild(tools);
}

async function copyMathText(text: string, message: string) {
  if (!text) return;
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
  appStore.statusMessage = message;
}

function deleteMathNode(editor: any, getPos: NodeViewPosition) {
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

function renderKatex(
  target: HTMLElement,
  tex: string,
  displayMode: boolean,
  emptyText = tex,
  source: {
    delimiter?: MathDelimiter;
    raw?: string;
    evaluation?: MathEvaluationEntry | null;
  } = {},
) {
  target.innerHTML = "";
  target.classList.remove("math-render-error");
  target.classList.remove("math-macro-definition");
  target.removeAttribute("title");
  target.removeAttribute("id");
  target.removeAttribute("data-equation-labels");
  if (!tex.trim()) {
    target.textContent = emptyText;
    target.classList.add("math-live-preview-empty");
    return null;
  }
  target.classList.remove("math-live-preview-empty");

  const token = mathTokenFromParts({
    tex,
    delimiter: source.delimiter,
    raw: source.raw,
    displayMode,
  });
  const evaluation = source.evaluation ?? evaluateMathTokens([token]).entries[0];
  const rendered = evaluation.result;
  if (rendered.ok) {
    if (evaluation.definitionOnly) {
      target.classList.add("math-macro-definition");
      const label = document.createElement("span");
      label.className = "math-macro-definition-label";
      label.textContent = "宏定义";
      const names = document.createElement("code");
      names.className = "math-macro-definition-names";
      names.textContent = evaluation.definedMacroNames.join("、");
      target.append(label, names);
      return null;
    }
    target.innerHTML = rendered.html;
    if (evaluation.equationTarget) {
      target.id = evaluation.equationTarget.id;
      target.classList.add("math-equation-target");
      target.dataset.equationLabels = evaluation.equationTarget.labels.join(" ");
      target.setAttribute(
        "aria-label",
        `公式 ${evaluation.equationTarget.display}${evaluation.equationTarget.labels.length ? `，标签 ${evaluation.equationTarget.labels.join("、")}` : ""}`,
      );
    } else {
      target.classList.remove("math-equation-target");
      target.removeAttribute("aria-label");
    }
    return null;
  }
  target.classList.add("math-render-error");
  target.title = rendered.error.message;
  const label = document.createElement("span");
  label.className = "math-render-error-label";
  label.textContent = "公式错误 · 点击编辑";
  const detail = document.createElement("span");
  detail.className = "math-render-error-detail";
  detail.textContent = rendered.error.message;
  const code = document.createElement("code");
  code.className = "math-render-error-source";
  code.textContent = tex;
  target.append(label, detail, code);
  return rendered.error;
}

function documentMacroSuggestions(names: string[]): LatexSuggestion[] {
  return names.map((name) => ({
    command: name,
    label: "当前文档定义",
    template: name,
    category: "文档宏",
  }));
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
