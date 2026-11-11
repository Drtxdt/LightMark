import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createMarkdownPositionMap, pmPositionToSource } from './markdownPositionMap';
import { parseMarkdownMath, serializeMathToken, type MathDelimiter } from '../utils/mathMarkdown';

/** Candidates only. The caller must reparse the complete block and compare its model before accepting one. */
export function mathAttributeSourceCandidates(source: string, before: ProseMirrorNode, after: ProseMirrorNode): string[] {
  const changed: Array<{ before: ProseMirrorNode; after: ProseMirrorNode; position: number }> = [];
  const attributes = (node: ProseMirrorNode, math: boolean) => Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== 'editing'
    && (!math || !['tex', 'raw', 'originalTex', 'delimiter', 'displayMode'].includes(key))));
  const walk = (left: ProseMirrorNode, right: ProseMirrorNode, position: number): boolean => {
    if (left === right) return true;
    if (left.type !== right.type || left.text !== right.text || left.childCount !== right.childCount || left.marks.length !== right.marks.length
      || left.marks.some((mark, index) => !mark.eq(right.marks[index]))) return false;
    const math = left.type.name === 'inlineMath' || left.type.name === 'blockMath';
    if (JSON.stringify(attributes(left, math)) !== JSON.stringify(attributes(right, math))) return false;
    if (math) { changed.push({ before: left, after: right, position }); return true; }
    let offset = position + 1;
    for (let index = 0; index < left.childCount; index++) {
      if (!walk(left.child(index), right.child(index), offset)) return false;
      offset += left.child(index).nodeSize;
    }
    return true;
  };
  if (!walk(before, after, 0) || !changed.length) return [];
  try {
    const map = createMarkdownPositionMap(source, before.type.schema.nodes.doc.create(null, before));
    const tokens = parseMarkdownMath(source).tokens;
    const patches: Array<{ from: number; to: number; insert: string }> = [];
    for (const change of changed) {
      const from = pmPositionToSource(map, change.position, 1), to = pmPositionToSource(map, change.position + change.before.nodeSize, -1);
      const token = tokens.find(token => token.from === from && token.to === to && token.tex === change.before.attrs.tex);
      if (!token) return [];
      const delimiter = (change.after.attrs.delimiter || token.delimiter) as MathDelimiter;
      if (delimiter === token.delimiter) patches.push({ from: token.contentFrom, to: token.contentTo, insert: String(change.after.attrs.tex ?? '') });
      else patches.push({ from, to, insert: serializeMathToken({ delimiter, raw: '', tex: String(change.after.attrs.tex ?? '') }) });
    }
    let candidate = source;
    for (const patch of patches.sort((a, b) => b.from - a.from)) candidate = candidate.slice(0, patch.from) + patch.insert + candidate.slice(patch.to);
    return [candidate];
  } catch { return []; }
}
