import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { StepMap } from '@tiptap/pm/transform';
import { applySourcePiecePatchBatch, createSourcePieceState, materializeSourcePiece } from './sourcePieceState';

type Edge = Readonly<{ before: ProseMirrorNode; depth: number }>;
const previousByNode = new WeakMap<ProseMirrorNode, Edge>();
const knownNodes = new WeakSet<ProseMirrorNode>();
const exactSourceByNode = new WeakMap<ProseMirrorNode, string>();
const unavailableByNode = new WeakMap<ProseMirrorNode, string>();
const MAX_PENDING_DEPTH = 4096;
let sequence = 0;
const counters = { transitions: 0, blocks: 0, materializations: 0, piecePatches: 0 };

export class SourceProvenanceUnavailableError extends Error {
  constructor(reason: string) { super(`源码保真状态需要恢复：${reason}。当前输入仍保留，已阻止覆盖原始源码。`); this.name = 'SourceProvenanceUnavailableError'; }
}
export function sourceProvenanceDepth(node: ProseMirrorNode) { return previousByNode.get(node)?.depth ?? 0; }

export function sourceProvenanceDiagnostics() { return { ...counters }; }

function blockIndex(doc: ProseMirrorNode, position: number) {
  return Math.min(doc.childCount - 1, doc.resolve(Math.max(0, Math.min(position, doc.content.size))).index(0));
}
function changedIndexes(before: ProseMirrorNode, after: ProseMirrorNode, map: StepMap, hint?: { from?: number; to?: number; pos?: number }) {
  const indexes = new Set<number>();
  const add = (doc: ProseMirrorNode, from: number, to: number) => {
    if (!doc.childCount) return;
    const first = blockIndex(doc, from), last = blockIndex(doc, to);
    for (let index = first; index <= last; index++) indexes.add(index);
  };
  map.forEach((from, to, newFrom, newTo) => { add(before, from, to); add(after, newFrom, newTo); });
  if (!indexes.size && hint) {
    const from = hint.from ?? hint.pos;
    if (from != null) { add(before, from, hint.to ?? from); add(after, from, hint.to ?? from); }
  }
  return indexes;
}
function link(before: ProseMirrorNode, after: ProseMirrorNode) {
  knownNodes.add(before);
  if (before === after || knownNodes.has(after)) return;
  knownNodes.add(after);
  const depth = (previousByNode.get(before)?.depth ?? 0) + 1;
  const unavailable = unavailableByNode.get(before);
  if (unavailable || depth > MAX_PENDING_DEPTH) unavailableByNode.set(after, unavailable ?? '局部变更超过安全定位上限');
  else { previousByNode.set(after, Object.freeze({ before, depth })); counters.blocks++; }
}
function recordPair(before: ProseMirrorNode, after: ProseMirrorNode, indexes: Iterable<number>) {
  const touched: Array<{ index: number; node: ProseMirrorNode }> = [];
  if (before.childCount !== after.childCount) return touched;
  for (const index of indexes) if (index >= 0 && index < before.childCount) { link(before.child(index), after.child(index)); touched.push({ index, node: after.child(index) }); }
  return touched;
}

/** Immutable model edges only: no Markdown parsing, DOM, whole-source string or view enters the input path. */
export function recordSourceTransactionProvenance(before: ProseMirrorNode, after: ProseMirrorNode, transaction: Transaction) {
  counters.transitions++;
  if (before === transaction.before && after === transaction.doc) {
    const touched: Array<{ index: number; node: ProseMirrorNode }> = [];
    transaction.steps.forEach((step, index) => {
      const oldDoc = transaction.docs[index], newDoc = transaction.docs[index + 1] ?? transaction.doc;
      touched.push(...recordPair(oldDoc, newDoc, changedIndexes(oldDoc, newDoc, step.getMap(), step as { from?: number; to?: number; pos?: number })));
    });
    return touched;
  }
  // Presentation syntax changes PM offsets inside a block. Top-level block indexes
  // remain meaningful, while the immutable endpoints are the canonical models.
  if (before.childCount !== transaction.before.childCount || after.childCount !== transaction.doc.childCount) return [];
  const indexes = new Set<number>();
  transaction.steps.forEach((step, index) => {
    const oldDoc = transaction.docs[index], newDoc = transaction.docs[index + 1] ?? transaction.doc;
    for (const block of changedIndexes(oldDoc, newDoc, step.getMap(), step as { from?: number; to?: number; pos?: number })) indexes.add(block);
  });
  return recordPair(before, after, indexes);
}

