import { notifyPendingEditorInput, registerPendingEditorBuffer } from '../editor/pendingEditorBuffer';
import { DOCUMENT_FLUSH_META_KEY, type PendingMathFlushRequest } from '../editor/documentMutationTracker';
import { mergeAttributes, Node } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import {
  registerRecoveryLocalBufferForOwner,
  retainAndUnregisterRecoveryLocalBufferForOwner,
  type RecoveryLocalBufferV3,
} from "../editor/recoveryLocalState";

type MermaidAttrs = {
  code: string;
  editing?: boolean;
};

let mermaidId = 0;

let mermaidModulePromise: Promise<typeof import("mermaid")["default"]> | null = null;

export const MermaidNode = Node.create({
  name: "mermaidDiagram",
  group: "block",
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      code: { default: "" },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="mermaid"]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          return { code: element.dataset.code || element.textContent || "" };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const code = HTMLAttributes.code || "";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "mermaid",
        "data-code": code,
      }),
      code,
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
            if ($from.parent.textContent.trim() !== "```mermaid") return false;

            event.preventDefault();
            const from = $from.before();
            const to = $from.after();
            const node = state.schema.nodes.mermaidDiagram.create({ code: "", editing: true });
            const tr = state.tr.replaceWith(from, to, node);
            view.dispatch(tr.scrollIntoView());
            requestAnimationFrame(() => {
              view.dom.querySelector<HTMLTextAreaElement>(".mermaid-source-editor")?.focus();
            });
            return true;
          },
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createMermaidView(node.attrs as MermaidAttrs, editor, getPos);
  },
});

type NodeViewPosition = (() => number | undefined) | boolean;

function readMermaidNodePosition(getPos: NodeViewPosition) {
  if (typeof getPos !== "function") return null;
  try {
    const position = getPos();
    return Number.isSafeInteger(position) && (position as number) >= 0 ? position as number : null;
  } catch {
    return null;
  }
}

function readMermaidNodeBinding(
  editor: any,
  getPos: NodeViewPosition,
  acceptedCode: string,
  acceptedEditing: boolean,
  lastKnownPosition: number | null,
) {
  const position = readMermaidNodePosition(getPos);
  if (position === null) {
    return {
      position: lastKnownPosition,
      failure: {
        code: "node-view-position-unavailable",
        message: "Mermaid NodeView position is unavailable; its local value was retained as an orphan.",
        status: "orphaned" as const,
      },
    };
  }
  let currentNode: any = null;
  try {
    currentNode = editor?.view?.state?.doc?.nodeAt?.(position) ?? null;
  } catch {
    currentNode = null;
  }
  if (!currentNode || currentNode.type?.name !== "mermaidDiagram") {
    return {
      position,
      failure: {
        code: "document-node-unavailable",
        message: "The current PM node no longer matches this Mermaid NodeView.",
        status: "conflicted" as const,
      },
    };
  }
  if (String(currentNode.attrs.code || "") !== acceptedCode || Boolean(currentNode.attrs.editing) !== acceptedEditing) {
    return {
      position,
      failure: {
        code: "document-node-changed",
        message: "The PM Mermaid node changed while its local value was pending.",
        status: "conflicted" as const,
      },
    };
  }
  return { position, currentNode };
}

function restoreMermaidTextUi(
  control: HTMLTextAreaElement | null,
  ui: RecoveryLocalBufferV3["ui"],
) {
  if (!control || !ui) return;
  requestAnimationFrame(() => {
    if (ui.focused) control.focus();
    const max = control.value.length;
    control.setSelectionRange(
      Math.max(0, Math.min(ui.anchor, max)),
      Math.max(0, Math.min(ui.head, max)),
      ui.direction === "none" ? undefined : ui.direction,
    );
  });
}

