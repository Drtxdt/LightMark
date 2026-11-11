import { DOMParser as ProseMirrorDOMParser, DOMSerializer, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createMarkdownPositionMap, pmPositionToSource, parseMarkdownPositionSyntax, sourcePositionToPm } from './markdownPositionMap';
import { renderMarkdownForEditor } from '../utils/markdown';
import { preserveSourceTransactionProvenance } from './sourceTransactionProvenance';
import { editorHtmlToMarkdown, normalizeCodeLanguage } from './wysiwygCodec';
import { mathAttributeSourceCandidates } from './sourceAtomicPatches';
import { inlineChangeSourceCandidates } from './sourceInlineChangeCandidates';

function sameSemanticNode(left: ProseMirrorNode, right: ProseMirrorNode): boolean {
  if (left.type !== right.type || left.text !== right.text || left.childCount !== right.childCount) return false;
  const attrs = (node: ProseMirrorNode) => Object.fromEntries(Object.entries(node.attrs)
    .filter(([key]) => key !== 'editing' && (!['inlineMath', 'blockMath'].includes(node.type.name) || !['raw', 'originalTex'].includes(key)))
    .map(([key, value]) => [key, key === 'language' && node.type.name === 'codeBlock'
      ? normalizeCodeLanguage(value as string) || value : value]));
  if (JSON.stringify(attrs(left)) !== JSON.stringify(attrs(right)) || left.marks.length !== right.marks.length) return false;
  for (let i = 0; i < left.marks.length; i++) {
    const a = left.marks[i], b = right.marks[i];
    if (a.type !== b.type) return false;
    const attrs = (mark: typeof a) => Object.fromEntries(Object.entries(mark.attrs).filter(([key]) => mark.type.name !== 'code' || key !== 'raw' && key !== 'originalText'));
    if (JSON.stringify(attrs(a)) !== JSON.stringify(attrs(b))) return false;
  }
  for (let i = 0; i < left.childCount; i++) if (!sameSemanticNode(left.child(i), right.child(i))) return false;
  return true;
}
export { sameSemanticNode as sameSourceSemanticNode };

/** An exact text patch is accepted only if parsing it recreates the complete target block. */
export function preserveChangedBlock(source: string, before: ProseMirrorNode, after: ProseMirrorNode): string | null {
  if (sameSemanticNode(before, after)) return source;
  return preserveSourceTransactionProvenance(source, before, after, preserveChangedBlockDirect)
    ?? preserveChangedBlockDirect(source, before, after);
}

