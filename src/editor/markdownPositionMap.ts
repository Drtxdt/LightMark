import { markdownLanguage } from '@codemirror/lang-markdown';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { decodeHtmlEntities } from '../utils/html';
import { parseMarkdownMath } from '../utils/mathMarkdown';
type RawSyntaxNode = ReturnType<typeof markdownLanguage.parser.parse>['topNode'];
type SyntaxNode = { name: string; from: number; to: number; firstChild: SyntaxNode | null; lastChild: SyntaxNode | null; nextSibling: SyntaxNode | null };
type PositionCursor = { name: string; from: number; to: number; node: SyntaxNode };
export function parseMarkdownPositionSyntax(source: string) {
  const extra: number[] = [];
  let delta = 0;
  const normalized = source.replace(/\r\n|\r/g, (value, offset: number) => {
    if (value.length === 2) { extra.push(offset - delta + 1); delta++; }
    return '\n';
  });
  const toRaw = (position: number) => {
    let low = 0, high = extra.length;
    while (low < high) { const mid = (low + high) >>> 1; if (extra[mid] <= position) low = mid + 1; else high = mid; }
    return position + low;
  };
  const wrap = (node: RawSyntaxNode | null): SyntaxNode | null => node && ({
    name: node.name, from: toRaw(node.from), to: toRaw(node.to),
    get firstChild() { return wrap(node.firstChild); }, get lastChild() { return wrap(node.lastChild); }, get nextSibling() { return wrap(node.nextSibling); },
  });
  const tree = markdownLanguage.parser.parse(normalized);
  return { iterate(visitor: { enter(cursor: PositionCursor): boolean | void }) {
    tree.iterate({ enter(cursor) { const node = wrap(cursor.node)!; return visitor.enter({ name: node.name, from: node.from, to: node.to, node }); } });
  } };
}

export type SourceBinding = Readonly<{ rawFrom: number; rawTo: number; pmFrom: number; pmTo: number; linear: boolean }>;
type Unit = { from: number; to: number; text?: string; atom?: string; linear: boolean };
const hidden = /^(?:HeaderMark|EmphasisMark|StrikethroughMark|SuperscriptMark|SubscriptMark|CodeMark|LinkMark|LinkLabel|URL|LinkTitle|TaskMarker|ListMark|QuoteMark|TableDelimiter|CodeInfo)$/;
const inlineContainer = /^(?:Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableCell|Task|CodeText)$/;

