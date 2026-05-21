import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const MarkdownHeading = Extension.create({
  name: "markdownHeading",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const selectionFrom = state.selection.from;
            const selectionTo = state.selection.to;

            state.doc.descendants((node, pos) => {
              if (!node.isTextblock || node.type.name !== "paragraph") return;

              const match = node.textContent.match(/^(#{1,3})(?=\s|[^#]|$)/);
              if (!match) return;

              const level = match[1].length;
              const start = pos + 1;
              const markerEnd = start + level;
              const hasSpace = node.textContent[level] === " ";
              const hiddenEnd = markerEnd + (hasSpace ? 1 : 0);
              const active = selectionFrom <= pos + node.nodeSize && selectionTo >= start;

              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: `markdown-heading markdown-heading-${level}`,
                }),
              );
              if (active) {
                decorations.push(
                  Decoration.inline(start, markerEnd, {
                    class: "md-marker",
                  }),
                );
                decorations.push(
                  Decoration.widget(markerEnd, () => {
                    const hint = document.createElement("span");
                    hint.className = "heading-level-hint";
                    hint.textContent = `H${level}`;
                    return hint;
                  }),
                );
              } else {
                decorations.push(
                  Decoration.inline(start, hiddenEnd, {
                    class: "md-source-hidden",
                  }),
                );
              }
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
