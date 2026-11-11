import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

function equalValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key)
    && equalValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Remounts construct a fresh schema. Compare names/values once, without cloning a document. */
export function equalCanonicalDocument(left: ProseMirrorNode, right: ProseMirrorNode): boolean {
  if (left.type.schema === right.type.schema) return left.eq(right);
  if (left.type.name !== right.type.name || left.text !== right.text || left.childCount !== right.childCount
    || !equalValue(left.attrs, right.attrs) || left.marks.length !== right.marks.length) return false;
  for (let i = 0; i < left.marks.length; i++) {
    if (left.marks[i].type.name !== right.marks[i].type.name || !equalValue(left.marks[i].attrs, right.marks[i].attrs)) return false;
  }
  for (let i = 0; i < left.childCount; i++) if (!equalCanonicalDocument(left.child(i), right.child(i))) return false;
  return true;
}
