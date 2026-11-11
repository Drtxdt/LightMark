import type { Node as ProseMirrorNode, MarkType } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

type Options = { onlySelectionBlock?: boolean; targetBlockFrom?: number };
type Converter = { mark: MarkType; pattern: RegExp; prefix: number; attrs?: (match: RegExpExecArray) => Record<string, string> };

// Every projected UTF-16 offset is also a PM content offset. Atoms reserve
// their real nodeSize, rather than disappearing as they do in textContent.
function projectInline(node: ProseMirrorNode) {
  let text = '';
  const protectedRanges: Array<{ from: number; to: number }> = [];
  node.forEach((child, offset) => {
    text += child.isText ? child.text! : '\uFFFC'.repeat(child.nodeSize);
    if (child.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'plainPaste')) {
      protectedRanges.push({ from: offset, to: offset + child.nodeSize });
    }
  });
  return { text, protectedRanges };
}

function escaped(text: string, offset: number) {
  let slashes = 0;
  while (offset > 0 && text[--offset] === '\\') slashes++;
  return slashes % 2 !== 0;
}

function convert(state: EditorState, converters: Converter[], options: Options, code = false): Transaction | null {
  let result: Transaction | null = null;
  const { $from } = state.selection;
  if (options.onlySelectionBlock && !$from.depth) return null;
  const selectionBlockFrom = $from.depth ? $from.before() : null;
  state.doc.descendants((node, pos) => {
    if (result) return false;
    if (node.type.name === 'codeBlock') return false;
    if (!node.isTextblock) return true;
    if (options.targetBlockFrom != null && pos !== options.targetBlockFrom) return false;
    if (options.onlySelectionBlock && pos !== selectionBlockFrom) return false;
    const { text, protectedRanges } = projectInline(node);
    for (const converter of converters) {
      converter.pattern.lastIndex = 0;
      for (let match = converter.pattern.exec(text); match; match = converter.pattern.exec(text)) {
        const end = match.index + match[0].length;
        const prefix = code ? match[1].length : converter.prefix;
        const label = match[code ? 2 : 1];
        const labelFrom = match.index + prefix;
        const labelTo = labelFrom + label.length;
        if (escaped(text, match.index) || escaped(text, labelTo)
          || protectedRanges.some(range => range.from < end && range.to > match!.index)
          || (code && (label.includes('\uFFFC') || text[match.index - 1] === '`'))) continue;
        const from = pos + 1 + match.index;
        const to = pos + 1 + end;
        // Remove only syntax; never flatten the label's Fragment.
        let tr = state.tr.delete(pos + 1 + labelTo, to).delete(from, pos + 1 + labelFrom);
        tr = tr.addMark(from, from + label.length, converter.mark.create(converter.attrs?.(match)));
        if (state.selection.empty && state.selection.from >= from && state.selection.from <= to) {
          tr = tr.setSelection(TextSelection.create(tr.doc, from + label.length)).setStoredMarks([]);
        }
        result = tr;
        return false;
      }
    }
    return false;
  });
  return result;
}

export function convertInlineMarkdownSyntax(state: EditorState, options: Options = {}) {
  const definitions = [
    ['bold', /(?<!\*)\*\*([^*\n]+)\*\*/g, 2],
    ['italic', /(?<!\*)\*([^*\n]+)\*(?!\*)/g, 1],
    ['strike', /(?<!~)~~([^~\n]+)~~/g, 2],
    ['highlight', /(?<!=)==([^=\n]+)==/g, 2],
    ['superscript', /(?<!\^)\^([^^\n]+)\^/g, 1],
    ['subscript', /(?<!~)~([^~\n]+)~(?!~)/g, 1],
    ['link', /\[([^\]\n]+)\]\(([^)\s]+)\)/g, 1],
  ] as const;
  return convert(state, definitions.flatMap(([name, pattern, prefix]) => {
    const mark = state.schema.marks[name];
    return mark ? [{ mark, pattern, prefix, attrs: name === 'link' ? (match: RegExpExecArray) => ({ href: match[2] }) : undefined }] : [];
  }), options);
}

export function convertInlineCodeSyntax(state: EditorState, options: Options = {}) {
  const mark = state.schema.marks.code;
  return mark ? convert(state, [{ mark, pattern: /(`+)([^`\n]+)\1(?!`)/g, prefix: 0 }], options, true) : null;
}