function preserveChangedBlockDirect(source: string, before: ProseMirrorNode, after: ProseMirrorNode): string | null {
  if (sameSemanticNode(before, after)) return source;
  const wrapper = before.type.schema.nodes.doc.create(null, before);
  let context = '';
  // Reference definitions may live in a different top-level source block.
  // Recover only definitions already proven by the original PM link attributes.
  try {
    const bindings = createMarkdownPositionMap(source, wrapper);
    parseMarkdownPositionSyntax(source).iterate({ enter(cursor) {
      if (cursor.name !== 'Link') return;
      let label = cursor.node.lastChild;
      if (label?.name !== 'LinkLabel') return;
      const key = source.slice(label.from, label.to).replace(/^\[|\]$/g, '');
      const start = cursor.node.firstChild?.to;
      if (start == null) return;
      const position = sourcePositionToPm(bindings, start);
      const link = wrapper.nodeAt(position)?.marks.find(mark => mark.type.name === 'link');
      if (link && key) context += `\n\n[${key}]: <${String(link.attrs.href).replace(/>/g, '%3E')}>${link.attrs.title ? ` "${String(link.attrs.title).replace(/"/g, '\\"')}"` : ''}`;
    } });
  } catch { /* A structural candidate may still establish a new mapping. */ }
  const accepts = (candidate: string) => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdownForEditor(candidate + context);
    const parsed = ProseMirrorDOMParser.fromSchema(after.type.schema).parse(container);
    return Boolean(parsed.firstChild && sameSemanticNode(parsed.firstChild, after)
      && (parsed.childCount === 1 || parsed.childCount === 2 && parsed.lastChild?.type.name === 'paragraph' && parsed.lastChild.content.size === 0));
  };
  for (const candidate of [...structuralCandidates(source, before, after), ...mathAttributeSourceCandidates(source, before, after)]) if (accepts(candidate)) return candidate;
  // A mounted editor canonicalizes language aliases (text -> plaintext).
  // That metadata change can share an edge with text input; compare the same
  // semantic attributes as candidate validation, while leaving content empty.
  if (!sameSemanticNode(before.copy(), after.copy())) return null;
  const richCandidate = () => inlineChangeSourceCandidates(source, before, after, fragment => {
    const container = document.createElement('div');
    container.appendChild(DOMSerializer.fromSchema(after.type.schema).serializeFragment(fragment));
    return editorHtmlToMarkdown(container.innerHTML);
  }).find(accepts) ?? null;
  const from = before.content.findDiffStart(after.content);
  const end = before.content.findDiffEnd(after.content);
  if (from == null || !end) return null;
  const a = Math.max(from, end.a), b = Math.max(from, end.b);
  const replacementSlice = after.slice(from, b);
  const replacement = replacementSlice.content;
  let inserted = '', valid = true, code = before.type.name === 'codeBlock';
  replacement.forEach(node => {
    if (!node.isText) valid = false;
    else { inserted += node.text; code ||= node.marks.some(mark => mark.type.name === 'code'); }
  });
  if (!valid || /[\r\n]/.test(inserted)) return richCandidate();
  try {
    const bindings = createMarkdownPositionMap(source, wrapper);
    // Keep literal punctuation literal. Code uses its existing enclosing delimiter.
    const literal = code ? inserted : inserted.replace(/([\\`*_[\]{}<>!#|~^=$])/g, '\\$1');
    // At a mark boundary the same PM position has two valid source positions.
    // Try both; only the candidate preserving the actual target marks is accepted.
    for (const affinity of [1, -1] as const) {
      const rawFrom = pmPositionToSource(bindings, from + 1, affinity);
      const rawTo = a === from ? rawFrom : pmPositionToSource(bindings, a + 1, -1);
      if (rawTo < rawFrom) continue;
      const candidate = source.slice(0, rawFrom) + literal + source.slice(rawTo);
      if (accepts(candidate)) return candidate;
    }
    const rich = richCandidate();
    if (rich != null) return rich;
    for (const candidate of markCandidates(source, before, after)) if (accepts(candidate)) return candidate;
    return null;
  } catch { return null; }
}

function structuralCandidates(source: string, before: ProseMirrorNode, after: ProseMirrorNode): string[] {
  const candidates: string[] = [];
  if (before.type.name === 'heading' && after.type.name === 'heading' && before.content.eq(after.content)) {
    if (/^ {0,3}#{1,6}[ \t]/.test(source)) candidates.push(source.replace(/^( {0,3})#{1,6}(?=[ \t])/, `$1${'#'.repeat(after.attrs.level)}`));
    else if (/\r?\n[ \t]*[=-]+[ \t]*$/.test(source) && after.attrs.level <= 2) candidates.push(source.replace(/([=-])(?=[=-]*[ \t]*$)/g, after.attrs.level === 1 ? '=' : '-'));
  }
  // A task toggle changes its marker, never the item's prose or surrounding indent.
  if (before.textContent === after.textContent && /\[[ xX]\]/.test(source)) {
    const oldTasks: boolean[] = [], nextTasks: boolean[] = [];
    before.descendants(node => { if (node.type.name === 'taskItem') oldTasks.push(Boolean(node.attrs.checked)); });
    after.descendants(node => { if (node.type.name === 'taskItem') nextTasks.push(Boolean(node.attrs.checked)); });
    if (oldTasks.length && oldTasks.length === nextTasks.length) {
      let index = 0;
      candidates.push(source.replace(/(^[ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/gm, (raw, prefix) => {
        const i = index++;
        return i < oldTasks.length && oldTasks[i] !== nextTasks[i] ? `${prefix}[${nextTasks[i] ? 'x' : ' '}]` : raw;
      }));
    }
    const oldMarks = markRanges(before).filter(range => range.mark.type.name === 'taskState');
    const nextMarks = markRanges(after).filter(range => range.mark.type.name === 'taskState');
    const markers: Array<{ from: number; to: number }> = [];
    parseMarkdownPositionSyntax(source).iterate({ enter(cursor) { if (cursor.name === 'TaskMarker') markers.push({ from: cursor.from, to: cursor.to }); } });
    if (oldMarks.length && markers.length === oldMarks.length && oldMarks.length === nextMarks.length) {
      let candidate = source;
      for (let i = markers.length - 1; i >= 0; i--) {
        if (oldMarks[i].mark.attrs.state === nextMarks[i].mark.attrs.state) continue;
        candidate = candidate.slice(0, markers[i].from) + `[${nextMarks[i].mark.attrs.state === 'checked' ? 'x' : ' '}]` + candidate.slice(markers[i].to);
      }
      candidates.push(candidate);
    }
  }
  if (before.type.name === 'table' && after.type.name === 'table' && before.childCount === after.childCount
    && before.textContent === after.textContent && before.firstChild?.childCount === after.firstChild?.childCount) {
    const count = after.firstChild!.childCount;
    const alignments = Array.from({ length: count }, (_, index) => after.firstChild!.child(index).attrs.textAlign);
    parseMarkdownPositionSyntax(source).iterate({ enter(cursor) {
      if (cursor.name !== 'TableDelimiter' || !source.slice(cursor.from, cursor.to).includes('-')) return;
      let index = 0;
      const divider = source.slice(cursor.from, cursor.to).replace(/:?-+:?/g, value => {
        const alignment = alignments[index++], dashes = value.replace(/:/g, '');
        return `${alignment === 'left' || alignment === 'center' ? ':' : ''}${dashes}${alignment === 'right' || alignment === 'center' ? ':' : ''}`;
      });
      if (index === count) candidates.push(source.slice(0, cursor.from) + divider + source.slice(cursor.to));
    } });
  }
  const lists = (node: ProseMirrorNode) => {
    const result: ProseMirrorNode[] = [];
    if (/^(?:bulletList|orderedList)$/.test(node.type.name)) result.push(node);
    node.descendants(child => { if (/^(?:bulletList|orderedList)$/.test(child.type.name)) result.push(child); });
    return result;
  };
  if (before.textContent === after.textContent) {
    const oldLists = lists(before), nextLists = lists(after);
    const syntaxLists: Array<{ items: Array<{ from: number; to: number }> }> = [];
    parseMarkdownPositionSyntax(source).iterate({ enter(cursor) {
      if (cursor.name !== 'BulletList' && cursor.name !== 'OrderedList') return;
      const items: Array<{ from: number; to: number }> = [];
      for (let item = cursor.node.firstChild; item; item = item.nextSibling) {
        if (item.name !== 'ListItem') continue;
        const marker = item.firstChild;
        if (marker?.name === 'ListMark') items.push({ from: marker.from, to: marker.to });
      }
      syntaxLists.push({ items });
    } });
    if (oldLists.length && oldLists.length === nextLists.length && syntaxLists.length === oldLists.length) {
      const patches: Array<{ from: number; to: number; text: string }> = [];
      oldLists.forEach((old, index) => {
        const next = nextLists[index];
        if (old.type === next.type && old.attrs.start === next.attrs.start || old.childCount !== next.childCount) return;
        syntaxLists[index].items.forEach((marker, childIndex) => {
          const oldMarker = source.slice(marker.from, marker.to);
          const text = next.type.name === 'bulletList' ? '-'
            : `${Number(next.attrs.start ?? 1) + childIndex}${oldMarker.endsWith(')') ? ')' : '.'}`;
          patches.push({ ...marker, text });
        });
      });
      let candidate = source;
      for (const patch of patches.sort((a, b) => b.from - a.from)) candidate = candidate.slice(0, patch.from) + patch.text + candidate.slice(patch.to);
      if (patches.length) candidates.push(candidate);
    }
  }
  return candidates;
}

type MarkRange = { from: number; to: number; mark: import('@tiptap/pm/model').Mark };
function markRanges(node: ProseMirrorNode) {
  const ranges: MarkRange[] = [];
  const latest = new Map<string, MarkRange>();
  const keys = new WeakMap<import('@tiptap/pm/model').Mark, string>();
  node.descendants((child, pos) => {
    if (!child.isInline) return;
    for (const mark of child.marks) {
      let key = keys.get(mark);
      if (!key) { key = `${mark.type.name}:${JSON.stringify(mark.attrs)}`; keys.set(mark, key); }
      const previous = latest.get(key);
      if (previous?.to === pos) previous.to += child.nodeSize;
      else { const range = { from: pos, to: pos + child.nodeSize, mark }; ranges.push(range); latest.set(key, range); }
    }
  });
  return ranges;
}
function markCandidates(source: string, before: ProseMirrorNode, after: ProseMirrorNode): string[] {
  if (before.textContent !== after.textContent || before.content.size !== after.content.size) return [];
  const original = markRanges(before), target = markRanges(after);
  const added = target.filter(range => !original.some(old => old.from === range.from && old.to === range.to && old.mark.eq(range.mark)));
  const removed = original.filter(range => !target.some(next => next.from === range.from && next.to === range.to && next.mark.eq(range.mark)));
  if (added.length + removed.length > 16) return [];
  const bindings = createMarkdownPositionMap(source, before.type.schema.nodes.doc.create(null, before));
  type Patch = { from: number; to: number; insert: string };
  let variants: Patch[][] = [[]];
  const delimiters: Record<string, string[]> = { bold: ['**', '__'], italic: ['*', '_'], strike: ['~~'], highlight: ['=='], superscript: ['^'], subscript: ['~'] };
  for (const [ranges, remove] of [[removed, true], [added, false]] as const) for (const range of ranges) {
    const from = pmPositionToSource(bindings, range.from + 1, 1), to = pmPositionToSource(bindings, range.to + 1, -1);
    const choices: Patch[][] = [];
    if (range.mark.type.name === 'link') {
      if (remove) {
        parseMarkdownPositionSyntax(source).iterate({ enter(cursor) {
          if (cursor.name !== 'Link') return;
          const opening = cursor.node.firstChild;
          let closing = opening?.nextSibling;
          while (closing && closing.name !== 'LinkMark') closing = closing.nextSibling;
          if (opening?.to === from && closing?.from === to) choices.push([
            { from: cursor.from, to: from, insert: '' }, { from: to, to: cursor.to, insert: '' },
          ]);
        } });
      } else {
        const href = String(range.mark.attrs.href || '').replace(/[<>\r\n]/g, character => encodeURIComponent(character));
        const title = range.mark.attrs.title ? ` "${String(range.mark.attrs.title).replace(/["\\]/g, '\\$&')}"` : '';
        choices.push([{ from, to: from, insert: '[' }, { from: to, to, insert: `](<${href}>${title})` }]);
      }
    }
    if (range.mark.type.name === 'code') {
      const text = after.textBetween(range.from, range.to);
      if (remove) {
        parseMarkdownPositionSyntax(source).iterate({ enter(cursor) {
          if (cursor.name !== 'InlineCode' || cursor.from > from || cursor.to < to) return;
          choices.push([{ from: cursor.from, to: cursor.to, insert: text.replace(/([\\`*_[\]{}<>!#|~^=$])/g, '\\$1') }]);
        } });
      } else {
        const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
        const delimiter = '`'.repeat(longest + 1);
        const padding = text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text) ? ' ' : '';
        choices.push([{ from, to, insert: `${delimiter}${padding}${text}${padding}${delimiter}` }]);
      }
    }
    const styles = delimiters[range.mark.type.name] ?? [];
    const containing = original.find(old => old.mark.eq(range.mark) && old.from <= range.from && old.to >= range.to);
    const originalStart = containing ? pmPositionToSource(bindings, containing.from + 1, 1) : from;
    const preferred = styles.find(style => source.slice(originalStart - style.length, originalStart) === style);
    const orderedStyles = preferred ? [preferred, ...styles.filter(style => style !== preferred)] : styles;
    for (const delimiter of orderedStyles) {
      if (remove) {
        if (source.slice(from - delimiter.length, from) === delimiter && source.slice(to, to + delimiter.length) === delimiter) choices.push([
          { from: from - delimiter.length, to: from, insert: '' }, { from: to, to: to + delimiter.length, insert: '' },
        ]);
      } else choices.push([{ from, to: from, insert: delimiter }, { from: to, to, insert: delimiter }]);
    }
    if (!choices.length) return [];
    variants = variants.flatMap(existing => choices.map(choice => [...existing, ...choice])).slice(0, 32);
  }
  return variants.flatMap(patches => {
    const sorted = patches.sort((a, b) => a.from - b.from || a.to - b.to);
    if (sorted.some((patch, i) => i && patch.from < sorted[i - 1].to)) return [];
    let candidate = source;
    for (const patch of sorted.reverse()) candidate = candidate.slice(0, patch.from) + patch.insert + candidate.slice(patch.to);
    return [candidate];
  });
}
