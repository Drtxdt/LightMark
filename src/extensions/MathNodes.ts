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
import { DOCUMENT_FLUSH_META_KEY } from "../editor/documentMutationTracker";
import type {
  RecoveryMathContent,
  RecoveryPendingMath,
  RecoveryPendingMathEntry,
} from "../editor/recoveryCodec";

type MathAttrs = {
  tex: string;
  editing?: boolean;
  delimiter?: MathDelimiter;
  raw?: string;
  originalTex?: string;
  displayMode?: boolean;
};

function findInlineMathMatch(text: string) {
  return parseInlineMathText(text)
    .find((token) => !isWholeTextBlockMathDelimiter(text, token.from, token.to))
    ?? null;
}

type InlineMathTextRun = {
  text: string;
  pmFrom: number;
};

type InlineMathReplacement = {
  match: MarkdownMathToken;
  from: number;
  to: number;
};

function findInlineMathMatchInTextblock(node: any): InlineMathReplacement | null {
  const runs: InlineMathTextRun[] = [];
  let run: InlineMathTextRun | null = null;

  node.forEach((child: any, offset: number) => {
    if (!child.isText || child.marks.some((mark: any) => mark.type.name === "code")) {
      if (run) runs.push(run);
      run = null;
      return;
    }

    run ??= { text: "", pmFrom: offset };
    run.text += child.text;
  });
  if (run) runs.push(run);

  for (const textRun of runs) {
    const match = findInlineMathMatch(textRun.text);
    if (!match?.tex.trim()) continue;
    return {
      match,
      from: textRun.pmFrom + match.from,
      to: textRun.pmFrom + match.to,
    };
  }
  return null;
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
          const $head = newState.selection.$head;
          if (!$head.parent.isTextblock || $head.parent.type.name === "codeBlock") return null;
          const node = $head.parent;
          const pos = $head.before();
          let tr = newState.tr;
          const replacement = findInlineMathMatchInTextblock(node);
          if (!replacement) return null;
          const { match } = replacement;
          const from = pos + 1 + replacement.from;
          const to = pos + 1 + replacement.to;
          tr = tr.replaceWith(from, to, this.type.create({
            tex: match.tex,
            editing: true,
            delimiter: match.delimiter,
            raw: match.raw,
            originalTex: match.tex,
            displayMode: match.displayMode,
          }));
          return tr.setSelection(NodeSelection.create(tr.doc, from));
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createInlineMathView(node, editor, getPos);
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
            if (isMathCompositionKey(event)) return false;

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
    return ({ node, editor, getPos }) => createBlockMathView(node, editor, getPos);
  },
});

type NodeViewPosition = (() => number | undefined) | boolean;

export type MathContentAttrs = {
  tex: string;
  delimiter: MathDelimiter;
  raw: string;
  originalTex: string;
  displayMode: boolean;
};

function readMathContentAttrs(attrs: Partial<MathAttrs>): MathContentAttrs {
  const tex = attrs.tex || "";
  return {
    tex,
    delimiter: attrs.delimiter || "inline-dollar",
    raw: attrs.raw || "",
    originalTex: attrs.originalTex ?? tex,
    displayMode: Boolean(attrs.displayMode),
  };
}

function sameMathContentAttrs(left: MathContentAttrs, right: MathContentAttrs) {
  return left.tex === right.tex
    && left.delimiter === right.delimiter
    && left.raw === right.raw
    && left.originalTex === right.originalTex
    && left.displayMode === right.displayMode;
}

export type MathContentUpdateDecision =
  | "preserve-local"
  | "ack-local"
  | "accept-incoming"
  | "conflict";

export function resolveMathContentUpdate(input: {
  editing: boolean;
  local: MathContentAttrs;
  accepted: MathContentAttrs;
  incoming: MathContentAttrs;
}): MathContentUpdateDecision {
  const localChanged = !sameMathContentAttrs(input.local, input.accepted);
  const incomingChanged = !sameMathContentAttrs(input.incoming, input.accepted);
  if (!input.editing) return "accept-incoming";
  if (!incomingChanged) return "preserve-local";
  if (sameMathContentAttrs(input.incoming, input.local)) return "ack-local";
  if (!localChanged) return "accept-incoming";
  return "conflict";
}

export type MathBlurDecision = "defer-composition" | "commit" | "keep-editing" | "wait-source";

export function resolveMathBlurDecision(input: {
  composing: boolean;
  blurPending: boolean;
  sourceConnected: boolean;
  activeInside: boolean;
}): MathBlurDecision {
  if (!input.blurPending) return "keep-editing";
  if (input.composing) return "defer-composition";
  if (!input.sourceConnected) return "wait-source";
  if (input.activeInside) return "keep-editing";
  return "commit";
}

function isMathCompositionKey(event: KeyboardEvent) {
  return event.isComposing || event.key === "Process" || event.keyCode === 229;
}

export class MathEditConflictError extends Error {
  constructor(message = "公式编辑内容与文档更新冲突") {
    super(message);
    this.name = "MathEditConflictError";
  }
}

export class MathClosePromptBlockedError extends Error {
  constructor(message = "公式输入法组合尚未结束，已保留当前窗口。") {
    super(message);
    this.name = "MathClosePromptBlockedError";
  }
}

type PendingMathEdit = {
  flush: (request?: MathFlushRequest) => Promise<void>;
  finalizeClosePrompt: (request?: MathFlushRequest) => Promise<void>;
  hasPending: () => boolean;
  captureRecovery: () => RecoveryPendingMathEntry | null;
};