/** Parser-backed source/PM mapping. A mismatch rejects the mapping rather than guessing. */
export function createMarkdownPositionMap(source: string, doc: ProseMirrorNode): readonly SourceBinding[] {
  const raw: Unit[] = [];
  const pm: Unit[] = [];
  const math = parseMarkdownMath(source).tokens;
  const literalInlineCode = new Map<string, string>();
  doc.descendants(node => {
    for (const mark of node.marks) {
      if (mark.type.name === 'code' && typeof mark.attrs.raw === 'string' && mark.attrs.raw
        && typeof mark.attrs.originalText === 'string') literalInlineCode.set(mark.attrs.raw, mark.attrs.originalText);
    }
  });
  const emittedMath = new Set<number>();
  const hiddenHighlight: Array<{ from: number; to: number }> = [];
  // Wiki links are rendered by LightMark after Markdown parsing. Lezer sees
  // their inner brackets as an ordinary Link and leaves the outer pair text.
  // Map the same visible page/heading spelling without counting that syntax.
  for (const match of source.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const body = match[1], start = match.index! + 2;
    const hash = body.indexOf('#'), pagePart = hash < 0 ? body : body.slice(0, hash);
    if (!pagePart.trim()) continue;
    const pageFrom = start + pagePart.length - pagePart.trimStart().length;
    const pageTo = start + pagePart.trimEnd().length;
    hiddenHighlight.push({ from: match.index!, to: pageFrom });
    if (hash < 0 || !body.slice(hash + 1).split('#', 1)[0].trim()) {
      hiddenHighlight.push({ from: pageTo, to: match.index! + match[0].length });
      continue;
    }
    const headingPart = body.slice(hash + 1).split('#', 1)[0];
    const headingFrom = start + hash + 1 + headingPart.length - headingPart.trimStart().length;
    const headingTo = start + hash + 1 + headingPart.trimEnd().length;
    hiddenHighlight.push({ from: pageTo, to: start + hash }, { from: start + hash + 1, to: headingFrom },
      { from: headingTo, to: match.index! + match[0].length });
  }
  for (const match of source.matchAll(/==([^=\n]+)==/g)) {
    const from = match.index!;
    let escapes = 0;
    for (let i = from - 1; i >= 0 && source[i] === '\\'; i--) escapes++;
    if (escapes % 2) continue;
    hiddenHighlight.push({ from, to: from + 2 }, { from: from + match[0].length - 2, to: from + match[0].length });
  }
  hiddenHighlight.sort((a, b) => a.from - b.from || a.to - b.to);
  const append = (units: Unit[], unit: Unit) => {
    const previous = units.at(-1);
    if (previous?.text === ' ' && unit.text === ' ') {
      previous.to = unit.to;
      previous.linear = previous.to - previous.from === 1;
    } else if (previous?.text != null && unit.text != null && previous.linear && unit.linear && previous.to === unit.from) {
      previous.text += unit.text;
      previous.to = unit.to;
    } else units.push(unit);
  };
  const containingMath = (offset: number) => {
    let low = 0, high = math.length;
    while (low < high) { const mid = (low + high) >>> 1; if (math[mid].to <= offset) low = mid + 1; else high = mid; }
    return math[low];
  };
  const literal = (from: number, to: number, units: Unit[], code = false) => {
    while (from < to) {
      const hidden = code ? undefined : hiddenHighlight.find(range => range.to > from);
      if (hidden && hidden.from <= from) { from = Math.min(to, hidden.to); continue; }
      const token = code ? undefined : containingMath(from);
      if (token && token.from <= from) {
        if (!emittedMath.has(token.from)) {
          append(units, { from: token.from, to: token.to, atom: token.kind === 'inline' ? 'inlineMath' : 'blockMath', linear: false });
          emittedMath.add(token.from);
        }
        from = token.to;
        continue;
      }
      const end = Math.min(to, token?.from ?? to, hidden?.from ?? to);
      const text = source.slice(from, end);
      if (code) {
        for (const match of text.matchAll(/\r\n|\r|\n|[^\r\n]+/g)) {
          const start = from + match.index!;
          append(units, { from: start, to: start + match[0].length, text: /^[\r\n]/.test(match[0]) ? '\n' : match[0], linear: match[0] !== '\r\n' && match[0] !== '\r' });
        }
      }
      else {
        for (const match of text.matchAll(/[ \t\r\n]+|[^ \t\r\n]+/g)) {
          const start = from + match.index!;
          const whitespace = /^[ \t\r\n]+$/.test(match[0]);
          append(units, { from: start, to: start + match[0].length, text: whitespace ? ' ' : match[0], linear: !whitespace || match[0].length === 1 });
        }
      }
      from = end;
    }
  };
  const inline = (node: SyntaxNode, units: Unit[], code = false) => {
    if (node.name === 'HardBreak') {
      append(units, { from: node.from, to: node.to, atom: 'hardBreak', linear: false }); return;
    }
    const overlappingMath = !code && containingMath(node.from);
    if (overlappingMath && overlappingMath.from <= node.from && overlappingMath.to >= node.to) {
      literal(node.from, node.to, units);
      return;
    }
    if (node.name === 'Image') {
      append(units, { from: node.from, to: node.to, atom: 'image', linear: false }); return;
    }
    if (node.name === 'Link' && /^\[\^[^\]\n]+\]$/.test(source.slice(node.from, node.to))) {
      append(units, { from: node.from, to: node.to, atom: 'footnoteRef', linear: false }); return;
    }
    if (node.name === 'Escape') {
      const text = source.slice(node.from + 1, node.to);
      append(units, text === '$'
        ? { from: node.from, to: node.to, atom: 'escapedDollar', linear: false }
        : { from: node.from, to: node.to, text, linear: false }); return;
    }
    if (node.name === 'Entity') {
      append(units, { from: node.from, to: node.to, text: decodeHtmlEntities(source.slice(node.from, node.to)), linear: false }); return;
    }
    if (node.name === 'HTMLTag') {
      append(units, { from: node.from, to: node.to, atom: 'inlineHtml', linear: false }); return;
    }
    if (node.name === 'InlineCode') {
      const children: SyntaxNode[] = [];
      for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
      const from = children[0]?.to ?? node.from, to = children.at(-1)?.from ?? node.to;
      let value = source.slice(from, to).replace(/\r\n|\r|\n/g, ' ');
      let padding = 0;
      const preserved = literalInlineCode.get(source.slice(node.from, node.to));
      if (preserved === value) { /* Production literal-code marks retain their source padding. */ }
      else if (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value)) { value = value.slice(1, -1); padding = 1; }
      const rawFrom = from + padding, rawTo = to - padding;
      for (const match of source.slice(rawFrom, rawTo).matchAll(/\r\n|\r|\n|[^\r\n]+/g)) {
        const start = rawFrom + match.index!;
        const lineEnding = /^[\r\n]/.test(match[0]);
        append(units, { from: start, to: start + match[0].length, text: lineEnding ? ' ' : match[0], linear: match[0].length === 1 || !lineEnding });
      }
      return;
    }
    if (node.name === 'Autolink') { literal(node.from + 1, node.to - 1, units); return; }
    if (hidden.test(node.name)) return;
    let cursor = node.from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      literal(cursor, child.from, units, code);
      inline(child, units, code);
      cursor = child.to;
    }
    literal(cursor, node.to, units, code);
  };
  const tree = parseMarkdownPositionSyntax(source);
  tree.iterate({ enter(node) {
    if (!inlineContainer.test(node.name)) return;
    const units: Unit[] = [];
    if (node.name === 'CodeText' && source[node.to - 1] === '\r' && source[node.to] === '\n') {
      // Lezer excludes the structural LF before a closing fence but includes
      // its CR. MarkdownIt removes that same complete structural CRLF.
      literal(node.from, node.to - 1, units, true);
    } else inline(node.node, units, node.name === 'CodeText');
    if (node.name !== 'CodeText') {
      const first = units[0], last = units.at(-1);
      if (first?.text?.startsWith(' ')) {
        if (first.text === ' ') units.shift();
        else { first.text = first.text.slice(1); first.from++; }
      }
      if (last?.text?.endsWith(' ')) {
        if (last.text === ' ') { if (units.at(-1) === last) units.pop(); }
        else { last.text = last.text.slice(0, -1); last.to--; }
      }
    }
    raw.push(...units);
    return false;
  } });
  doc.descendants((node, pos) => {
    if (node.isText) { pm.push({ from: pos, to: pos + node.nodeSize, text: node.text!, linear: true }); return false; }
    if (node.isAtom && node.type.name !== 'paragraph') {
      pm.push({ from: pos, to: pos + node.nodeSize, atom: node.type.name, linear: false }); return false;
    }
    return true;
  });
  const bindings: SourceBinding[] = [];
  let r = 0, p = 0, ri = 0, pi = 0;
  while (r < raw.length && p < pm.length) {
    const a = raw[r], b = pm[p];
    if (a.atom || b.atom) {
      if (a.atom !== b.atom || ri || pi) throw new Error(`源码原子节点无法对应：${a.atom ?? a.text} / ${b.atom ?? b.text}`);
      bindings.push({ rawFrom: a.from, rawTo: a.to, pmFrom: b.from, pmTo: b.to, linear: false }); r++; p++; continue;
    }
    const length = Math.min(a.text!.length - ri, b.text!.length - pi);
    if (a.text!.slice(ri, ri + length) !== b.text!.slice(pi, pi + length)) throw new Error('源码文本与文档模型不一致，已拒绝位置猜测。');
    if (!a.linear && (ri !== 0 || length !== a.text!.length)) throw new Error('解码字符跨越多个模型片段，无法安全映射。');
    bindings.push({ rawFrom: a.linear ? a.from + ri : a.from, rawTo: a.linear ? a.from + ri + length : a.to, pmFrom: b.from + pi, pmTo: b.from + pi + length, linear: a.linear });
    ri += length; pi += length;
    if (ri === a.text!.length) { r++; ri = 0; }
    if (pi === b.text!.length) { p++; pi = 0; }
  }
  if (r !== raw.length || p !== pm.length) throw new Error('源码与文档片段数量不一致，已保留原始内容。');
  return bindings;
}

export function pmPositionToSource(bindings: readonly SourceBinding[], position: number, affinity: -1 | 1 = 1) {
  const right = bindings.findIndex(span => span.pmTo >= position);
  if (right < 0) return bindings.at(-1)?.rawTo ?? 0;
  let span = bindings[right];
  if (position === span.pmTo && affinity > 0 && bindings[right + 1]?.pmFrom === position) span = bindings[right + 1];
  if (position <= span.pmFrom) return span.rawFrom;
  if (position >= span.pmTo) return span.rawTo;
  if (!span.linear) throw new Error('位置落在不可分割的源码节点内部。');
  return span.rawFrom + position - span.pmFrom;
}

export function sourcePositionToPm(bindings: readonly SourceBinding[], position: number, affinity: -1 | 1 = 1) {
  const index = bindings.findIndex(span => span.rawTo >= position);
  if (index < 0) return bindings.at(-1)?.pmTo ?? 1;
  const span = bindings[index];
  if (position < span.rawFrom) return affinity < 0 && index > 0 ? bindings[index - 1].pmTo : span.pmFrom;
  if (position === span.rawTo) return span.pmTo;
  return span.linear ? span.pmFrom + position - span.rawFrom : affinity < 0 ? span.pmFrom : span.pmTo;
}
