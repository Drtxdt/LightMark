import { Fragment } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

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
  const tr = state.tr.replaceWith(headingPos, headingPos + node.nodeSize, editable);
  return tr.setSelection(TextSelection.create(tr.doc, headingPos + 1 + marker.length + textOffset));
}
