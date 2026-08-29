import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type HastNode = {
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
};

type LowlightLike = {
  highlight(language: string, value: string): { value?: HastNode[]; children?: HastNode[] };
  highlightAuto(value: string): { value?: HastNode[]; children?: HastNode[] };
  registered?(language: string): boolean;
  listLanguages(): string[];
};

function flatten(nodes: HastNode[], inherited: string[] = []): Array<{ text: string; classes: string[] }> {
  return nodes.flatMap((node) => {
    const classes = [...inherited, ...(node.properties?.className ?? [])];
    return node.children?.length ? flatten(node.children, classes) : [{ text: node.value ?? "", classes }];
  });
}

function decorateCodeBlock(node: ProseMirrorNode, pos: number, lowlight: LowlightLike, defaultLanguage?: string | null) {
  const language = String(node.attrs.language || defaultLanguage || "");
  const known = Boolean(language && (lowlight.registered?.(language) || lowlight.listLanguages().includes(language)));
  const result = known ? lowlight.highlight(language, node.textContent) : lowlight.highlightAuto(node.textContent);
  const nodes = result.value ?? result.children ?? [];
  const decorations: Decoration[] = [];
  let from = pos + 1;
  for (const token of flatten(nodes)) {
    const to = from + token.text.length;
    if (token.classes.length && to > from) decorations.push(Decoration.inline(from, to, { class: token.classes.join(" ") }));
    from = to;
  }
  return decorations;
}

function allDecorations(doc: ProseMirrorNode, name: string, lowlight: LowlightLike, defaultLanguage?: string | null) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== name) return true;
    decorations.push(...decorateCodeBlock(node, pos, lowlight, defaultLanguage));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function affectedCodeBlocks(transaction: Transaction, name: string) {
  const blocks = new Map<number, ProseMirrorNode>();
  const doc = transaction.doc;
  const addAt = (position: number) => {
    const resolved = doc.resolve(Math.max(0, Math.min(doc.content.size, position)));
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      const node = resolved.node(depth);
      if (node.type.name === name) blocks.set(resolved.before(depth), node);
    }
  };
  for (const stepMap of transaction.mapping.maps) {
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = Math.max(0, newStart - 1);
      const to = Math.min(doc.content.size, Math.max(newStart, newEnd) + 1);
      addAt(from);
      addAt(to);
      doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== name) return true;
        blocks.set(pos, node);
        return false;
      });
    });
  }
  return blocks;
}

export function incrementalLowlightPlugin(options: {
  name: string;
  lowlight: LowlightLike;
  defaultLanguage?: string | null;
}) {
  const key = new PluginKey<DecorationSet>("lightmarkIncrementalLowlight");
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => allDecorations(state.doc, options.name, options.lowlight, options.defaultLanguage),
      apply(transaction, previous) {
        let next = previous.map(transaction.mapping, transaction.doc);
        if (!transaction.docChanged) return next;
        for (const [pos, node] of affectedCodeBlocks(transaction, options.name)) {
          next = next.remove(next.find(pos, pos + node.nodeSize));
          next = next.add(transaction.doc, decorateCodeBlock(node, pos, options.lowlight, options.defaultLanguage));
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        return key.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}
