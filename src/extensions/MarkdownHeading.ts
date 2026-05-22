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

            state.doc.descendants((node, pos) => {
              if (!node.isTextblock || node.type.name === "codeBlock") return true;

              const text = node.textContent;
              const match = text.match(/^(#{1,6})(\s+)/);
              if (!match) return true;

              const level = match[1].length;
              const markerStart = pos + 1;
              const markerEnd = markerStart + match[1].length;
              const hiddenEnd = markerEnd + match[2].length;

              decorations.push(
                Decoration.inline(markerStart, markerEnd, {
                  class: "md-marker",
                }),
              );
              decorations.push(
                Decoration.inline(markerEnd, hiddenEnd, {
                  class: "md-source-hidden",
                }),
              );
              decorations.push(
                Decoration.widget(hiddenEnd, () => {
                  const hint = document.createElement("span");
                  hint.className = "heading-level-hint";
                  hint.textContent = `H${level}`;
                  return hint;
                }),
              );

              return true;
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
