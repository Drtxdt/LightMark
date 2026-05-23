import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";

export const MarkdownHeading = Extension.create({
  name: "markdownHeading",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            return DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