export type MathFlushRequest = Readonly<{
  flushId: string;
}>;

type PendingMathEditRegistry = {
  edits: Set<PendingMathEdit>;
  version: number;
  inputVersion: number;
};

const pendingMathEdits = new WeakMap<object, PendingMathEditRegistry>();
let nextMathRecoveryEntryId = 0;

function createMathRecoveryEntryId(kind: "inline" | "block") {
  nextMathRecoveryEntryId += 1;
  return `${kind}-math-${nextMathRecoveryEntryId}`;
}

function readNodeViewPosition(getPos: NodeViewPosition) {
  if (typeof getPos !== "function") return null;
  try {
    const position = getPos();
    return Number.isSafeInteger(position) && (position as number) >= 0
      ? position as number
      : null;
  } catch {
    return null;
  }
}

function recoveryMathState(input: {
  editing: boolean;
  composing: boolean;
  blurPending: boolean;
  conflict: boolean;
  local: MathContentAttrs;
  accepted: MathContentAttrs;
}): RecoveryPendingMathEntry["state"] | null {
  if (input.conflict) return "conflict";
  if (input.composing) return "composing";
  if (input.blurPending) return "blurPending";
  if (input.editing || !sameMathContentAttrs(input.local, input.accepted)) return "editing";
  return null;
}

function recoveryContent(attrs: MathContentAttrs): RecoveryMathContent {
  return {
    tex: attrs.tex,
    delimiter: attrs.delimiter,
    raw: attrs.raw,
    originalTex: attrs.originalTex,
    displayMode: attrs.displayMode,
  };
}

function currentMathNodeContent(node: any, kind: "inline" | "block") {
  if (!node?.attrs) return null;
  const attrs = kind === "block"
    ? { ...node.attrs, delimiter: node.attrs.delimiter || "display-dollar", displayMode: true }
    : node.attrs;
  return readMathContentAttrs(attrs);
}

function readEditorDocument(editor: any) {
  try {
    return editor?.view?.state?.doc ?? null;
  } catch {
    return null;
  }
}

function captureMathRecoveryEntry(input: {
  id: string;
  kind: "inline" | "block";
  editor: any;
  getPos: NodeViewPosition;
  accepted: MathContentAttrs;
  local: MathContentAttrs;
  editing: boolean;
  composing: boolean;
  blurPending: boolean;
  conflict: MathEditConflictError | null;
  destroyed: boolean;
  lastKnownPosition: number | null;
}): RecoveryPendingMathEntry | null {
  const state = recoveryMathState({
    editing: input.editing,
    composing: input.composing,
    blurPending: input.blurPending,
    conflict: Boolean(input.conflict),
    local: input.local,
    accepted: input.accepted,
  });
  if (!state) return null;

  const currentPosition = readNodeViewPosition(input.getPos);
  const position = currentPosition ?? input.lastKnownPosition;
  const doc = readEditorDocument(input.editor);
  let currentNode = null;
  if (currentPosition !== null && doc?.nodeAt) {
    const documentSize = typeof doc.content?.size === "number" ? doc.content.size : -1;
    if (currentPosition <= documentSize) {
      try {
        currentNode = doc.nodeAt(currentPosition);
      } catch {
        currentNode = null;
      }
    }
  }
  const expectedType = input.kind === "inline" ? "inlineMath" : "blockMath";
  let binding: RecoveryPendingMathEntry["binding"];
  if (input.destroyed || currentPosition === null || !doc?.nodeAt || !currentNode) {
    const reason = input.destroyed
      ? "node-view-destroyed"
      : currentPosition === null
        ? "node-view-position-unavailable"
        : !doc?.nodeAt
          ? "editor-document-unavailable"
          : "document-node-unavailable";
    binding = {
      status: "orphaned",
      position,
      kind: input.kind,
      reason,
    };
  } else {
    const currentContent = currentMathNodeContent(currentNode, input.kind);
    if (
      input.conflict
      || currentNode.type?.name !== expectedType
      || !currentContent
      || !sameMathContentAttrs(currentContent, input.accepted)
    ) {
      binding = {
        status: "conflicted",
        position: currentPosition,
        kind: input.kind,
        reason: input.conflict ? "node-view-edit-conflict" : "document-node-changed",
      };
    } else {
      binding = { status: "linked", position: currentPosition, kind: input.kind };
    }
  }
  return {
    id: input.id,
    binding,
    accepted: recoveryContent(input.accepted),
    local: recoveryContent(input.local),
    state,
  };
}

function registerPendingMathEdit(editor: object, edit: PendingMathEdit) {
  let registry = pendingMathEdits.get(editor);
  if (!registry) {
    registry = { edits: new Set(), version: 0, inputVersion: 0 };
    pendingMathEdits.set(editor, registry);
  }
  registry.edits.add(edit);
  registry.version += 1;
  let active = true;
  const markChanged = () => {
    if (active) registry!.version += 1;
  };
  const markInputChanged = () => {
    if (!active) return;
    registry!.version += 1;
    registry!.inputVersion += 1;
  };
  const unregister = () => {
    if (!active) return;
    active = false;
    registry!.edits.delete(edit);
    registry!.version += 1;
  };
  return { unregister, markChanged, markInputChanged };
}

export async function flushPendingMathEdits(editor: object, request?: MathFlushRequest) {
  const edits = pendingMathEdits.get(editor)?.edits;
  if (!edits?.size) return;
  await Promise.all([...edits].map((edit) => edit.flush(request)));
}

