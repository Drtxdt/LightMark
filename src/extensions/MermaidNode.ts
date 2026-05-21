import { mergeAttributes, Node } from "@tiptap/core";
import mermaid from "mermaid";

type MermaidAttrs = {
  code: string;
};

let mermaidId = 0;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
});

export const MermaidNode = Node.create({
  name: "mermaidDiagram",
  group: "block",
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      code: { default: "" },
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

  addNodeView() {
    return ({ node }) => createMermaidView(node.attrs as MermaidAttrs);
  },
});

function createMermaidView(attrs: MermaidAttrs) {
  const dom = document.createElement("section");
  dom.className = "mermaid-node";
  dom.contentEditable = "false";

  let code = attrs.code || "";

  const render = async () => {
    dom.innerHTML = "";
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

  void render();

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "mermaidDiagram") return false;
      const nextCode = nextNode.attrs.code || "";
      if (nextCode === code) return true;
      code = nextCode;
      void render();
      return true;
    },
    ignoreMutation: () => true,
  };
}
