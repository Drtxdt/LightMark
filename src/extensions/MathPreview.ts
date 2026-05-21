import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import katex from "katex";

type MathMatch = {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  formula: string;
  block: boolean;
};

export const MathPreview = Extension.create({
  name: "mathPreview",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const selectionFrom = state.selection.from;
            const selectionTo = state.selection.to;

            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return;

              const text = node.textContent;
              const base = pos + 1;
              const matches = findMathMatches(text, base);

              for (const match of matches) {
                const active = selectionFrom < match.to && selectionTo > match.from;
                const className = match.block ? "math-block-source" : "math-inline-source";
                const delimiterSize = match.block ? 2 : 1;

                if (active) {
                  decorations.push(Decoration.inline(match.from, match.from + delimiterSize, { class: "math-delimiter" }));
                  decorations.push(Decoration.inline(match.to - delimiterSize, match.to, { class: "math-delimiter" }));
                  decorations.push(
                    Decoration.inline(match.contentFrom, match.contentTo, {
                      class: className,
                    }),
                  );
                } else {
                  decorations.push(
                    Decoration.inline(match.from, match.to, {
                      class: match.block ? "math-source-hidden math-source-hidden-block" : "math-source-hidden",
                    }),
                  );
                  decorations.push(
                    Decoration.widget(match.from, (view) => renderMath(match, delimiterSize, view), {
                      side: -1,
                    }),
                  );
                }
              }
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

function findMathMatches(text: string, base: number) {
  const matches: MathMatch[] = [];
  const blockPattern = /\$\$([\s\S]+?)\$\$/g;
  const inlinePattern = /(^|[^$])\$([^$\n]+?)\$/g;

  for (const match of text.matchAll(blockPattern)) {
    const index = match.index ?? 0;
    const formula = match[1].trim();
    matches.push({
      from: base + index,
      to: base + index + match[0].length,
      contentFrom: base + index + 2,
      contentTo: base + index + match[0].length - 2,
      formula,
      block: true,
    });
  }

  for (const match of text.matchAll(inlinePattern)) {
    const index = (match.index ?? 0) + match[1].length;
    const from = base + index;
    const to = from + match[0].length - match[1].length;
    if (matches.some((item) => from >= item.from && to <= item.to)) continue;

    matches.push({
      from,
      to,
      contentFrom: from + 1,
      contentTo: to - 1,
      formula: match[2].trim(),
      block: false,
    });
  }

  return matches.sort((a, b) => a.from - b.from);
}

function renderMath(match: MathMatch, delimiterSize: number, view: { dispatch: Function; state: any; focus: Function }) {
  const container = document.createElement(match.block ? "div" : "span");
  container.className = match.block ? "math-render math-render-block" : "math-render math-render-inline";
  container.title = "Click to edit formula";
  container.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const position = Math.min(match.contentTo, match.from + delimiterSize);
    const selection = TextSelection.create(view.state.doc, position);
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    view.focus();
  });

  try {
    katex.render(match.formula, container, {
      displayMode: match.block,
      throwOnError: false,
      strict: false,
    });
  } catch {
    container.classList.add("math-render-error");
    container.textContent = match.formula;
  }

  return container;
}
