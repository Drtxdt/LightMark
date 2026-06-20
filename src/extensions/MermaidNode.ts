import { mergeAttributes, Node } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import mermaid from "mermaid";

type MermaidAttrs = {
  code: string;
  editing?: boolean;
};

let mermaidId = 0;

configureMermaid();

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

function createMermaidView(attrs: MermaidAttrs, editor: any, getPos: NodeViewPosition) {
  const dom = document.createElement("section");
  dom.className = "mermaid-node";
  dom.contentEditable = "false";

  let code = attrs.code || "";
  let editing = Boolean(attrs.editing) || !code.trim();

  const updateAttrs = (next: Partial<MermaidAttrs>) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { code, editing, ...next }));
  };

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
      configureMermaid();
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

  const renderEditor = () => {
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
      updateAttrs({ code, editing: true });
      void renderMermaid(preview, code);
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
        exitToDocument();
      }
    });
    textarea.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement === textarea) return;
        editing = false;
        updateAttrs({ code, editing: false });
        if (code.trim()) void renderDisplay();
      }, 120);
    });

    dom.append(open, textarea, close, preview);
    void renderMermaid(preview, code);
    requestAnimationFrame(() => textarea.focus());
  };

  editing ? renderEditor() : void renderDisplay();

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "mermaidDiagram") return false;
      const nextCode = nextNode.attrs.code || "";
      const nextEditing = Boolean(nextNode.attrs.editing) || !nextCode.trim();
      if (editing && nextEditing && dom.querySelector(".mermaid-source-editor")) return true;
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
  };
}

async function renderMermaid(target: HTMLElement, code: string) {
  target.innerHTML = "";
  if (!code.trim()) {
    target.textContent = "Mermaid 预览";
    target.classList.add("mermaid-node-empty");
    return;
  }

  target.classList.remove("mermaid-node-empty");
  try {
    configureMermaid();
    const id = `lightmark-mermaid-${++mermaidId}`;
    const result = await mermaid.render(id, code);
    target.innerHTML = result.svg;
  } catch {
    const pre = document.createElement("pre");
    pre.className = "mermaid-node-error";
    pre.textContent = code;
    target.replaceChildren(pre);
  }
}

function configureMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
  });
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