/**
 * Finalize the transient formula UI before a window-close prompt is shown.
 * This is deliberately separate from the ordinary save flush: moving focus
 * to a native dialog must not be allowed to mutate a still-open NodeView after
 * the close authorization has been captured.
 */
export async function finalizePendingMathForClosePrompt(
  editor: object,
  request?: MathFlushRequest,
) {
  const edits = pendingMathEdits.get(editor)?.edits;
  if (!edits?.size) return;
  for (const edit of [...edits]) await edit.finalizeClosePrompt(request);
}

export function hasPendingMathEdits(editor: object) {
  return [...(pendingMathEdits.get(editor)?.edits ?? [])].some((edit) => edit.hasPending());
}

export function getPendingMathEditVersion(editor: object) {
  return pendingMathEdits.get(editor)?.version ?? 0;
}

export function getPendingMathInputVersion(editor: object) {
  return pendingMathEdits.get(editor)?.inputVersion ?? 0;
}

/**
 * Capture pending math buffers without changing the editor or its registry.
 * This is intentionally a data-only boundary; WYS/source selection and other
 * local buffers are added by the future recovery local-state layer.
 */
export function capturePendingMathRecovery(editor: object): RecoveryPendingMath {
  const registry = pendingMathEdits.get(editor);
  if (!registry) return { version: 0, entries: [] };
  const entries: RecoveryPendingMathEntry[] = [];
  for (const edit of registry.edits) {
    const entry = edit.captureRecovery();
    if (entry) entries.push(entry);
  }
  return { version: registry.version, entries };
}

type EditorMathEvaluation = {
  entriesByPos: Map<number, MathEvaluationEntry>;
  numberingMode: typeof appStore.settings.markdown.mathNumbering;
};

const editorMathEvaluationCache = new WeakMap<object, EditorMathEvaluation>();
const visibleMathCallbacks = new WeakMap<Element, () => void>();
const mathRefreshCallbacks = new Set<(kind: "settings" | "tools") => void>();
let mathVisibilityObserver: IntersectionObserver | null = null;
let mathGlobalListenersInstalled = false;

function observeMathVisibility(element: Element, callback: () => void) {
  if (typeof IntersectionObserver === "undefined") {
    callback();
    return () => {};
  }
  mathVisibilityObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const callback = visibleMathCallbacks.get(entry.target);
      if (!callback) continue;
      visibleMathCallbacks.delete(entry.target);
      mathVisibilityObserver?.unobserve(entry.target);
      callback();
    }
  }, { rootMargin: "300px 0px" });
  visibleMathCallbacks.set(element, callback);
  mathVisibilityObserver.observe(element);
  return () => {
    visibleMathCallbacks.delete(element);
    mathVisibilityObserver?.unobserve(element);
  };
}

function subscribeMathRefresh(callback: (kind: "settings" | "tools") => void) {
  if (!mathGlobalListenersInstalled) {
    window.addEventListener("lightmark:math-settings-changed", () => {
      for (const listener of mathRefreshCallbacks) listener("settings");
    });
    window.addEventListener("lightmark:refresh-math", () => {
      for (const listener of mathRefreshCallbacks) listener("tools");
    });
    mathGlobalListenersInstalled = true;
  }
  mathRefreshCallbacks.add(callback);
  return () => mathRefreshCallbacks.delete(callback);
}

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

