import { Fragment } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

export const exposeMarkdownMeta = "lightmarkExposeMarkdown";
export const clearExposeMarkdownMeta = "lightmarkClearExposeMarkdown";
export const markdownPresentationMeta = "lightmarkMarkdownPresentation";
export interface ExposedMarkdownRange {
  kind: "heading" | "inline";
  from: number;
  to: number;
  blockFrom: number;
  open: string;
  close: string;
  markName?: string;
  headingLevel?: number;
  headingInvalid?: boolean;
}

function presentationTransaction(tr: Transaction) {
  return tr.setMeta(markdownPresentationMeta, true).setMeta("addToHistory", false);
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
  if (!node || node.type.name !== "heading") return null;

  const marker = `${"#".repeat(node.attrs.level || 1)} `;
  const textOffset = Math.max(0, Math.min(node.content.size, clickedPos - headingPos - 1));
  const exposed: ExposedMarkdownRange = {
    kind: "heading",
    from: headingPos + 1,
    to: headingPos + node.nodeSize - 1 + marker.length,
    blockFrom: headingPos,
    open: marker,
    close: "",
    headingLevel: node.attrs.level || 1,
  };
  const tr = state.tr.insert(headingPos + 1, Fragment.from(state.schema.text(marker)))
    .setMeta(exposeMarkdownMeta, exposed);
  return presentationTransaction(
    tr.setSelection(TextSelection.create(tr.doc, headingPos + 1 + marker.length + textOffset)),
  );
}

export function exposeInlineMarkdown(
  state: EditorState,
  from: number,
  to: number,
  markType: any,
  open: string,
  close: string,
  side: "open" | "close",
  caretPos?: number,
): Transaction | null {
  if (from >= to || !markType) return null;
  const $from = state.doc.resolve(from);
  const blockFrom = $from.depth > 0 ? $from.before() : from;
  // The source delimiters are transient text, but the formatted content keeps
  // its semantic mark while it is being edited. Insert explicit unmarked text
  // nodes so ProseMirror cannot inherit the adjacent mark onto the delimiters.
  let tr = state.tr.insert(to, Fragment.from(state.schema.text(close)));
  tr = tr.insert(from, Fragment.from(state.schema.text(open))).setMeta(exposeMarkdownMeta, {
    kind: "inline",
    from,
    to: to + open.length + close.length,
    blockFrom,
    open,
    close,
    markName: markType.name,
  } satisfies ExposedMarkdownRange);
  const caret = caretPos == null
    ? side === "open" ? from + open.length : to + open.length
    : Math.max(from, Math.min(to, caretPos)) + open.length;
  return presentationTransaction(tr.setSelection(TextSelection.create(tr.doc, caret)));
}

export function removeExposedMarkdownFormatting(
  state: EditorState,
  exposed: ExposedMarkdownRange,
  caretSide: "open" | "close",
): Transaction | null {
  if (exposed.kind === "heading") {
    const node = state.doc.nodeAt(exposed.blockFrom);
    const paragraph = state.schema.nodes.paragraph;
    if (!node || !paragraph) return null;
    const content = node.content.cut(Math.min(exposed.open.length, node.content.size));
    const tr = state.tr.replaceWith(
      exposed.blockFrom,
      exposed.blockFrom + node.nodeSize,
      paragraph.create(null, content, node.marks),
    );
    return tr
      .setSelection(TextSelection.create(tr.doc, Math.min(exposed.blockFrom + 1, tr.doc.content.size)))
      .setMeta(clearExposeMarkdownMeta, true);
  }

  const closeFrom = exposed.to - exposed.close.length;
  const openTo = exposed.from + exposed.open.length;
  const contentLength = Math.max(0, closeFrom - openTo);
  const markType = exposed.markName ? state.schema.marks[exposed.markName] : null;
  let tr = state.tr;
  if (exposed.close.length) tr = tr.delete(closeFrom, exposed.to);
  if (exposed.open.length) tr = tr.delete(exposed.from, openTo);
  if (markType && contentLength) tr = tr.removeMark(exposed.from, exposed.from + contentLength, markType);
  const caret = caretSide === "open" ? exposed.from : exposed.from + contentLength;
  return tr
    .setSelection(TextSelection.create(tr.doc, Math.max(0, Math.min(caret, tr.doc.content.size))))
    .setMeta(clearExposeMarkdownMeta, true);
}

export function reconcileExposedHeading(state: EditorState, exposed: ExposedMarkdownRange): Transaction | null {
  if (exposed.kind !== "heading") return null;
  const node = state.doc.nodeAt(exposed.blockFrom);
  if (!node?.isTextblock) return null;
  const match = node.textContent.match(/^(#{1,6})(\s+)(.+)$/);

  if (node.type.name === "heading" && !match) {
    const paragraph = state.schema.nodes.paragraph;
    if (!paragraph) return null;
    let tr = state.tr.replaceWith(
      exposed.blockFrom,
      exposed.blockFrom + node.nodeSize,
      paragraph.create(null, node.content, node.marks),
    );
    tr = tr
      .setSelection(TextSelection.create(tr.doc, Math.min(state.selection.from, tr.doc.content.size)))
      .setMeta(exposeMarkdownMeta, { ...exposed, headingInvalid: true });
    return presentationTransaction(tr);
  }
  if (!match || (node.type.name === "heading" && match[1].length === node.attrs.level)) return null;
  if (node.type.name !== "paragraph" || !exposed.headingInvalid) {
    if (node.type.name !== "heading") return null;
  }

  const heading = state.schema.nodes.heading;
  if (!heading) return null;
  const markerLength = match[1].length + match[2].length;
  const oldCaret = state.selection.from;
  const textOffset = Math.max(0, oldCaret - (exposed.blockFrom + 1) - markerLength);
  const headingNode = heading.create({ level: match[1].length }, state.schema.text(match[3]), node.marks);
  let tr = state.tr.replaceWith(exposed.blockFrom, exposed.blockFrom + node.nodeSize, headingNode);
  const caret = Math.max(0, Math.min(exposed.blockFrom + 1 + textOffset, tr.doc.content.size));
  tr = tr
    .setSelection(TextSelection.create(tr.doc, caret))
    .setMeta(clearExposeMarkdownMeta, true);
  return presentationTransaction(tr);
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
    if (!range) continue;
    const enteringFromLeft = direction === "right" && pos === range.from;
    const enteringFromRight = direction === "left" && pos === range.to;
    if (!enteringFromLeft && !enteringFromRight && (pos <= range.from || pos >= range.to)) continue;
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
      pos,
    );
  }
  return null;
}
