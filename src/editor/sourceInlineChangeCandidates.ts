import type { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createMarkdownPositionMap, pmPositionToSource, parseMarkdownPositionSyntax } from './markdownPositionMap';

/** Serialize only the changed inline fragment; every result still requires a full-block model proof. */
export function inlineChangeSourceCandidates(
  source: string, before: ProseMirrorNode, after: ProseMirrorNode, serialize: (fragment: Fragment) => string,
) {
  if (!before.isTextblock || !after.isTextblock || before.type !== after.type) return [];
  const from = before.content.findDiffStart(after.content), end = before.content.findDiffEnd(after.content);
  if (from == null || !end) return [];
  const oldTo = Math.max(from, end.a), newTo = Math.max(from, end.b);
  const fragment = after.content.cut(from, newTo);
  // Plain text already has a literal-preserving path; this candidate handles
  // inserted text whose formatting was applied in an appended transaction.
  let formatted = false;
  fragment.forEach(node => { formatted ||= !node.isText || node.marks.length > 0; });
  if (!formatted) return [];
  try {
    const first = fragment.firstChild, last = fragment.lastChild;
    const leading = first?.isText ? first.text!.match(/^\s+/)?.[0] ?? '' : '';
    const trailing = last?.isText ? last.text!.match(/\s+$/)?.[0] ?? '' : '';
    const insert = leading + serialize(fragment).trim() + trailing;
    const map = createMarkdownPositionMap(source, before.type.schema.nodes.doc.create(null, before));
    const boundaries = new Map<number, Set<number>>();
    const boundary = (inner: number, outer: number) => {
      const values = boundaries.get(inner) ?? new Set<number>();
      values.add(outer); boundaries.set(inner, values);
    };
    parseMarkdownPositionSyntax(source).iterate({ enter(cursor) {
      if (!/^(?:StrongEmphasis|Emphasis|Strikethrough|InlineCode|Link)$/.test(cursor.name)) return;
      const first = cursor.node.firstChild;
      let last = cursor.node.lastChild;
      if (cursor.name === 'Link') {
        last = first?.nextSibling ?? null;
        while (last && last.name !== 'LinkMark') last = last.nextSibling;
      }
      if (first && last) { boundary(first.to, cursor.from); boundary(last.from, cursor.to); }
    } });
    const positions = (raw: number) => {
      const values = new Set([raw]);
      // An endpoint after the last visible link label also has a position
      // outside its URI/title. Mapping visible text alone cannot express it.
      const pending = [raw];
      for (let index = 0; index < pending.length && values.size < 32; index++) {
        for (const outer of boundaries.get(pending[index]) ?? []) if (!values.has(outer)) { values.add(outer); pending.push(outer); }
      }
      return [...values];
    };
    return [...new Set(([1, -1] as const).flatMap(affinity => {
      const rawFrom = pmPositionToSource(map, from + 1, affinity);
      const rawTo = oldTo === from ? rawFrom : pmPositionToSource(map, oldTo + 1, -1);
      if (oldTo === from) return positions(rawFrom).map(at => source.slice(0, at) + insert + source.slice(at));
      return positions(rawFrom).flatMap(start => positions(rawTo).flatMap(end => end < start ? [] : [source.slice(0, start) + insert + source.slice(end)]));
    }))].slice(0, 32);
  } catch { return []; }
}
