import type { HistoryProjection, DocumentHistoryRoot, HistoryBookmark } from './documentHistory';
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';

export function historyPmDocumentForSchema(doc: ProseMirrorNode, schema: Schema) {
  // PM roots are immutable; keep unchanged block identities on same-session
  // replay so the view and snapshot caches can reuse their existing work.
  return doc.type.schema === schema ? doc : schema.nodeFromJSON(doc.toJSON());
}

export async function materializeHistoryRoot(root: DocumentHistoryRoot, exactSource?: string) {
  if (exactSource != null) return exactSource;
  if (root.mode === 'source') {
    const { serializeSourceDocument } = await import('./sourceLineEndings');
    return serializeSourceDocument(root.doc, root.lineEndings);
  }
  const { serializePreservedDocument, prepareFineSourcePreservation } = await import('./wysiwygCodec');
  await prepareFineSourcePreservation();
  return serializePreservedDocument(root.doc, root.baseline);
}

export async function historySourceBookmark(projection: HistoryProjection, markdown: string): Promise<HistoryBookmark> {
  const { root, bookmark } = projection;
  if (root.mode === 'source') {
    const { sourceOffsetToRawOffset } = await import('./sourceLineEndings');
    return { anchor: sourceOffsetToRawOffset(markdown, bookmark.anchor), head: sourceOffsetToRawOffset(markdown, bookmark.head) };
  }
  const { captureWysiwygSourceBaseline } = await import('./wysiwygCodec');
  const baseline = root.baseline.doc === root.doc && root.baseline.markdown === markdown
    ? root.baseline : captureWysiwygSourceBaseline(markdown, root.doc);
  if (!baseline.aligned) throw new Error('历史选区的源码范围尚未建立，当前内容已保留。');
  const { createMarkdownPositionMap, pmPositionToSource } = await import('./markdownPositionMap');
  const map = (position: number) => {
    if (position <= 0) return 0;
    if (position >= root.doc.content.size) return markdown.length;
    const index = root.doc.resolve(position).index(0);
    let pmStart = 0, rawStart = baseline.prefix.length;
    for (let i = 0; i < index; i++) { pmStart += root.doc.child(i).nodeSize; rawStart += baseline.blocks[i].source.length + baseline.blocks[i].separator.length; }
    const node = root.doc.child(index), raw = baseline.blocks[index].source;
    if (node.isAtom) return rawStart + (position - pmStart > node.nodeSize / 2 ? raw.length : 0);
    const isolated = root.doc.type.create(root.doc.attrs, node);
    return rawStart + pmPositionToSource(createMarkdownPositionMap(raw, isolated), position - pmStart);
  };
  return { anchor: map(bookmark.anchor), head: map(bookmark.head) };
}

export async function historyPmBookmark(doc: Extract<DocumentHistoryRoot, { mode: 'wysiwyg' }>['doc'], markdown: string, rawBookmark: HistoryBookmark): Promise<HistoryBookmark> {
  const { captureWysiwygSourceBaseline } = await import('./wysiwygCodec');
  const baseline = captureWysiwygSourceBaseline(markdown, doc);
  if (!baseline.aligned) throw new Error('历史源码无法定位到当前视图，当前内容已保留。');
  const { createMarkdownPositionMap, sourcePositionToPm } = await import('./markdownPositionMap');
  const map = (rawPosition: number) => {
    let pmStart = 0, rawStart = baseline.prefix.length;
    for (let i = 0; i < doc.childCount; i++) {
      const block = baseline.blocks[i], node = doc.child(i);
      if (rawPosition <= rawStart + block.source.length + block.separator.length || i === doc.childCount - 1) {
        if (node.isAtom) return pmStart;
        const isolated = doc.type.create(doc.attrs, node);
        return pmStart + sourcePositionToPm(createMarkdownPositionMap(block.source, isolated), Math.max(0, Math.min(block.source.length, rawPosition - rawStart)));
      }
      pmStart += node.nodeSize;
      rawStart += block.source.length + block.separator.length;
    }
    return Math.max(1, doc.content.size - 1);
  };
  return { anchor: map(rawBookmark.anchor), head: map(rawBookmark.head) };
}
