import type { EditorState } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { extractAssetReferences, type AssetSyntax } from '../utils/documentAssets';
import type { DocumentSourcePatch } from './documentRuntime';
import type { NativeCommandAnchor } from './pendingDocumentCommands';

type Candidate = { pos: number; node: ProseMirrorNode; to?: number; html?: string; from?: number; end?: number };
function candidatesFor(doc: ProseMirrorNode, source: string, syntax: AssetSyntax) {
  const candidates: Candidate[] = [];
  doc.descendants((node, pos) => {
    if (syntax === 'markdown-image' || syntax === 'lightmark-figure') {
      if (node.type.name === 'image' && (node.attrs.markdownSrc || node.attrs.src) === source) candidates.push({ pos, node });
    } else if (syntax === 'markdown-link' && node.isInline && !node.marks.some(mark => mark.type.name === 'code')) {
      if (node.marks.some(mark => mark.type.name === 'link' && mark.attrs.href === source)) {
        const previous = candidates.at(-1);
        if (previous?.to === pos) previous.to = pos + node.nodeSize;
        else candidates.push({ pos, to: pos + node.nodeSize, node });
      }
    } else if (syntax === 'html' && typeof node.attrs.html === 'string') {
      for (const reference of extractAssetReferences(node.attrs.html)) {
        if (reference.source === source) candidates.push({ pos, node, html: node.attrs.html, from: reference.from, end: reference.to });
      }
      return false;
    }
    return true;
  });
  return candidates;
}
export function captureAssetReferenceBookmark(state: Pick<EditorState, 'doc'>, markdown: string, patch: Pick<DocumentSourcePatch, 'from' | 'to' | 'expected'>): NativeCommandAnchor {
  const references = extractAssetReferences(markdown);
  const reference = references.find(item => item.from === patch.from && item.to === patch.to && item.source === patch.expected);
  if (!reference) throw new Error('该源码范围不是可安全重链的资源引用。');
  const peers = references.filter(item => item.source === reference.source && item.syntax === reference.syntax);
  const candidates = candidatesFor(state.doc, reference.source, reference.syntax);
  const candidate = candidates[peers.indexOf(reference)];
  if (candidates.length !== peers.length || !candidate) throw new Error('资源源码与编辑节点无法唯一对应，请切换源码模式重链。');
  return {
    from: candidate.pos, to: candidate.to ?? candidate.pos + candidate.node.nodeSize,
    binding: { syntax: reference.syntax, expected: reference.source, nodeType: candidate.node.type.name,
      ...(candidate.html != null ? { html: candidate.html, htmlFrom: candidate.from!, htmlTo: candidate.end! } : {}) },
  };
}
export function validateAssetReferenceBookmark(doc: ProseMirrorNode, anchor: NativeCommandAnchor) {
  const binding = anchor.binding;
  if (!binding || anchor.from < 0 || anchor.to > doc.content.size) return false;
  if (binding.syntax === 'markdown-link') {
    let count = 0, valid = true;
    doc.nodesBetween(anchor.from, anchor.to, node => {
      if (!node.isInline) return;
      count++;
      if (!node.marks.some(mark => mark.type.name === 'link' && mark.attrs.href === binding.expected)) valid = false;
    });
    return valid && count > 0;
  }
  const node = doc.nodeAt(anchor.from);
  if (!node || node.type.name !== binding.nodeType) return false;
  return binding.syntax === 'html' ? node.attrs.html === binding.html
    : (node.attrs.markdownSrc || node.attrs.src) === binding.expected;
}
export function projectAssetReferenceBookmark(state: Pick<EditorState, 'doc'>, markdown: string, anchor: NativeCommandAnchor) {
  if (!validateAssetReferenceBookmark(state.doc, anchor)) throw new Error('原引用已修改或删除，请刷新资源列表。');
  const binding = anchor.binding!;
  const candidates = candidatesFor(state.doc, String(binding.expected), binding.syntax as AssetSyntax);
  const index = candidates.findIndex(item => (binding.syntax === 'markdown-link' ? item.pos <= anchor.from && item.to! >= anchor.to : item.pos === anchor.from && (item.to ?? item.pos + item.node.nodeSize) === anchor.to)
    && (binding.syntax !== 'html' || item.from === binding.htmlFrom && item.end === binding.htmlTo));
  const peers = extractAssetReferences(markdown).filter(item => item.source === binding.expected && item.syntax === binding.syntax);
  if (index < 0 || candidates.length !== peers.length) throw new Error('无法证明原引用的源码位置，已保留新输入，请刷新资源列表。');
  const reference = peers[index];
  return { from: reference.from, to: reference.to, expected: reference.source };
}
export function assetBookmarkTransaction(state: EditorState, anchor: NativeCommandAnchor, insert: string, resolveImageSource: (source: string) => string = source => source) {
  if (!validateAssetReferenceBookmark(state.doc, anchor)) throw new Error('原引用已修改或删除，请刷新资源列表。');
  const binding = anchor.binding!, node = state.doc.nodeAt(anchor.from)!;
  if (binding.syntax === 'markdown-link') {
    const mark = node.marks.find(item => item.type.name === 'link' && item.attrs.href === binding.expected)!;
    const candidate = candidatesFor(state.doc, String(binding.expected), 'markdown-link').find(item => item.pos <= anchor.from && item.to! >= anchor.to);
    if (!candidate) throw new Error('原链接范围已变化，已保留新输入。');
    return state.tr.removeMark(candidate.pos, candidate.to!, mark.type).addMark(candidate.pos, candidate.to!, mark.type.create({ ...mark.attrs, href: insert }));
  }
  const attrs = binding.syntax === 'html'
    ? { ...node.attrs, html: String(binding.html).slice(0, Number(binding.htmlFrom)) + insert + String(binding.html).slice(Number(binding.htmlTo)) }
    : { ...node.attrs, src: resolveImageSource(insert), ...('markdownSrc' in node.attrs ? { markdownSrc: insert } : {}) };
  return state.tr.setNodeMarkup(anchor.from, undefined, attrs, node.marks);
}
/** Replace an asset attribute/mark without rebuilding the surrounding document. */
export function assetReferenceTransaction(state: EditorState, markdown: string, patch: DocumentSourcePatch, resolveImageSource: (source: string) => string = source => source) {
  return assetBookmarkTransaction(state, captureAssetReferenceBookmark(state, markdown, patch), patch.insert, resolveImageSource);
}
