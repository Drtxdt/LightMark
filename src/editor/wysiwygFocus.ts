import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface WysiwygFocusMatch {
  docFrom: number;
  docTo: number;
}

export function createWysiwygFocusPlugin(options: {
  enabled(): boolean;
  matches(): readonly WysiwygFocusMatch[];
}) {
  return new Plugin({
    key: new PluginKey("lightmarkIncrementalWritingFocus"),
    props: {
      attributes: () => ({ class: options.enabled() ? "lm-focus-root" : "" }),
      decorations(state) {
        if (!options.enabled()) return null;
        const { $from } = state.selection;
        const activeTopPos = $from.depth > 0 ? $from.before(1) : 0;
        const activeTopNode = state.doc.nodeAt(activeTopPos);
        const activePositions = new Set<number>([activeTopPos]);
        for (const match of options.matches()) {
          const position = Math.max(0, Math.min(state.doc.content.size, match.docFrom));
          const resolved = state.doc.resolve(position);
          activePositions.add(resolved.depth > 0 ? resolved.before(1) : 0);
        }
        const decorations: Decoration[] = [];
        for (const position of activePositions) {
          const node = state.doc.nodeAt(position);
          if (node) decorations.push(Decoration.node(position, position + node.nodeSize, { class: "lm-focus-active" }));
        }

        if (activeTopNode && (activeTopNode.type.name === "bulletList" || activeTopNode.type.name === "orderedList")) {
          let outerListItemPos: number | null = null;
          for (let depth = 1; depth <= $from.depth; depth += 1) {
            if ($from.node(depth).type.name === "listItem") {
              outerListItemPos = $from.before(depth);
              break;
            }
          }
          if (outerListItemPos !== null) activeTopNode.forEach((item, itemOffset) => {
            const itemPos = activeTopPos + 1 + itemOffset;
            const containsMatch = options.matches().some((match) => match.docFrom < itemPos + item.nodeSize && match.docTo > itemPos);
            decorations.push(Decoration.node(itemPos, itemPos + item.nodeSize, {
              class: itemPos === outerListItemPos || containsMatch ? "lm-focus-list-active" : "lm-focus-list-dimmed",
            }));
          });
        }
        return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
  });
}
