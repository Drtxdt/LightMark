import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export interface SourceFocusRange {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  nodeName: string;
}

export function sourceFocusRange(state: EditorState, position = state.selection.main.head): SourceFocusRange {
  const bounded = Math.max(0, Math.min(position, state.doc.length));
  let node = syntaxTree(state).resolve(bounded, bounded < state.doc.length ? 1 : -1);
  let topLevel = null as typeof node | null;
  let outerListItem = null as typeof node | null;

  while (node.parent) {
    if (node.name === "ListItem") outerListItem = node;
    if (node.parent.name === "Document") topLevel = node;
    node = node.parent;
  }

  const target = outerListItem ?? topLevel;
  if (!target || target.name === "Document") {
    const line = state.doc.lineAt(bounded);
    return {
      from: line.from,
      to: line.to,
      fromLine: line.number,
      toLine: line.number,
      nodeName: "Line",
    };
  }

  return {
    from: target.from,
    to: target.to,
    fromLine: state.doc.lineAt(target.from).number,
    toLine: state.doc.lineAt(Math.max(target.from, target.to - 1)).number,
    nodeName: target.name,
  };
}

export function typewriterScrollDelta(
  caretTop: number,
  caretBottom: number,
  viewportTop: number,
  viewportBottom: number,
  lowerRatio = 0.38,
  upperRatio = 0.62,
  targetRatio = 0.5,
) {
  const viewportHeight = viewportBottom - viewportTop;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  const caretCenter = (caretTop + caretBottom) / 2;
  const lower = viewportTop + viewportHeight * lowerRatio;
  const upper = viewportTop + viewportHeight * upperRatio;
  if (caretCenter >= lower && caretCenter <= upper) return 0;
  return caretCenter - (viewportTop + viewportHeight * targetRatio);
}

export function hasVisibleBlockingOverlay(root: ParentNode = document) {
  return Array.from(root.querySelectorAll<HTMLElement>(".lm-modal-backdrop, .dialog-backdrop"))
    .some((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse"
        && element.getClientRects().length > 0;
    });
}