function createMermaidView(attrs: MermaidAttrs, editor: any, getPos: NodeViewPosition) {
  const dom = document.createElement("section");
  dom.className = "mermaid-node";
  dom.contentEditable = "false";

  let code = attrs.code || "";
  let editing = Boolean(attrs.editing) || !code.trim();
  let acceptedCode = code;
  let acceptedEditing = Boolean(attrs.editing);
  let composing = false;
  let lastKnownPosition = readMermaidNodePosition(getPos);
  const recoveryId = `mermaid-local-${++mermaidId}`;
  let previewTimer = 0;
  let previewVersion = 0;

  let destroyed = false;
  let pendingConflict = false;
  const updateAttrs = (next: Partial<MermaidAttrs>, request?: PendingMathFlushRequest) => {
    if (destroyed) return false;
    const binding = readMermaidNodeBinding(editor, getPos, acceptedCode, acceptedEditing, lastKnownPosition);
    if (binding.failure || binding.position === null) { pendingConflict = true; return false; }
    lastKnownPosition = binding.position;
    const nextAttrs = { code, editing, ...next };
    if (nextAttrs.code === acceptedCode && nextAttrs.editing === acceptedEditing) return true;
    let transaction = editor.view.state.tr.setNodeMarkup(binding.position, undefined, nextAttrs);
    if (nextAttrs.code === acceptedCode) transaction = transaction.setMeta('lightmarkLocalEditorUi', true).setMeta('addToHistory', false);
    if (request) transaction = transaction.setMeta(DOCUMENT_FLUSH_META_KEY, request.flushId);
    editor.view.dispatch(transaction);
    return true;
  };
  const unregisterPending = registerPendingEditorBuffer(editor, {
    id: recoveryId, kind: 'mermaid',
    hasPending: () => composing || pendingConflict || code !== acceptedCode,
    flush(request) {
      if (composing) throw new Error('Mermaid 输入法组合尚未结束。');
      if (pendingConflict || !updateAttrs({ code, editing }, request)) throw new Error('Mermaid 局部输入与文档发生冲突，已保留恢复材料。');
    },
  });

  const exitToDocument = () => {
    editing = false;
    updateAttrs({ code, editing: false });
    if (code.trim()) void renderDisplay();
    setBlockSelectionAfter(editor, getPos);
  };

  const renderDisplay = async () => {
    dom.innerHTML = "";
    dom.className = "mermaid-node";
    if (!code.trim()) {
      dom.textContent = "空 Mermaid 图表";
      dom.classList.add("mermaid-node-empty");
      return;
    }

    dom.classList.remove("mermaid-node-empty");
    const body = document.createElement("div");
    body.className = "mermaid-node-body";
    dom.appendChild(body);

    try {
      const mermaid = await getMermaid();
      const id = `lightmark-mermaid-${++mermaidId}`;
      const result = await mermaid.render(id, code);
      body.innerHTML = result.svg;
    } catch {
      const pre = document.createElement("pre");
      pre.className = "mermaid-node-error";
      pre.textContent = code;
      body.replaceChildren(pre);
    }
  };

  const renderEditor = (focus = true) => {
    dom.innerHTML = "";
    dom.className = "mermaid-node mermaid-node-editing";

    const open = document.createElement("div");
    open.className = "mermaid-source-fence";
    open.textContent = "```mermaid";

    const textarea = document.createElement("textarea");
    textarea.className = "mermaid-source-editor";
    textarea.value = code;
    textarea.rows = Math.max(4, code.split(/\r?\n/).length);
    textarea.spellcheck = false;

    const close = document.createElement("div");
    close.className = "mermaid-source-fence";
    close.textContent = "```";

    const preview = document.createElement("div");
    preview.className = "mermaid-live-preview";

    const refresh = () => {
      code = textarea.value;
      textarea.rows = Math.max(4, code.split(/\r?\n/).length);
      notifyPendingEditorInput(editor);
      const version = ++previewVersion;
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        previewTimer = 0;
        if (version === previewVersion) void renderMermaid(preview, code, version, () => previewVersion);
      }, 150);
    };

    textarea.addEventListener("input", refresh);
    textarea.addEventListener("compositionstart", () => { composing = true; });
    textarea.addEventListener("compositionend", () => { composing = false; });
    textarea.addEventListener("keydown", (event) => {
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        textarea.blur();
        return;
      }
      if (event.key === "ArrowRight" && textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length) {
        event.preventDefault();
        exitToDocument();
      }
    });
    textarea.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement === textarea) return;
        if (destroyed || composing) return;
        editing = false;
        updateAttrs({ code, editing: false });
        if (code.trim()) void renderDisplay();
      }, 120);
    });

    dom.append(open, textarea, close, preview);
    void renderMermaid(preview, code, previewVersion, () => previewVersion);
    if (focus) requestAnimationFrame(() => textarea.focus());
  };

  const captureRecovery = () => {
    const binding = readMermaidNodeBinding(editor, getPos, acceptedCode, acceptedEditing, lastKnownPosition);
    if (binding.position !== null) lastKnownPosition = binding.position;
    const control = dom.querySelector<HTMLTextAreaElement>(".mermaid-source-editor");
    const payload = {
      accepted: { code: acceptedCode, editing: acceptedEditing },
      draft: { code: control?.value ?? code, editing },
      preview: { generation: previewVersion, status: previewTimer ? "scheduled" : "idle" },
      valueRevision: previewVersion,
    };
    if (binding.failure) {
      return {
        ok: false as const,
        ...binding.failure,
        payload,
        positionHint: binding.position,
      };
    }
    if (editing && !control) {
      return {
        ok: false as const,
        code: "dom-value-unavailable",
        message: "Mermaid editor value is unavailable while the NodeView is editing.",
        status: "orphaned" as const,
        payload,
        positionHint: binding.position,
      };
    }
    if (control && control.value !== code) {
      return {
        ok: false as const,
        code: "dom-closure-mismatch",
        message: "Mermaid DOM value and closure value disagree.",
        status: "conflicted" as const,
        payload,
        positionHint: binding.position,
      };
    }
    return {
      ok: true as const,
      buffer: {
        id: recoveryId,
        kind: "mermaid" as const,
        status: editing ? "editing" as const : "accepted" as const,
        sourceRevision: 0,
        positionHint: binding.position,
        payload,
        ...(control ? {
          ui: {
            anchor: control.selectionStart ?? control.value.length,
            head: control.selectionEnd ?? control.value.length,
            direction: control.selectionDirection === "forward" || control.selectionDirection === "backward"
              ? control.selectionDirection
              : "none" as const,
            focused: document.activeElement === control,
            composing,
          },
        } : {}),
      },
    };
  };

  const restoreRecovery = (buffer: RecoveryLocalBufferV3) => {
    const payload = buffer.payload as {
      accepted?: { code?: string; editing?: boolean };
      draft?: string | { code?: string; editing?: boolean };
    };
    const draft = payload.draft;
    code = typeof draft === "string" ? draft : String(draft?.code ?? payload.accepted?.code ?? "");
    editing = buffer.status === "editing" || Boolean(typeof draft === "object" && draft?.editing);
    editing ? renderEditor(false) : void renderDisplay();
    if (editing) restoreMermaidTextUi(dom.querySelector<HTMLTextAreaElement>(".mermaid-source-editor"), buffer.ui);
  };
  const unregisterRecovery = registerRecoveryLocalBufferForOwner(editor, {
    id: recoveryId,
    kind: "mermaid",
    sourceRevision: 0,
    positionHint: lastKnownPosition,
    capture: captureRecovery,
    restore: restoreRecovery,
  });

  editing ? renderEditor() : void renderDisplay();

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "mermaidDiagram") return false;
      const nextCode = nextNode.attrs.code || "";
      const nextEditing = Boolean(nextNode.attrs.editing) || !nextCode.trim();
      const control = dom.querySelector<HTMLTextAreaElement>('.mermaid-source-editor');
      if (editing && control) {
        if (nextCode === code || nextCode === acceptedCode) {
          acceptedCode = nextCode;
          acceptedEditing = Boolean(nextNode.attrs.editing);
          if (nextCode === code) pendingConflict = false;
          return true;
        }
        if (code !== acceptedCode) {
          pendingConflict = true;
          return true;
        }
        // A clean buffer follows history or an external model transaction.
        // Reuse the control so an accepted update does not destroy focus.
        const anchor = control.selectionStart, head = control.selectionEnd, direction = control.selectionDirection;
        code = nextCode;
        acceptedCode = nextCode;
        acceptedEditing = Boolean(nextNode.attrs.editing);
        control.value = code;
        control.rows = Math.max(4, code.split(/\r?\n/).length);
        control.setSelectionRange(Math.min(anchor, code.length), Math.min(head, code.length), direction);
        const preview = dom.querySelector<HTMLElement>('.mermaid-live-preview');
        if (preview) void renderMermaid(preview, code, ++previewVersion, () => previewVersion);
        return true;
      }
      acceptedCode = nextCode;
      acceptedEditing = Boolean(nextNode.attrs.editing);
      code = nextCode;
      editing = nextEditing;
      editing ? renderEditor() : void renderDisplay();
      return true;
    },
    selectNode() {
      if (editing) return;
      editing = true;
      updateAttrs({ editing: true });
      renderEditor();
    },
    deselectNode() {
      if (!editing || !code.trim()) return;
      editing = false;
      updateAttrs({ editing: false });
      void renderDisplay();
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
    destroy() {
      destroyed = true;
      unregisterPending();
      const control = dom.querySelector<HTMLTextAreaElement>(".mermaid-source-editor");
      const pending = pendingConflict || composing || code !== acceptedCode || Boolean(control && control.value !== code);
      window.clearTimeout(previewTimer);
      previewVersion += 1;
      if (pending) retainAndUnregisterRecoveryLocalBufferForOwner(editor, recoveryId);
      else unregisterRecovery();
    },
  };
}

async function renderMermaid(target: HTMLElement, code: string, version = 0, currentVersion = () => version) {
  target.innerHTML = "";
  if (!code.trim()) {
    target.textContent = "Mermaid 预览";
    target.classList.add("mermaid-node-empty");
    return;
  }

  target.classList.remove("mermaid-node-empty");
  try {
    const mermaid = await getMermaid();
    const id = `lightmark-mermaid-${++mermaidId}`;
    const result = await mermaid.render(id, code);
    if (version !== currentVersion()) return;
    target.innerHTML = result.svg;
  } catch {
    if (version !== currentVersion()) return;
    const pre = document.createElement("pre");
    pre.className = "mermaid-node-error";
    pre.textContent = code;
    target.replaceChildren(pre);
  }
}

async function getMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
      });
      return mermaid;
    });
  }
  const mermaid = await mermaidModulePromise;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
  });
  return mermaid;
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
