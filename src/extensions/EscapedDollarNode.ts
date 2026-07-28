import { mergeAttributes, Node } from "@tiptap/core";

type EscapedDollarAttrs = {
  raw: string;
  display: string;
};

export const EscapedDollarNode = Node.create({
  name: "escapedDollar",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      raw: { default: "\\$" },
      display: { default: "$" },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="escaped-dollar"]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          return {
            raw: element.getAttribute("data-raw") || "\\$",
            display: element.getAttribute("data-display") || element.textContent || "$",
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const raw = String(HTMLAttributes.raw || "\\$");
    const display = String(HTMLAttributes.display || "$");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "escaped-dollar",
        "data-raw": raw,
        "data-display": display,
        class: "escaped-dollar-node",
        title: "转义美元符",
      }),
      display,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      const attrs = node.attrs as EscapedDollarAttrs;
      dom.className = "escaped-dollar-node";
      dom.dataset.type = "escaped-dollar";
      dom.dataset.raw = attrs.raw || "\\$";
      dom.dataset.display = attrs.display || "$";
      dom.title = "转义美元符";
      dom.contentEditable = "false";
      dom.textContent = attrs.display || "$";
      return { dom };
    };
  },
});
