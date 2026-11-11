import { parseMarkdownPositionSyntax } from './markdownPositionMap';
import { blockSpacedMarkdown } from './inactiveDocumentPatch';

export interface SourceBlockInsertionCandidate { markdown: string; from: number; to: number; insert: string }

/** Local syntax scaffolding only; a complete staged-model parse must prove the chosen candidate. */
export function sourceBlockInsertionCandidates(source: string, from: number, to: number, markdown: string) {
  const wrappers: Array<{ from: number; to: number; innerFrom: number; innerTo: number; open: string; close: string }> = [];
  let heading: { from: number; to: number; prefix: string; textFrom: number } | undefined;
  parseMarkdownPositionSyntax(source).iterate({ enter(cursor) {
    const node = cursor.node;
    if (/^ATXHeading[1-6]$/.test(cursor.name) && from >= cursor.from && to <= cursor.to) {
      const prefix = source.slice(cursor.from, cursor.to).match(/^ {0,3}#{1,6}[ \t]+/)?.[0];
      if (prefix) heading = { from: cursor.from, to: cursor.to, prefix, textFrom: cursor.from + prefix.length };
    }
    if (!/^(?:StrongEmphasis|Emphasis|Strikethrough|InlineCode|Link)$/.test(cursor.name)) return;
    const first = node.firstChild;
    if (!first) return;
    let last = node.lastChild;
    if (cursor.name === 'Link') {
      last = first.nextSibling;
      while (last && last.name !== 'LinkMark') last = last.nextSibling;
    }
    if (!last || !(from >= first.to && from <= last.from || to >= first.to && to <= last.from)) return;
    wrappers.push({ from: cursor.from, to: cursor.to, innerFrom: first.to, innerTo: last.from,
      open: source.slice(cursor.from, first.to), close: source.slice(last.from, cursor.to) });
  } });
  const results: SourceBlockInsertionCandidate[] = [];
  const add = (start: number, end: number, close = '', open = '') => {
    if (start === 0 && end === 0 && source.startsWith('\uFEFF')) start = end = 1;
    const closed = source.slice(0, start) + close + open + source.slice(end);
    const lineEnding = source.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const insert = close + blockSpacedMarkdown(closed, start + close.length, start + close.length, markdown).replace(/\r\n|\r|\n/g, lineEnding) + open;
    const result = source.slice(0, start) + insert + source.slice(end);
    if (!results.some(candidate => candidate.markdown === result)) results.push({ markdown: result, from: start, to: end, insert });
  };
  add(from, to);
  if (wrappers.length) {
    const ordered = wrappers.sort((a, b) => a.from - b.from || b.to - a.to);
    const close = [...ordered].reverse().filter(wrapper => from >= wrapper.innerFrom && from <= wrapper.innerTo).map(wrapper => wrapper.close).join('');
    const open = ordered.filter(wrapper => to >= wrapper.innerFrom && to <= wrapper.innerTo).map(wrapper => wrapper.open).join('');
    add(from, to, close, open);
    if (heading && to < heading.to) add(from, to, close, heading.prefix + open);
  } else if (heading && to < heading.to) add(from, to, '', heading.prefix);
  if (from === to) {
    for (const wrapper of wrappers) {
      if (from === wrapper.innerFrom) add(wrapper.from, wrapper.from);
      if (from === wrapper.innerTo) add(wrapper.to, wrapper.to);
    }
    if (heading && from === heading.textFrom) add(heading.from, heading.from);
  }
  return results;
}