function createInlineMathView(node: any, editor: any, getPos: NodeViewPosition) {
  const attrs = node.attrs as MathAttrs;
  const dom = document.createElement("span");
  dom.className = "math-node math-node-inline";
  dom.contentEditable = "false";

  let tex = attrs.tex || "";
  let delimiter = attrs.delimiter || "inline-dollar";
  let raw = attrs.raw || "";
  let originalTex = attrs.originalTex ?? tex;
  let displayMode = Boolean(attrs.displayMode);
  let editing = Boolean(attrs.editing);
  let displayRendered = false;
  let suggest: LatexSuggestController | null = null;
  let composing = false;
  let blurPending = false;
  let closePromptFinalized = false;
  let destroyed = false;
  let acceptedNode = node;
  let acceptedAttrs = readMathContentAttrs(attrs);
  let editConflict: MathEditConflictError | null = null;
  const recoveryEntryId = createMathRecoveryEntryId("inline");
  let lastKnownPosition: number | null = readNodeViewPosition(getPos);
  let markPendingEditChanged: () => void = () => {};
  let markPendingInputChanged: () => void = () => {};
  const compositionWaiters = new Set<{
    resolve: () => void;
    reject: (reason?: unknown) => void;
  }>();

  const localContentAttrs = (): MathContentAttrs => ({
    tex,
    delimiter,
    raw,
    originalTex,
    displayMode,
  });

  const acceptNode = (nextNode: any) => {
    const nextAttrs = nextNode.attrs as MathAttrs;
    acceptedNode = nextNode;
    acceptedAttrs = readMathContentAttrs(nextAttrs);
    tex = acceptedAttrs.tex;
    delimiter = acceptedAttrs.delimiter;
    raw = acceptedAttrs.raw;
    originalTex = acceptedAttrs.originalTex;
    displayMode = acceptedAttrs.displayMode;
    if (editConflict) {
      editConflict = null;
      markPendingEditChanged();
    }
    markPendingEditChanged();
  };

  const setEditConflict = (error: MathEditConflictError) => {
    if (!editConflict) {
      editConflict = error;
      markPendingEditChanged();
    }
    return editConflict;
  };

  const waitForCompositionEnd = () => new Promise<void>((resolve, reject) => {
    compositionWaiters.add({ resolve, reject });
  });

  const resolveCompositionWaiters = () => {
    const waiters = [...compositionWaiters];
    compositionWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  };

  const rejectCompositionWaiters = (reason: unknown) => {
    const waiters = [...compositionWaiters];
    compositionWaiters.clear();
    for (const waiter of waiters) waiter.reject(reason);
  };

  const updateAttrs = (next: Partial<MathAttrs>, flushRequest?: MathFlushRequest) => {
    if (destroyed) {
      setEditConflict(new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入"));
      return false;
    }
    if (editConflict) return false;
    if (typeof getPos !== "function") {
      setEditConflict(new MathEditConflictError("公式位置已失效，无法确认未提交内容已写入"));
      return false;
    }
    const pos = getPos();
    if (typeof pos !== "number") {
      setEditConflict(new MathEditConflictError("公式位置已失效，无法确认未提交内容已写入"));
      return false;
    }
    const currentNode = editor.view.state.doc.nodeAt(pos);
    if (!currentNode || currentNode.type !== acceptedNode.type || currentNode !== acceptedNode) {
      setEditConflict(new MathEditConflictError("公式节点已被文档更新，无法确认未提交内容已写入"));
      return false;
    }
    const nextAttrs = {
      tex,
      delimiter,
      raw,
      originalTex,
      displayMode,
      editing: false,
      ...next,
    };
    if (Object.entries(nextAttrs).every(([key, value]) => currentNode.attrs[key] === value)) return true;
    const transaction = editor.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs);
    if (flushRequest) transaction.setMeta(DOCUMENT_FLUSH_META_KEY, flushRequest.flushId);
    editor.view.dispatch(transaction);
    return true;
  };

  const exitToDocument = (side: "before" | "after") => {
    if (editing) markPendingEditChanged();
    editing = false;
    raw = tex === originalTex ? raw : "";
    if (!updateAttrs({ tex, raw, editing: false })) {
      editing = true;
      return;
    }
    renderDisplay();
    setInlineSelection(editor, getPos, side);
  };

  const pendingEdit: PendingMathEdit = {
    hasPending: () => composing || blurPending || Boolean(editConflict) || !sameMathContentAttrs(localContentAttrs(), acceptedAttrs),
    captureRecovery: () => captureMathRecoveryEntry({
      id: recoveryEntryId,
      kind: "inline",
      editor,
      getPos,
      accepted: acceptedAttrs,
      local: localContentAttrs(),
      editing,
      composing,
      blurPending,
      conflict: editConflict,
      destroyed,
      lastKnownPosition,
    }),
    async flush(flushRequest) {
      if (destroyed) throw new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入");
      if (editConflict) throw editConflict;
      if (composing) await waitForCompositionEnd();
      if (destroyed) throw new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入");
      if (editConflict) throw editConflict;
      if (!editing) return;
      raw = tex === originalTex ? raw : "";
      const wasBlurPending = blurPending;
      if (wasBlurPending) markPendingEditChanged();
      blurPending = false;
      if (!updateAttrs({ tex, raw, editing: false }, flushRequest)) {
        if (!blurPending) markPendingEditChanged();
        blurPending = wasBlurPending;
        throw editConflict ?? new MathEditConflictError();
      }
    },
    async finalizeClosePrompt(flushRequest) {
      if (destroyed) throw new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入");
      if (editConflict) throw editConflict;
      if (composing) throw new MathClosePromptBlockedError();

      const wasEditing = editing;
      const wasBlurPending = blurPending;
      const source = dom.querySelector(".math-inline-source-editor");
      const needsClose = wasEditing || wasBlurPending || Boolean(source);
      const needsCommit = needsClose || !sameMathContentAttrs(localContentAttrs(), acceptedAttrs);
      if (!needsCommit) return;

      const previousRaw = raw;
      const previousClosePromptFinalized = closePromptFinalized;
      closePromptFinalized = true;
      if (needsClose) markPendingEditChanged();
      raw = tex === originalTex ? raw : "";
      blurPending = false;
      editing = false;
      if (!updateAttrs({ tex, raw, editing: false }, flushRequest)) {
        raw = previousRaw;
        editing = wasEditing;
        blurPending = wasBlurPending;
        closePromptFinalized = previousClosePromptFinalized;
        throw editConflict ?? new MathEditConflictError();
      }
      if (needsClose) renderDisplay();
    },
  };
  const pendingRegistration = registerPendingMathEdit(editor, pendingEdit);
  const unregisterPendingEdit = pendingRegistration.unregister;
  markPendingEditChanged = pendingRegistration.markChanged;
  markPendingInputChanged = pendingRegistration.markInputChanged;

  const renderDisplay = () => {
    if (blurPending) markPendingEditChanged();
    blurPending = false;
    displayRendered = true;
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
  };

  const renderPlaceholder = () => {
    if (blurPending) markPendingEditChanged();
    blurPending = false;
    dom.className = "math-node math-node-inline math-node-pending";
    dom.textContent = tex;
  };

  const commitAfterBlur = (source: HTMLElement) => {
    if (closePromptFinalized) return;
    const activeElement = document.activeElement;
    const decision = resolveMathBlurDecision({
      composing,
      blurPending,
      sourceConnected: source.isConnected,
      activeInside: activeElement === source || dom.contains(activeElement),
    });
    if (destroyed || decision === "defer-composition" || decision === "wait-source") return;
    if (decision === "keep-editing") {
      if (blurPending) markPendingEditChanged();
      blurPending = false;
      return;
    }
    if (blurPending) markPendingEditChanged();
    blurPending = false;
    if (!editing) return;
    markPendingEditChanged();
    editing = false;
    raw = tex === originalTex ? raw : "";
    if (!updateAttrs({ tex, raw, editing: false })) {
      markPendingEditChanged();
      editing = true;
      if (!blurPending) markPendingEditChanged();
      blurPending = true;
      return;
    }
    renderDisplay();
  };

  const renderEditor = (initialCaret: "start" | "end" = "end") => {
    closePromptFinalized = false;
    if (blurPending) markPendingEditChanged();
    blurPending = false;
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

    const installEditingTools = () => {
      dom.querySelector(":scope > .math-tools-inline-editing")?.remove();
      appendMathTools(dom, body, { tex, delimiter, raw: "", displayMode }, () => {
        editorMathEvaluationCache.delete(editor.view.state.doc);
        window.dispatchEvent(new CustomEvent("lightmark:refresh-math"));
        renderKatex(body, tex, displayMode, "公式预览", {
          delimiter,
          raw: "",
          evaluation: evaluateEditorMathAt(editor, getPos, tex, delimiter, displayMode),
        });
        installEditingTools();
      }, "math-tools-inline-editing");
    };

    const refresh = () => {
      if (destroyed) return;
      const nextTex = source.textContent || "";
      if (nextTex !== tex) {
        tex = nextTex;
        markPendingEditChanged();
        markPendingInputChanged();
      }
      renderKatex(body, tex, displayMode, "公式预览", {
        delimiter,
        raw: "",
        evaluation: evaluateEditorMathAt(editor, getPos, tex, delimiter, displayMode),
      });
      installEditingTools();
      if (!composing) suggest?.sync();
    };

    suggest = createLatexSuggestController({
      host: dom,
      anchor: source,
      getValue: () => source.textContent || "",
      setValue: (value) => {
        if (source.textContent !== value) {
          markPendingEditChanged();
          markPendingInputChanged();
        }
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
    source.addEventListener("compositionstart", () => {
      if (!composing) markPendingEditChanged();
      composing = true;
      suggest?.close();
    });
    source.addEventListener("compositionend", () => {
      if (destroyed) return;
      if (composing) markPendingEditChanged();
      composing = false;
      refresh();
      resolveCompositionWaiters();
      if (blurPending) window.setTimeout(() => commitAfterBlur(source), 0);
    });
    source.addEventListener("keydown", (event) => {
      if (composing || isMathCompositionKey(event)) return;
      if (event.key === "End" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setContentEditableCaret(source, source.textContent?.length ?? 0, event.shiftKey);
        return;
      }
      if (event.key === "Home" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setContentEditableCaret(source, 0, event.shiftKey);
        return;
      }
      if (suggest?.handleKeyDown(event)) return;
      if (event.key === "Backspace" && !tex.trim() && isCaretAtStart(source)) {
        event.preventDefault();
        deleteMathNode(editor, getPos);
        return;
      }
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        exitToDocument("after");
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
      if (closePromptFinalized) return;
      if (!blurPending) markPendingEditChanged();
      blurPending = true;
      window.setTimeout(() => suggest?.close(), 120);
      window.setTimeout(() => {
        if (destroyed) return;
        commitAfterBlur(source);
      }, 0);
    });

    dom.append(source, preview);
    const evaluation = evaluateEditorMathAt(editor, getPos, tex, delimiter, displayMode);
    renderKatex(body, tex, displayMode, "公式预览", { delimiter, raw: "", evaluation });
    installEditingTools();
    const diagnostic = evaluation?.diagnostic ?? null;
    source.focus();
    setContentEditableCaret(source, initialCaret === "start" ? 0 : diagnostic?.texOffset ?? tex.length);
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
    const bounds = dom.getBoundingClientRect();
    const initialCaret = event.clientX <= bounds.left + bounds.width / 2 ? "start" : "end";
    markPendingEditChanged();
    editing = true;
    renderEditor(initialCaret);
  });

  editing ? renderEditor() : renderPlaceholder();
  const stopVisibility = observeMathVisibility(dom, () => {
    if (!editing) renderDisplay();
  });
  const stopRefresh = subscribeMathRefresh((kind) => {
    if (kind === "tools") editorMathEvaluationCache.delete(editor.view.state.doc);
    if (!editing && displayRendered) renderDisplay();
  });

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "inlineMath") return false;
      const nextEditing = Boolean(nextNode.attrs.editing);
      const incomingAttrs = readMathContentAttrs(nextNode.attrs as MathAttrs);
      const localAttrs = localContentAttrs();
      const decision = resolveMathContentUpdate({
        editing: editing && Boolean(dom.querySelector(".math-inline-source-editor")),
        local: localAttrs,
        accepted: acceptedAttrs,
        incoming: incomingAttrs,
      });
      if (decision === "preserve-local") {
        markPendingEditChanged();
        acceptedNode = nextNode;
        return true;
      }
      if (decision === "ack-local") {
        acceptNode(nextNode);
        return true;
      }
      if (decision === "conflict") {
        setEditConflict(new MathEditConflictError("公式编辑内容与文档更新冲突"));
        return true;
      }
      if (decision === "accept-incoming") {
        acceptNode(nextNode);
      }
      if (editing !== nextEditing) markPendingEditChanged();
      editing = nextEditing;
      editing ? renderEditor() : displayRendered ? renderDisplay() : renderPlaceholder();
      return true;
    },
    selectNode() {
      if (editing) return;
      closePromptFinalized = false;
      markPendingEditChanged();
      editing = true;
      renderEditor();
    },
    deselectNode() {
      if (!editing) return;
      if (composing) {
        if (!blurPending) markPendingEditChanged();
        blurPending = true;
        return;
      }
      markPendingEditChanged();
      editing = false;
      if (!updateAttrs({ editing: false })) {
        markPendingEditChanged();
        editing = true;
        return;
      }
      renderDisplay();
    },
    destroy() {
      const hadPending = pendingEdit.hasPending();
      const position = readNodeViewPosition(getPos);
      if (position !== null) lastKnownPosition = position;
      destroyed = true;
      suggest?.destroy();
      if (hadPending) {
        setEditConflict(new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入"));
      } else {
        unregisterPendingEdit();
      }
      rejectCompositionWaiters(editConflict ?? new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入"));
      stopVisibility();
      stopRefresh();
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof HTMLElement && Boolean(event.target.closest(".math-inline-source-editor,.math-suggest,.math-tools")),
  };
}

function createBlockMathView(node: any, editor: any, getPos: NodeViewPosition) {
  const attrs = node.attrs as MathAttrs;
  const dom = document.createElement("section");
  dom.className = "math-node math-node-block";
  dom.contentEditable = "false";

  let tex = attrs.tex || "";
  let delimiter = attrs.delimiter || "display-dollar";
  let raw = attrs.raw || "";
  let originalTex = attrs.originalTex ?? tex;
  let editing = attrs.editing || !tex;
  let displayRendered = false;
  let suggest: LatexSuggestController | null = null;
  let composing = false;
  let blurPending = false;
  let closePromptFinalized = false;
  let destroyed = false;
  let acceptedNode = node;
  let acceptedAttrs = readMathContentAttrs({ ...attrs, delimiter: attrs.delimiter || "display-dollar", displayMode: true });
  let editConflict: MathEditConflictError | null = null;
  const recoveryEntryId = createMathRecoveryEntryId("block");
  let lastKnownPosition: number | null = readNodeViewPosition(getPos);
  let markPendingEditChanged: () => void = () => {};
  let markPendingInputChanged: () => void = () => {};
  const compositionWaiters = new Set<{
    resolve: () => void;
    reject: (reason?: unknown) => void;
  }>();

  const localContentAttrs = (): MathContentAttrs => ({
    tex,
    delimiter,
    raw,
    originalTex,
    displayMode: true,
  });

  const acceptNode = (nextNode: any) => {
    const nextAttrs = nextNode.attrs as MathAttrs;
    acceptedNode = nextNode;
    acceptedAttrs = readMathContentAttrs({ ...nextAttrs, delimiter: nextAttrs.delimiter || "display-dollar", displayMode: true });
    tex = acceptedAttrs.tex;
    delimiter = acceptedAttrs.delimiter;
    raw = acceptedAttrs.raw;
    originalTex = acceptedAttrs.originalTex;
    if (editConflict) {
      editConflict = null;
      markPendingEditChanged();
    }
    markPendingEditChanged();
  };

  const setEditConflict = (error: MathEditConflictError) => {
    if (!editConflict) {
      editConflict = error;
      markPendingEditChanged();
    }
    return editConflict;
  };

  const waitForCompositionEnd = () => new Promise<void>((resolve, reject) => {
    compositionWaiters.add({ resolve, reject });
  });

  const resolveCompositionWaiters = () => {
    const waiters = [...compositionWaiters];
    compositionWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  };

  const rejectCompositionWaiters = (reason: unknown) => {
    const waiters = [...compositionWaiters];
    compositionWaiters.clear();
    for (const waiter of waiters) waiter.reject(reason);
  };

  const updateAttrs = (next: Partial<MathAttrs>, flushRequest?: MathFlushRequest) => {
    if (destroyed) {
      setEditConflict(new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入"));
      return false;
    }
    if (editConflict) return false;
    if (typeof getPos !== "function") {
      setEditConflict(new MathEditConflictError("公式位置已失效，无法确认未提交内容已写入"));
      return false;
    }
    const pos = getPos();
    if (typeof pos !== "number") {
      setEditConflict(new MathEditConflictError("公式位置已失效，无法确认未提交内容已写入"));
      return false;
    }
    const currentNode = editor.view.state.doc.nodeAt(pos);
    if (!currentNode || currentNode.type !== acceptedNode.type || currentNode !== acceptedNode) {
      setEditConflict(new MathEditConflictError("公式节点已被文档更新，无法确认未提交内容已写入"));
      return false;
    }
    const nextAttrs = {
      tex,
      delimiter,
      raw,
      originalTex,
      displayMode: true,
      editing: false,
      ...next,
    };
    if (Object.entries(nextAttrs).every(([key, value]) => currentNode.attrs[key] === value)) return true;
    const transaction = editor.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs);
    if (flushRequest) transaction.setMeta(DOCUMENT_FLUSH_META_KEY, flushRequest.flushId);
    editor.view.dispatch(transaction);
    return true;
  };

  const exitToNextParagraph = () => {
    if (editing) markPendingEditChanged();
    editing = false;
    raw = tex === originalTex ? raw : "";
    if (!updateAttrs({ tex, raw, editing: false })) {
      markPendingEditChanged();
      editing = true;
      return;
    }
    if (tex.trim()) renderDisplay();
    setBlockSelectionAfter(editor, getPos);
  };

  const exitToPreviousParagraph = () => {
    if (editing) markPendingEditChanged();
    editing = false;
    raw = tex === originalTex ? raw : "";
    if (!updateAttrs({ tex, raw, editing: false })) {
      editing = true;
      return;
    }
    if (tex.trim()) renderDisplay();
    setBlockSelectionBefore(editor, getPos);
  };

  const pendingEdit: PendingMathEdit = {
    hasPending: () => composing || blurPending || Boolean(editConflict) || !sameMathContentAttrs(localContentAttrs(), acceptedAttrs),
    captureRecovery: () => captureMathRecoveryEntry({
      id: recoveryEntryId,
      kind: "block",
      editor,
      getPos,
      accepted: acceptedAttrs,
      local: localContentAttrs(),
      editing,
      composing,
      blurPending,
      conflict: editConflict,
      destroyed,
      lastKnownPosition,
    }),
    async flush(flushRequest) {
      if (destroyed) throw new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入");
      if (editConflict) throw editConflict;
      if (composing) await waitForCompositionEnd();
      if (destroyed) throw new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入");
      if (editConflict) throw editConflict;
      if (!editing) return;
      raw = tex === originalTex ? raw : "";
      const wasBlurPending = blurPending;
      if (wasBlurPending) markPendingEditChanged();
      blurPending = false;
      if (!updateAttrs({ tex, raw, editing: false }, flushRequest)) {
        if (!blurPending) markPendingEditChanged();
        blurPending = wasBlurPending;
        throw editConflict ?? new MathEditConflictError();
      }
    },
    async finalizeClosePrompt(flushRequest) {
      if (destroyed) throw new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入");
      if (editConflict) throw editConflict;
      if (composing) throw new MathClosePromptBlockedError();

      const wasEditing = editing;
      const wasBlurPending = blurPending;
      const source = dom.querySelector(".math-block-editor");
      const needsClose = wasEditing || wasBlurPending || Boolean(source);
      const needsCommit = needsClose || !sameMathContentAttrs(localContentAttrs(), acceptedAttrs);
      if (!needsCommit) return;

      const previousRaw = raw;
      const previousClosePromptFinalized = closePromptFinalized;
      closePromptFinalized = true;
      if (needsClose) markPendingEditChanged();
      raw = tex === originalTex ? raw : "";
      blurPending = false;
      editing = false;
      if (!updateAttrs({ tex, raw, editing: false }, flushRequest)) {
        raw = previousRaw;
        editing = wasEditing;
        blurPending = wasBlurPending;
        closePromptFinalized = previousClosePromptFinalized;
        throw editConflict ?? new MathEditConflictError();
      }
      if (needsClose) renderDisplay();
    },
  };
  const pendingRegistration = registerPendingMathEdit(editor, pendingEdit);
  const unregisterPendingEdit = pendingRegistration.unregister;
  markPendingEditChanged = pendingRegistration.markChanged;
  markPendingInputChanged = pendingRegistration.markInputChanged;

  const renderDisplay = () => {
    if (blurPending) markPendingEditChanged();
    blurPending = false;
    displayRendered = true;
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
  };

  const renderPlaceholder = () => {
    if (blurPending) markPendingEditChanged();
    blurPending = false;
    dom.className = "math-node math-node-block math-node-pending";
    dom.textContent = tex;
  };

  const commitAfterBlur = (textarea: HTMLTextAreaElement) => {
    if (closePromptFinalized) return;
    const activeElement = document.activeElement;
    const decision = resolveMathBlurDecision({
      composing,
      blurPending,
      sourceConnected: textarea.isConnected,
      activeInside: activeElement === textarea || dom.contains(activeElement),
    });
    if (destroyed || decision === "defer-composition" || decision === "wait-source") return;
    if (decision === "keep-editing") {
      if (blurPending) markPendingEditChanged();
      blurPending = false;
      return;
    }
    if (blurPending) markPendingEditChanged();
    blurPending = false;
    if (!editing) return;
    markPendingEditChanged();
    editing = false;
    raw = tex === originalTex ? raw : "";
    if (!updateAttrs({ tex, raw, editing: false })) {
      markPendingEditChanged();
      editing = true;
      if (!blurPending) markPendingEditChanged();
      blurPending = true;
      return;
    }
    if (tex.trim()) renderDisplay();
  };

  const renderEditor = () => {
    closePromptFinalized = false;
    if (blurPending) markPendingEditChanged();
    blurPending = false;
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

    const syncOverlayPosition = () => {
      window.requestAnimationFrame(() => {
        dom.style.setProperty("--math-block-editor-bottom", `${textarea.offsetTop + textarea.offsetHeight + 4}px`);
      });
    };

    const installEditingTools = () => {
      dom.querySelector(":scope > .math-tools-block-editing")?.remove();
      appendMathTools(dom, body, { tex, delimiter, raw: "", displayMode: true }, () => {
        editorMathEvaluationCache.delete(editor.view.state.doc);
        window.dispatchEvent(new CustomEvent("lightmark:refresh-math"));
        renderKatex(body, tex, true, "公式预览", {
          delimiter,
          raw: "",
          evaluation: evaluateEditorMathAt(editor, getPos, tex, delimiter, true),
        });
        installEditingTools();
      }, "math-tools-block-editing");
    };

    const refresh = () => {
      if (destroyed) return;
      if (textarea.value !== tex) {
        tex = textarea.value;
        markPendingEditChanged();
        markPendingInputChanged();
      }
      textarea.rows = Math.max(2, tex.split(/\r?\n/).length);
      renderKatex(body, tex, true, "公式预览", {
        delimiter,
        raw: "",
        evaluation: evaluateEditorMathAt(editor, getPos, tex, delimiter, true),
      });
      installEditingTools();
      if (!composing) suggest?.sync();
      syncOverlayPosition();
    };

    suggest = createLatexSuggestController({
      host: dom,
      anchor: textarea,
      getValue: () => textarea.value,
      setValue: (value) => {
        if (textarea.value !== value) {
          markPendingEditChanged();
          markPendingInputChanged();
        }
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
    textarea.addEventListener("compositionstart", () => {
      if (!composing) markPendingEditChanged();
      composing = true;
      suggest?.close();
    });
    textarea.addEventListener("compositionend", () => {
      if (destroyed) return;
      if (composing) markPendingEditChanged();
      composing = false;
      refresh();
      resolveCompositionWaiters();
      if (blurPending) window.setTimeout(() => commitAfterBlur(textarea), 0);
    });
    textarea.addEventListener("keydown", (event) => {
      if (composing || isMathCompositionKey(event)) return;
      if (suggest?.handleKeyDown(event)) return;
      if (event.key === "Backspace" && !tex.trim() && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        event.preventDefault();
        deleteMathNode(editor, getPos);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        exitToNextParagraph();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        exitToNextParagraph();
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
      if (closePromptFinalized) return;
      if (!blurPending) markPendingEditChanged();
      blurPending = true;
      window.setTimeout(() => suggest?.close(), 120);
      window.setTimeout(() => {
        if (destroyed) return;
        commitAfterBlur(textarea);
      }, 0);
    });

    dom.append(textarea, preview);
    const evaluation = evaluateEditorMathAt(editor, getPos, tex, delimiter, true);
    renderKatex(body, tex, true, "公式预览", { delimiter, raw: "", evaluation });
    installEditingTools();
    syncOverlayPosition();
    const diagnostic = evaluation?.diagnostic ?? null;
    textarea.focus();
    const offset = diagnostic?.texOffset ?? tex.length;
    textarea.setSelectionRange(offset, offset);
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
    closePromptFinalized = false;
    markPendingEditChanged();
    editing = true;
    renderEditor();
  });

  editing ? renderEditor() : renderPlaceholder();
  const stopVisibility = observeMathVisibility(dom, () => {
    if (!editing && tex.trim()) renderDisplay();
  });
  const stopRefresh = subscribeMathRefresh((kind) => {
    if (kind === "tools") editorMathEvaluationCache.delete(editor.view.state.doc);
    if (!editing && displayRendered && tex.trim()) renderDisplay();
  });

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "blockMath") return false;
      const nextEditing = Boolean(nextNode.attrs.editing) || !nextNode.attrs.tex;
      const incomingAttrs = readMathContentAttrs({
        ...(nextNode.attrs as MathAttrs),
        delimiter: nextNode.attrs.delimiter || "display-dollar",
        displayMode: true,
      });
      const localAttrs = localContentAttrs();
      const decision = resolveMathContentUpdate({
        editing: editing && Boolean(dom.querySelector(".math-block-editor")),
        local: localAttrs,
        accepted: acceptedAttrs,
        incoming: incomingAttrs,
      });
      if (decision === "preserve-local") {
        markPendingEditChanged();
        acceptedNode = nextNode;
        return true;
      }
      if (decision === "ack-local") {
        acceptNode(nextNode);
        return true;
      }
      if (decision === "conflict") {
        setEditConflict(new MathEditConflictError("公式编辑内容与文档更新冲突"));
        return true;
      }
      if (decision === "accept-incoming") {
        acceptNode(nextNode);
      }
      editing = nextEditing;
      editing ? renderEditor() : displayRendered ? renderDisplay() : renderPlaceholder();
      return true;
    },
    selectNode() {
      if (editing) return;
      closePromptFinalized = false;
      markPendingEditChanged();
      editing = true;
      renderEditor();
    },
    deselectNode() {
      if (!editing) return;
      if (composing) {
        if (!blurPending) markPendingEditChanged();
        blurPending = true;
        return;
      }
      if (!tex.trim()) return;
      markPendingEditChanged();
      editing = false;
      if (!updateAttrs({ editing: false })) {
        markPendingEditChanged();
        editing = true;
        return;
      }
      renderDisplay();
    },
    destroy() {
      const hadPending = pendingEdit.hasPending();
      const position = readNodeViewPosition(getPos);
      if (position !== null) lastKnownPosition = position;
      destroyed = true;
      suggest?.destroy();
      if (hadPending) {
        setEditConflict(new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入"));
      } else {
        unregisterPendingEdit();
      }
      rejectCompositionWaiters(editConflict ?? new MathEditConflictError("公式编辑视图已销毁，无法确认未提交内容已写入"));
      stopVisibility();
      stopRefresh();
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
  extraClass = "",
) {
  const tools = document.createElement("span");
  tools.className = `math-tools${extraClass ? ` ${extraClass}` : ""}`;
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
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selection = previousFocus instanceof HTMLTextAreaElement || previousFocus instanceof HTMLInputElement
      ? { start: previousFocus.selectionStart, end: previousFocus.selectionEnd }
      : null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    previousFocus?.focus({ preventScroll: true });
    if (selection && (previousFocus instanceof HTMLTextAreaElement || previousFocus instanceof HTMLInputElement)) {
      previousFocus.setSelectionRange(selection.start, selection.end);
    }
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