/** Formal checkpoints release the current edge; older history roots keep only their own required ancestry. */
export function checkpointSourceTransactionNode(node: ProseMirrorNode, source: string) {
  exactSourceByNode.set(node, source);
  previousByNode.delete(node);
  unavailableByNode.delete(node);
  knownNodes.add(node);
}

/** Replay actual model changes into persistent raw pieces at a formal snapshot boundary. */
export function preserveSourceTransactionProvenance(
  source: string, before: ProseMirrorNode, after: ProseMirrorNode,
  preserve: (source: string, before: ProseMirrorNode, after: ProseMirrorNode) => string | null,
): string | null {
  const exact = exactSourceByNode.get(after);
  if (exact != null) return exact;
  const edges: Array<{ before: ProseMirrorNode; after: ProseMirrorNode }> = [];
  let cursor = after;
  while (cursor !== before) {
    const unavailable = unavailableByNode.get(cursor);
    if (unavailable) throw new SourceProvenanceUnavailableError(unavailable);
    const edge = previousByNode.get(cursor);
    if (!edge || edges.length >= MAX_PENDING_DEPTH) return null;
    edges.push({ before: edge.before, after: cursor }); cursor = edge.before;
  }
  if (!edges.length) return source;
  let text = source;
  let pieces = createSourcePieceState([{ id: 'block', source }], `provenance-${++sequence}`);
  for (const edge of edges.reverse()) {
    const next = preserve(text, edge.before, edge.after);
    if (next == null) return null;
    if (next === text) continue;
    // This is source assembly after model/parse proof, never a position identity heuristic.
    let from = 0;
    while (from < text.length && from < next.length && text[from] === next[from]) from++;
    // Keep surrogate pairs indivisible in the piece engine.
    if (from && /[\uDC00-\uDFFF]/.test(text[from] ?? next[from] ?? '')) from--;
    let oldTo = text.length, newTo = next.length;
    while (oldTo > from && newTo > from && text[oldTo - 1] === next[newTo - 1]) { oldTo--; newTo--; }
    if (oldTo < text.length && /[\uDC00-\uDFFF]/.test(text[oldTo])) { oldTo++; newTo++; }
    pieces = applySourcePiecePatchBatch(pieces, { documentId: pieces.documentId, beforeRevision: pieces.revision,
      patches: [{ blockId: 'block', pieceFrom: from, pieceTo: oldTo, expected: text.slice(from, oldTo), insert: next.slice(from, newTo) }] });
    counters.piecePatches++; text = next;
  }
  counters.materializations++;
  const materialized = materializeSourcePiece(pieces).source;
  return materialized === text ? materialized : null;
}

/** An idle block checkpoint bounds ancestry without parsing or copying the whole document. */
export function compactSourceTransactionProvenance(node: ProseMirrorNode, preserve: (source: string, before: ProseMirrorNode, after: ProseMirrorNode) => string | null) {
  let baseline = node, steps = 0;
  while (exactSourceByNode.get(baseline) == null) {
    const edge = previousByNode.get(baseline);
    if (!edge || ++steps > MAX_PENDING_DEPTH) return false;
    baseline = edge.before;
  }
  if (baseline === node) return true;
  const source = preserve(exactSourceByNode.get(baseline)!, baseline, node);
  if (source == null) return false;
  checkpointSourceTransactionNode(node, source);
  return true;
}
