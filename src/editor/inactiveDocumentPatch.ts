import { EditorState } from '@codemirror/state';
import {
  normalizeSourceLineBreaks, parseSourceDocument, rawOffsetToSourceOffset,
  serializeSourceDocument, sourceLineEndingsExtension, sourceLineEndingsField,
} from './sourceLineEndings';
import type { DocumentSourcePatch } from './documentRuntime';
import type { HistoryProjection } from './documentHistory';

export async function inactiveHistorySelection(projection: HistoryProjection, markdown: string) {
  const { historySourceBookmark } = await import('./historySource');
  const raw = await historySourceBookmark(projection, markdown);
  return { anchor: rawOffsetToSourceOffset(markdown, raw.anchor), head: rawOffsetToSourceOffset(markdown, raw.head) };
}

/** Build a local transaction against the latest proven inactive source, never a startup snapshot. */
export function inactiveDocumentPatch(markdown: string, patch: DocumentSourcePatch) {
  if (patch.from < 0 || patch.to < patch.from || patch.to > markdown.length || markdown.slice(patch.from, patch.to) !== patch.expected) {
    throw new Error('原引用或插入范围已变化，已保留当前文档。');
  }
  const parsed = parseSourceDocument(markdown);
  const before = EditorState.create({ doc: parsed.text, extensions: sourceLineEndingsExtension(parsed.lineEndings) });
  const from = rawOffsetToSourceOffset(markdown, patch.from), to = rawOffsetToSourceOffset(markdown, patch.to);
  const insert = normalizeSourceLineBreaks(patch.insert);
  const transaction = before.update({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
  return {
    before: { mode: 'source' as const, doc: before.doc, lineEndings: before.field(sourceLineEndingsField) },
    after: { mode: 'source' as const, doc: transaction.state.doc, lineEndings: transaction.state.field(sourceLineEndingsField) },
    markdown: serializeSourceDocument(transaction.state.doc, transaction.state.field(sourceLineEndingsField)),
    bookmark: { anchor: transaction.state.selection.main.anchor, head: transaction.state.selection.main.head },
  };
}
export function blockSpacedMarkdown(source: string, from: number, to: number, markdown: string) {
  const before = source.slice(0, from), after = source.slice(to);
  const endingsBefore = before.match(/(?:\r\n|\r|\n)+$/)?.[0].match(/\r\n|\r|\n/g)?.length ?? 0;
  const endingsAfter = after.match(/^(?:\r\n|\r|\n)+/)?.[0].match(/\r\n|\r|\n/g)?.length ?? 0;
  const prefix = before.trim() ? '\n'.repeat(Math.max(0, 2 - endingsBefore)) : '';
  const suffix = after.trim() ? '\n'.repeat(Math.max(0, 2 - endingsAfter)) : '';
  return `${prefix}${markdown}${suffix}`;
}
