import { Fragment } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

export const exposeMarkdownMeta = "lightmarkExposeMarkdown";
export const clearExposeMarkdownMeta = "lightmarkClearExposeMarkdown";
export interface ExposedMarkdownRange {
  kind: "heading" | "inline";
  from: number;
  to: number;
  blockFrom: number;
}

export function headingPositionAt(state: EditorState, insidePos: number): number | null {
  const $pos = state.doc.resolve(Math.max(0, Math.min(insidePos, state.doc.content.size)));
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === "heading") return $pos.before(depth);
  }
  return state.doc.nodeAt(insidePos)?.type.name === "heading" ? insidePos : null;
}

export function exposeHeadingMarkdown(
  state: EditorState,
  headingPos: number,
  clickedPos = headingPos + 1,
): Transaction | null {
  const node = state.doc.nodeAt(headingPos);
  const paragraph = state.schema.nodes.paragraph;
  if (!node || node.type.name !== "heading" || !paragraph) return null;

  const marker = `${"#".repeat(node.attrs.level || 1)} `;
  const textOffset = Math.max(0, Math.min(node.content.size, clickedPos - headingPos - 1));
  const content = Fragment.from(state.schema.text(marker)).append(node.content);
  const editable = paragraph.create(null, content, node.marks);
  const exposed: ExposedMarkdownRange = {
    kind: "heading",
    from: headingPos,
    to: headingPos + editable.nodeSize,
    blockFrom: headingPos,
  };
  const tr = state.tr.replaceWith(headingPos, headingPos + node.nodeSize, editable)
    .setMeta(exposeMarkdownMeta, exposed);
  return tr.setSelection(TextSelection.create(tr.doc, headingPos + 1 + marker.length + textOffset));
}

export function exposeInlineMarkdown(
  state: EditorState,
  from: number,
  to: number,
  markType: any,
  open: string,
  close: string,
  side: "open" | "close",
): Transaction | null {
  if (from >= to || !markType) return null;
  const $from = state.doc.resolve(from);
  const blockFrom = $from.depth > 0 ? $from.before() : from;
  let tr = state.tr.removeMark(from, to, markType);
  tr = tr.insertText(close, to).insertText(open, from).setMeta(exposeMarkdownMeta, {
    kind: "inline",
    from,
    to: to + open.length + close.length,
    blockFrom,
  } satisfies ExposedMarkdownRange);
  const caret = side === "open" ? from + open.length : to + open.length;
  return tr.setSelection(TextSelection.create(tr.doc, caret));
}

export function markdownMarkRangeAt(state: EditorState, pos: number, markName: string) {
  const markType = state.schema.marks[markName];
  if (!markType) return null;
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  if (!$pos.parent.isTextblock) return null;
  const activeMark = [...($pos.nodeBefore?.marks || []), ...($pos.nodeAfter?.marks || [])]
    .find((mark: any) => mark.type === markType);
  if (!activeMark) return null;

  const children: Array<{ node: any; offset: number }> = [];
  $pos.parent.forEach((node: any, offset: number) => children.push({ node, offset }));
  const hasMark = (node: any) => Boolean(activeMark.isInSet(node.marks));
  let index = children.findIndex(({ node, offset }) => hasMark(node)
    && $pos.parentOffset >= offset
    && $pos.parentOffset <= offset + node.nodeSize);
  if (index < 0) return null;
  let start = index;
  let end = index;
  while (start > 0 && hasMark(children[start - 1].node)) start -= 1;
  while (end < children.length - 1 && hasMark(children[end + 1].node)) end += 1;
  const parentStart = $pos.start();
  return {
    from: parentStart + children[start].offset,
    to: parentStart + children[end].offset + children[end].node.nodeSize,
    mark: activeMark,
  };
}

const inlineMarkdownDefinitions: Array<{
  markName: string;
  open: string;
  close: (mark: any) => string;
}> = [
  { markName: "link", open: "[", close: (mark) => `](${mark.attrs.href || ""})` },
  { markName: "code", open: "`", close: () => "`" },
  { markName: "bold", open: "**", close: () => "**" },
  { markName: "italic", open: "*", close: () => "*" },
  { markName: "strike", open: "~~", close: () => "~~" },
  { markName: "highlight", open: "==", close: () => "==" },
  { markName: "superscript", open: "^", close: () => "^" },
  { markName: "subscript", open: "~", close: () => "~" },
];

export type MarkdownCursorDirection = "left" | "right" | "up" | "down";

/**
 * Materialize the Markdown syntax surrounding an empty keyboard selection.
 * This deliberately runs after the browser/ProseMirror has performed its
 * native cursor move, so arrow navigation and mouse editing share the same
 * editable representation without replacing ProseMirror's navigation rules.
 */
export function exposeMarkdownAtCursor(
  state: EditorState,
  direction: MarkdownCursorDirection,
): Transaction | null {
  if (!state.selection.empty) return null;
  const pos = state.selection.from;
  const headingPos = headingPositionAt(state, pos);
  if (headingPos != null) return exposeHeadingMarkdown(state, headingPos, pos);

  for (const definition of inlineMarkdownDefinitions) {
    const range = markdownMarkRangeAt(state, pos, definition.markName);
    // A boundary position also belongs to adjacent marked text in PM. Requiring
    // the cursor to have actually entered the range prevents a cursor merely
    // leaving a mark (or normal typing at its edge) from reopening the syntax.
    if (!range || pos <= range.from || pos >= range.to) continue;
    const side = direction === "left"
      ? "close"
      : direction === "right"
        ? "open"
        : pos - range.from <= range.to - pos ? "open" : "close";
    return exposeInlineMarkdown(
      state,
      range.from,
      range.to,
      range.mark.type,
      definition.open,
      definition.close(range.mark),
      side,
    );
  }
  return null;
}
