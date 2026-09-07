/**
 * Persistent block-local source pieces for future WYSIWYG provenance wiring.
 *
 * This module deliberately has no editor, parser, or serializer dependency. A
 * patch coordinate is a UTF-16 offset in one block's piece view immediately
 * before the batch's `beforeRevision`; it is never an absolute offset in the
 * immutable base source. The owner may materialize a complete source only at
 * an explicit checkpoint. Inputs are expected to be strict UTF-8-decoded
 * strings; unpaired UTF-16 surrogates are rejected instead of being silently
 * replaced during a later byte encoding.
 */

export const SOURCE_PIECE_CHUNK_SIZE = 4096;

export interface SourcePieceBlockInput {
  readonly id: string;
  readonly source: string;
  readonly separator?: string;
}

export interface SourcePieceBlockSnapshot {
  readonly id: string;
  readonly source: string;
  readonly separator: string;
}

export interface SourcePiecePatch {
  readonly blockId: string;
  /** UTF-16 offsets in the block piece view at the batch's beforeRevision. */
  readonly pieceFrom: number;
  readonly pieceTo: number;
  /** Exact text expected at pieceFrom..pieceTo before the batch. */
  readonly expected: string;
  readonly insert: string;
}

export interface SourcePiecePatchBatch {
  /** Opaque document identity; prevents same-revision cross-document reuse. */
  readonly documentId: string;
  readonly beforeRevision: number;
  readonly patches: readonly SourcePiecePatch[];
  readonly transactionId?: string;
}

export interface SourcePieceDelta {
  readonly documentId: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly forward: readonly SourcePiecePatch[];
  readonly inverse: readonly SourcePiecePatch[];
  readonly transactionId?: string;
}

export type SourcePieceErrorCode =
  | "document-mismatch"
  | "stale-revision"
  | "unknown-block"
  | "invalid-patch"
  | "invalid-utf16-boundary"
  | "invalid-unpaired-surrogate"
  | "patch-overlap"
  | "expected-mismatch"
  | "history-empty"
  | "history-conflict";

export class SourcePieceStateError extends Error {
  readonly code: SourcePieceErrorCode;
  readonly blockId?: string;
  readonly patchIndex?: number;

  constructor(
    code: SourcePieceErrorCode,
    message: string,
    details: { blockId?: string; patchIndex?: number } = {},
  ) {
    super(message);
    this.name = "SourcePieceStateError";
    this.code = code;
    this.blockId = details.blockId;
    this.patchIndex = details.patchIndex;
  }
}

export interface SourcePieceOperationCost {
  /** Persistent rope nodes inspected while validating/applying the operation. */
  readonly nodesVisited: number;
  /** New persistent rope node objects allocated by the operation. */
  readonly nodesCreated: number;
  readonly blocksTouched: number;
  readonly checkedUtf16Units: number;
}

export interface SourcePieceBase {
  readonly documentId: string;
  readonly checkpointId: string;
  readonly blocks: readonly SourcePieceBlockSnapshot[];
  readonly blockIndex: Readonly<Record<string, number>>;
}

export type SourcePieceRoot = object | null;

export interface SourcePieceState {
  readonly documentId: string;
  readonly revision: number;
  readonly base: SourcePieceBase;
  readonly checkpointSequence: number;
  readonly operationCost: SourcePieceOperationCost;
  readonly transition: SourcePieceTransition;
  readonly root: object | null;
  readonly undo: HistoryEntry | null;
  readonly redo: HistoryEntry | null;
  readonly undoLength: number;
  readonly redoLength: number;
  readonly nextPriorityId: number;
}

export type SourcePieceTransition =
  | { readonly kind: "initial" }
  | { readonly kind: "apply" | "undo" | "redo"; readonly delta: SourcePieceDelta }
  | { readonly kind: "checkpoint"; readonly checkpointId: string };

export interface SourcePieceMaterializationCost {
  readonly blocksVisited: number;
  readonly piecesVisited: number;
  readonly copiedUtf16Units: number;
  readonly separatorUtf16Units: number;
}

export interface SourcePieceMaterialization {
  readonly source: string;
  readonly blocks: readonly SourcePieceBlockSnapshot[];
  readonly cost: SourcePieceMaterializationCost;
}

export interface SourcePieceCheckpoint {
  readonly state: SourcePieceState;
  readonly materialization: SourcePieceMaterialization;
}

interface RopeNode {
  readonly text: string;
  readonly left: RopeNode | null;
  readonly right: RopeNode | null;
  readonly priority: number;
  readonly size: number;
}

interface BlockState {
  readonly descriptor: SourcePieceBlockSnapshot;
  readonly pieces: RopeNode | null;
}

interface BlockIndexNode {
  readonly left: BlockIndexNode | null;
  readonly right: BlockIndexNode | null;
  readonly value: BlockState | null;
}

interface HistoryEntry {
  readonly delta: SourcePieceDelta;
  readonly next: HistoryEntry | null;
}

interface Allocator {
  nextPriorityId: number;
  nodesVisited: number;
  nodesCreated: number;
  checkedUtf16Units: number;
}

interface ValidatedPatch {
  readonly patch: SourcePiecePatch;
  readonly blockIndex: number;
  readonly oldText: string;
  afterFrom: number;
}

interface InternalState {
  readonly root: BlockIndexNode | null;
  readonly undo: HistoryEntry | null;
  readonly redo: HistoryEntry | null;
  readonly undoLength: number;
  readonly redoLength: number;
  readonly nextPriorityId: number;
}

const EMPTY_OPERATION_COST: SourcePieceOperationCost = Object.freeze({
  nodesVisited: 0,
  nodesCreated: 0,
  blocksTouched: 0,
  checkedUtf16Units: 0,
});

/** Create a persistent piece state whose initial base is copied once. */
export function createSourcePieceState(blocks: readonly SourcePieceBlockInput[], documentId: string): SourcePieceState {
  assertDocumentId(documentId);
  const baseBlocks = normalizeBaseBlocks(blocks);
  const base = makeBase(baseBlocks, documentId, 0);
  const allocator: Allocator = {
    nextPriorityId: 1,
    nodesVisited: 0,
    nodesCreated: 0,
    checkedUtf16Units: 0,
  };
  const values = base.blocks.map((descriptor) => ({
    descriptor,
    pieces: ropeFromText(descriptor.source, allocator),
  } satisfies BlockState)).map((value) => Object.freeze(value));
  const root = buildBlockIndex(values, 0, values.length);
  return Object.freeze({
    documentId,
    revision: 0,
    base,
    checkpointSequence: 0,
    operationCost: EMPTY_OPERATION_COST,
    transition: Object.freeze({ kind: "initial" } as const),
    root,
    undo: null,
    redo: null,
    undoLength: 0,
    redoLength: 0,
    // The first nodes were created while building the immutable base. Keeping
    // their allocator cursor in the state makes future tree allocations local
    // to the returned immutable state instead of using a module-global counter.
    nextPriorityId: allocator.nextPriorityId,
  });
}

/**
 * Apply one atomic batch. Every patch uses the same beforeRevision and
 * before-batch piece coordinates, including when several patches touch one
 * block. No mutation is made until all ranges and expected fragments pass.
 */
export function applySourcePiecePatchBatch(
  state: SourcePieceState,
  batch: SourcePiecePatchBatch,
): SourcePieceState {
  if (batch.documentId !== state.documentId) {
    throw new SourcePieceStateError(
      "document-mismatch",
      `Source piece batch belongs to ${JSON.stringify(batch.documentId)}, current document is ${JSON.stringify(state.documentId)}.`,
    );
  }
  if (batch.beforeRevision !== state.revision) {
    throw new SourcePieceStateError(
      "stale-revision",
      `Source piece batch is for revision ${batch.beforeRevision}, current revision is ${state.revision}.`,
    );
  }
  if (!Array.isArray(batch.patches) || batch.patches.length === 0) {
    throw new SourcePieceStateError("invalid-patch", "A source piece batch must contain at least one patch.");
  }

  const allocator: Allocator = {
    nextPriorityId: getNextPriorityId(state),
    nodesVisited: 0,
    nodesCreated: 0,
    checkedUtf16Units: 0,
  };
  const validated = validatePatches(state, batch.patches, allocator);
  const allNoop = validated.every(({ patch, oldText }) => patch.insert === oldText);
  if (allNoop) return state;

  const grouped = new Map<number, ValidatedPatch[]>();
  for (const item of validated) {
    const group = grouped.get(item.blockIndex);
    if (group) group.push(item);
    else grouped.set(item.blockIndex, [item]);
  }

  let nextRoot = state.root as BlockIndexNode | null;
  for (const [blockIndex, group] of grouped) {
    const current = getBlockAt(nextRoot, blockIndex, 0, state.base.blocks.length);
    if (!current) {
      throw new SourcePieceStateError("unknown-block", `Block index ${blockIndex} is not available.`);
    }
    let pieces = current.pieces;
    // Applying from right to left keeps every coordinate in this group in the
    // before-batch coordinate space.
    for (let index = group.length - 1; index >= 0; index -= 1) {
      const item = group[index];
      pieces = replaceRope(pieces, item.patch.pieceFrom, item.patch.pieceTo, item.patch.insert, allocator);
    }
    nextRoot = setBlockAt(
      nextRoot,
      blockIndex,
      0,
      state.base.blocks.length,
      Object.freeze({ descriptor: current.descriptor, pieces }),
    );
  }

  const forward = freezePatches(validated.map(({ patch }) => patch));
  const inverse = freezePatches(
    validated.map(({ patch, oldText, afterFrom }) => ({
      blockId: patch.blockId,
      pieceFrom: afterFrom,
      pieceTo: afterFrom + patch.insert.length,
      expected: patch.insert,
      insert: oldText,
    })),
  );
  const delta: SourcePieceDelta = Object.freeze({
    documentId: state.documentId,
    beforeRevision: state.revision,
    afterRevision: state.revision + 1,
    forward,
    inverse,
    ...(batch.transactionId == null ? {} : { transactionId: batch.transactionId }),
  });
  const internal: InternalState = {
    root: nextRoot,
    undo: pushHistory(stateUndo(state), { delta, next: null }),
    redo: null,
    undoLength: stateUndoLength(state) + 1,
    redoLength: 0,
    nextPriorityId: allocator.nextPriorityId,
  };
  return makeStateFromInternal(state, internal, state.revision + 1, {
    nodesVisited: allocator.nodesVisited,
    nodesCreated: allocator.nodesCreated,
    blocksTouched: grouped.size,
    checkedUtf16Units: allocator.checkedUtf16Units,
  }, { kind: "apply", delta });
}

/** Undo the latest applied batch, preserving a redo entry. */
export function undoSourcePiece(state: SourcePieceState): SourcePieceState {
  const entry = stateUndo(state);
  if (!entry) throw new SourcePieceStateError("history-empty", "No source piece batch is available to undo.");
  const allocator: Allocator = {
    nextPriorityId: getNextPriorityId(state),
    nodesVisited: 0,
    nodesCreated: 0,
    checkedUtf16Units: 0,
  };
  const nextRoot = applyValidatedPatches(state, entry.delta.inverse, allocator);
  const internal: InternalState = {
    root: nextRoot,
    undo: entry.next,
    redo: pushHistory(stateRedo(state), entry),
    undoLength: stateUndoLength(state) - 1,
    redoLength: stateRedoLength(state) + 1,
    nextPriorityId: allocator.nextPriorityId,
  };
  const transitionDelta = makeTransitionDelta(state, entry.delta, "undo");
  return makeStateFromInternal(state, internal, state.revision + 1, {
    nodesVisited: allocator.nodesVisited,
    nodesCreated: allocator.nodesCreated,
    blocksTouched: countDistinctBlocks(entry.delta.inverse, state.base.blockIndex),
    checkedUtf16Units: allocator.checkedUtf16Units,
  }, { kind: "undo", delta: transitionDelta });
}

/** Redo the latest undone batch, preserving a new undo entry. */
export function redoSourcePiece(state: SourcePieceState): SourcePieceState {
  const entry = stateRedo(state);
  if (!entry) throw new SourcePieceStateError("history-empty", "No source piece batch is available to redo.");
  const allocator: Allocator = {
    nextPriorityId: getNextPriorityId(state),
    nodesVisited: 0,
    nodesCreated: 0,
    checkedUtf16Units: 0,
  };
  const nextRoot = applyValidatedPatches(state, entry.delta.forward, allocator);
  const internal: InternalState = {
    root: nextRoot,
    undo: pushHistory(stateUndo(state), entry),
    redo: entry.next,
    undoLength: stateUndoLength(state) + 1,
    redoLength: stateRedoLength(state) - 1,
    nextPriorityId: allocator.nextPriorityId,
  };
  const transitionDelta = makeTransitionDelta(state, entry.delta, "redo");
  return makeStateFromInternal(state, internal, state.revision + 1, {
    nodesVisited: allocator.nodesVisited,
    nodesCreated: allocator.nodesCreated,
    blocksTouched: countDistinctBlocks(entry.delta.forward, state.base.blockIndex),
    checkedUtf16Units: allocator.checkedUtf16Units,
  }, { kind: "redo", delta: transitionDelta });
}

/** Materialize the current piece roots without changing state or history. */
export function materializeSourcePiece(state: SourcePieceState): SourcePieceMaterialization {
  const sourceParts: string[] = [];
  const blocks: SourcePieceBlockSnapshot[] = [];
  let piecesVisited = 0;
  let copiedUtf16Units = 0;
  let separatorUtf16Units = 0;
  for (let index = 0; index < state.base.blocks.length; index += 1) {
    const block = getBlockAt(state.root as BlockIndexNode | null, index, 0, state.base.blocks.length);
    if (!block) throw new SourcePieceStateError("unknown-block", `Block index ${index} is missing during materialization.`);
    const source = ropeToText(block.pieces, (count) => { piecesVisited += count; });
    const separator = block.descriptor.separator;
    sourceParts.push(source, separator);
    blocks.push(Object.freeze({ id: block.descriptor.id, source, separator }));
    copiedUtf16Units += source.length;
    separatorUtf16Units += separator.length;
  }
  return Object.freeze({
    source: sourceParts.join(""),
    blocks: Object.freeze(blocks),
    cost: Object.freeze({
      blocksVisited: state.base.blocks.length,
      piecesVisited,
      copiedUtf16Units,
      separatorUtf16Units,
    }),
  });
}

/**
 * Establish a new immutable base at the current content. History is retained:
 * inverse/forward patches are text-checked and remain valid across this
 * checkpoint even though the piece boundaries are rebuilt.
 */
export function materializeSourcePieceCheckpoint(state: SourcePieceState): SourcePieceCheckpoint {
  const materialization = materializeSourcePiece(state);
  const baseBlocks = materialization.blocks;
  const base = makeBase(baseBlocks, state.documentId, state.checkpointSequence + 1);
  const allocator: Allocator = {
    nextPriorityId: getNextPriorityId(state),
    nodesVisited: 0,
    nodesCreated: 0,
    checkedUtf16Units: 0,
  };
  const values = base.blocks.map((descriptor) => ({
    descriptor,
    pieces: ropeFromText(descriptor.source, allocator),
  } satisfies BlockState)).map((value) => Object.freeze(value));
  const checkpointId = base.checkpointId;
  const nextState = makeStateFromInternal(
    state,
    {
      root: buildBlockIndex(values, 0, values.length),
      undo: stateUndo(state),
      redo: stateRedo(state),
      undoLength: stateUndoLength(state),
      redoLength: stateRedoLength(state),
      nextPriorityId: allocator.nextPriorityId,
    },
    state.revision,
    {
      nodesVisited: 0,
      nodesCreated: allocator.nodesCreated,
      blocksTouched: base.blocks.length,
      checkedUtf16Units: 0,
    },
    { kind: "checkpoint", checkpointId },
    base,
    state.checkpointSequence + 1,
  );
  return Object.freeze({ state: nextState, materialization });
}

/** Return one block's current text, copying only that block. */
export function getSourcePieceBlockText(state: SourcePieceState, blockId: string): string {
  const blockIndex = state.base.blockIndex[blockId];
  if (blockIndex == null) throw new SourcePieceStateError("unknown-block", `Unknown source block: ${blockId}.`, { blockId });
  const block = getBlockAt(state.root as BlockIndexNode | null, blockIndex, 0, state.base.blocks.length);
  if (!block) throw new SourcePieceStateError("unknown-block", `Missing source block: ${blockId}.`, { blockId });
  return ropeToText(block.pieces);
}

/** Read one current piece range without materializing its containing block. */
export function getSourcePieceBlockSlice(
  state: SourcePieceState,
  blockId: string,
  from: number,
  to: number,
): string {
  const blockIndex = state.base.blockIndex[blockId];
  if (blockIndex == null) throw new SourcePieceStateError("unknown-block", `Unknown source block: ${blockId}.`, { blockId });
  const block = getBlockAt(state.root as BlockIndexNode | null, blockIndex, 0, state.base.blocks.length);
  if (!block) throw new SourcePieceStateError("unknown-block", `Missing source block: ${blockId}.`, { blockId });
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > ropeSize(block.pieces)) {
    throw new SourcePieceStateError("invalid-patch", `Invalid source slice ${from}..${to} in ${blockId}.`, { blockId });
  }
  const allocator: Allocator = {
    nextPriorityId: getNextPriorityId(state),
    nodesVisited: 0,
    nodesCreated: 0,
    checkedUtf16Units: 0,
  };
  assertPieceBoundary(block.pieces, from, blockId, 0, allocator);
  assertPieceBoundary(block.pieces, to, blockId, 0, allocator);
  return ropeSlice(block.pieces, from, to, allocator);
}

/** Read only the current UTF-16 length; this does not materialize the block. */
export function getSourcePieceBlockLength(state: SourcePieceState, blockId: string): number {
  const blockIndex = state.base.blockIndex[blockId];
  if (blockIndex == null) throw new SourcePieceStateError("unknown-block", `Unknown source block: ${blockId}.`, { blockId });
  const block = getBlockAt(state.root as BlockIndexNode | null, blockIndex, 0, state.base.blocks.length);
  if (!block) throw new SourcePieceStateError("unknown-block", `Missing source block: ${blockId}.`, { blockId });
  return ropeSize(block.pieces);
}

/** Return the opaque persistent rope root for reference-reuse assertions. */
export function getSourcePieceBlockRoot(state: SourcePieceState, blockId: string): SourcePieceRoot | undefined {
  const blockIndex = state.base.blockIndex[blockId];
  if (blockIndex == null) return undefined;
  const block = getBlockAt(state.root as BlockIndexNode | null, blockIndex, 0, state.base.blocks.length);
  return block?.pieces ?? null;
}

export function getSourcePieceHistoryLengths(state: SourcePieceState) {
  return { undo: stateUndoLength(state), redo: stateRedoLength(state) };
}

export function getSourcePieceDelta(state: SourcePieceState): SourcePieceDelta | null {
  return state.transition.kind === "initial" || state.transition.kind === "checkpoint"
    ? null
    : state.transition.delta;
}

function normalizeBaseBlocks(blocks: readonly SourcePieceBlockInput[]): readonly SourcePieceBlockSnapshot[] {
  const ids = new Set<string>();
  const normalized = blocks.map((block, index) => {
    if (!block || typeof block.id !== "string" || block.id.length === 0 || ids.has(block.id)) {
      throw new SourcePieceStateError("invalid-patch", `Invalid or duplicate source block id at index ${index}.`);
    }
    if (typeof block.source !== "string" || typeof block.separator !== "undefined" && typeof block.separator !== "string") {
      throw new SourcePieceStateError("invalid-patch", `Source block ${block.id} must contain string source/separator.`);
    }
    assertWellFormedUtf16(block.source, `source block ${block.id}`, "invalid-unpaired-surrogate");
    assertWellFormedUtf16(block.separator ?? "", `separator for source block ${block.id}`, "invalid-unpaired-surrogate");
    ids.add(block.id);
    return Object.freeze({ id: block.id, source: block.source, separator: block.separator ?? "" });
  });
  return Object.freeze(normalized);
}

function makeBase(blocks: readonly SourcePieceBlockSnapshot[], documentId: string, checkpointSequence: number): SourcePieceBase {
  const normalized = normalizeBaseBlocks(blocks);
  const blockIndex: Record<string, number> = Object.create(null) as Record<string, number>;
  normalized.forEach((block, index) => { blockIndex[block.id] = index; });
  return Object.freeze({
    documentId,
    checkpointId: `${documentId}:source-piece-checkpoint-${checkpointSequence}`,
    blocks: normalized,
    blockIndex: Object.freeze(blockIndex),
  });
}

function assertDocumentId(documentId: string) {
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new SourcePieceStateError("document-mismatch", "A non-empty source piece documentId is required.");
  }
}

function assertWellFormedUtf16(
  value: string,
  label: string,
  code: SourcePieceErrorCode = "invalid-patch",
  details: { blockId?: string; patchIndex?: number } = {},
) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (isHighSurrogate(unit)) {
      if (index + 1 >= value.length || !isLowSurrogate(value.charCodeAt(index + 1))) {
        throw new SourcePieceStateError(code, `${label} contains an unpaired high surrogate at UTF-16 offset ${index}.`, details);
      }
      index += 1;
    } else if (isLowSurrogate(unit)) {
      throw new SourcePieceStateError(code, `${label} contains an unpaired low surrogate at UTF-16 offset ${index}.`, details);
    }
  }
}

function stateUndo(state: SourcePieceState): HistoryEntry | null {
  return state.undo;
}

function stateRedo(state: SourcePieceState): HistoryEntry | null {
  return state.redo;
}

function stateUndoLength(state: SourcePieceState): number {
  return state.undoLength;
}

function stateRedoLength(state: SourcePieceState): number {
  return state.redoLength;
}

function getNextPriorityId(state: SourcePieceState): number {
  return state.nextPriorityId;
}

function makeStateFromInternal(
  previous: SourcePieceState,
  internal: InternalState,
  revision: number,
  operationCost: SourcePieceOperationCost,
  transition: SourcePieceTransition,
  base = (previous as SourcePieceState).base,
  checkpointSequence = (previous as SourcePieceState).checkpointSequence,
): SourcePieceState {
  return Object.freeze({
    documentId: base.documentId,
    revision,
    base,
    checkpointSequence,
    operationCost: Object.freeze({ ...operationCost }),
    transition: Object.freeze(transition),
    root: internal.root,
    undo: internal.undo,
    redo: internal.redo,
    undoLength: internal.undoLength,
    redoLength: internal.redoLength,
    nextPriorityId: internal.nextPriorityId,
  }) as SourcePieceState;
}

function pushHistory(head: HistoryEntry | null, entry: HistoryEntry): HistoryEntry {
  return Object.freeze({ delta: entry.delta, next: head });
}

function makeTransitionDelta(
  state: SourcePieceState,
  historyDelta: SourcePieceDelta,
  kind: "undo" | "redo",
): SourcePieceDelta {
  const forward = kind === "undo" ? historyDelta.inverse : historyDelta.forward;
  const inverse = kind === "undo" ? historyDelta.forward : historyDelta.inverse;
  return Object.freeze({
    documentId: state.documentId,
    beforeRevision: state.revision,
    afterRevision: state.revision + 1,
    forward,
    inverse,
    ...(historyDelta.transactionId == null ? {} : { transactionId: `${historyDelta.transactionId}:${kind}` }),
  });
}

function validatePatches(
  state: SourcePieceState,
  patches: readonly SourcePiecePatch[],
  allocator: Allocator,
): readonly ValidatedPatch[] {
  const validated: ValidatedPatch[] = [];
  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = patches[patchIndex];
    if (!patch || typeof patch.blockId !== "string" || typeof patch.insert !== "string" || typeof patch.expected !== "string") {
      throw new SourcePieceStateError("invalid-patch", `Invalid source patch at index ${patchIndex}.`, { patchIndex });
    }
    const blockIndex = state.base.blockIndex[patch.blockId];
    if (blockIndex == null) {
      throw new SourcePieceStateError("unknown-block", `Unknown source block: ${patch.blockId}.`, {
        blockId: patch.blockId,
        patchIndex,
      });
    }
    if (!Number.isInteger(patch.pieceFrom) || !Number.isInteger(patch.pieceTo) || patch.pieceFrom < 0 || patch.pieceTo < patch.pieceFrom) {
      throw new SourcePieceStateError("invalid-patch", `Invalid piece range ${patch.pieceFrom}..${patch.pieceTo}.`, {
        blockId: patch.blockId,
        patchIndex,
      });
    }
    const block = getBlockAt(state.root as BlockIndexNode | null, blockIndex, 0, state.base.blocks.length);
    if (!block) throw new SourcePieceStateError("unknown-block", `Missing source block: ${patch.blockId}.`, { blockId: patch.blockId, patchIndex });
    const length = ropeSize(block.pieces);
    if (patch.pieceTo > length) {
      throw new SourcePieceStateError("invalid-patch", `Piece range ${patch.pieceFrom}..${patch.pieceTo} exceeds block length ${length}.`, {
        blockId: patch.blockId,
        patchIndex,
      });
    }
    assertPieceBoundary(block.pieces, patch.pieceFrom, patch.blockId, patchIndex, allocator);
    assertPieceBoundary(block.pieces, patch.pieceTo, patch.blockId, patchIndex, allocator);
    assertWellFormedUtf16(patch.insert, `insert for ${patch.blockId}`, "invalid-unpaired-surrogate", {
      blockId: patch.blockId,
      patchIndex,
    });
    const oldText = ropeSlice(block.pieces, patch.pieceFrom, patch.pieceTo, allocator);
    allocator.checkedUtf16Units += oldText.length;
    if (oldText !== patch.expected) {
      throw new SourcePieceStateError(
        "expected-mismatch",
        `Expected source fragment ${JSON.stringify(patch.expected)} but found ${JSON.stringify(oldText)} in ${patch.blockId}.`,
        { blockId: patch.blockId, patchIndex },
      );
    }
    validated.push({ patch, blockIndex, oldText, afterFrom: patch.pieceFrom });
  }

  const grouped = new Map<number, ValidatedPatch[]>();
  for (const item of validated) {
    const group = grouped.get(item.blockIndex);
    if (group) group.push(item);
    else grouped.set(item.blockIndex, [item]);
  }
  for (const group of grouped.values()) {
    group.sort((left, right) => left.patch.pieceFrom - right.patch.pieceFrom || left.patch.pieceTo - right.patch.pieceTo);
    let previous: ValidatedPatch | null = null;
    let delta = 0;
    for (const item of group) {
      const current = item.patch;
      if (previous && (
        previous.patch.pieceTo > current.pieceFrom ||
        (previous.patch.pieceFrom === previous.patch.pieceTo && previous.patch.pieceFrom === current.pieceFrom) ||
        (current.pieceFrom === current.pieceTo && current.pieceFrom === previous.patch.pieceTo)
      )) {
        throw new SourcePieceStateError("patch-overlap", `Overlapping or ambiguous source patches in ${current.blockId}.`, {
          blockId: current.blockId,
        });
      }
      item.afterFrom = current.pieceFrom + delta;
      delta += current.insert.length - item.oldText.length;
      previous = item;
    }
  }
  return Object.freeze(validated.slice().sort((left, right) => left.blockIndex - right.blockIndex || left.patch.pieceFrom - right.patch.pieceFrom));
}

function applyValidatedPatches(
  state: SourcePieceState,
  patches: readonly SourcePiecePatch[],
  allocator: Allocator,
): BlockIndexNode | null {
  const grouped = new Map<number, SourcePiecePatch[]>();
  for (const patch of patches) {
    const blockIndex = state.base.blockIndex[patch.blockId];
    if (blockIndex == null) {
      throw new SourcePieceStateError("history-conflict", `History refers to unknown source block: ${patch.blockId}.`, { blockId: patch.blockId });
    }
    const group = grouped.get(blockIndex);
    if (group) group.push(patch);
    else grouped.set(blockIndex, [patch]);
  }
  let nextRoot = state.root as BlockIndexNode | null;
  for (const [blockIndex, group] of grouped) {
    const current = getBlockAt(nextRoot, blockIndex, 0, state.base.blocks.length);
    if (!current) throw new SourcePieceStateError("history-conflict", `History block ${blockIndex} is missing.`);
    const checked: ValidatedPatch[] = [];
    for (let index = 0; index < group.length; index += 1) {
      const patch = group[index];
      if (!Number.isInteger(patch.pieceFrom) || !Number.isInteger(patch.pieceTo) || patch.pieceFrom < 0 || patch.pieceTo < patch.pieceFrom) {
        throw new SourcePieceStateError("history-conflict", `History has an invalid range in ${patch.blockId}.`, { blockId: patch.blockId });
      }
      const length = ropeSize(current.pieces);
      if (patch.pieceTo > length) {
        throw new SourcePieceStateError("history-conflict", `History range exceeds ${patch.blockId}.`, { blockId: patch.blockId });
      }
      try {
        assertPieceBoundary(current.pieces, patch.pieceFrom, patch.blockId, index, allocator);
        assertPieceBoundary(current.pieces, patch.pieceTo, patch.blockId, index, allocator);
        assertWellFormedUtf16(patch.insert, `history insert for ${patch.blockId}`);
      } catch (error) {
        if (error instanceof SourcePieceStateError) {
          throw new SourcePieceStateError("history-conflict", error.message, { blockId: patch.blockId });
        }
        throw error;
      }
      const actual = ropeSlice(current.pieces, patch.pieceFrom, patch.pieceTo, allocator);
      allocator.checkedUtf16Units += actual.length;
      if (actual !== patch.expected) {
        throw new SourcePieceStateError("history-conflict", `History expected fragment mismatch in ${patch.blockId}.`, { blockId: patch.blockId });
      }
      checked.push({ patch, blockIndex, oldText: actual, afterFrom: patch.pieceFrom });
    }
    checked.sort((left, right) => left.patch.pieceFrom - right.patch.pieceFrom || left.patch.pieceTo - right.patch.pieceTo);
    let previous: ValidatedPatch | null = null;
    for (const item of checked) {
      if (previous && previous.patch.pieceTo > item.patch.pieceFrom) {
        throw new SourcePieceStateError("history-conflict", `History patches overlap in ${item.patch.blockId}.`, { blockId: item.patch.blockId });
      }
      previous = item;
    }
    let pieces = current.pieces;
    for (let index = checked.length - 1; index >= 0; index -= 1) {
      const patch = checked[index].patch;
      pieces = replaceRope(pieces, patch.pieceFrom, patch.pieceTo, patch.insert, allocator);
    }
    nextRoot = setBlockAt(nextRoot, blockIndex, 0, state.base.blocks.length, {
      descriptor: current.descriptor,
      pieces,
    });
  }
  return nextRoot;
}

function freezePatches(patches: readonly SourcePiecePatch[]): readonly SourcePiecePatch[] {
  return Object.freeze(patches.map((patch) => Object.freeze({ ...patch })));
}

function countDistinctBlocks(patches: readonly SourcePiecePatch[], index: Readonly<Record<string, number>>) {
  return new Set(patches.map((patch) => index[patch.blockId])).size;
}

function buildBlockIndex(values: readonly BlockState[], start: number, end: number): BlockIndexNode | null {
  if (start >= end) return null;
  if (end - start === 1) return Object.freeze({ left: null, right: null, value: values[start] });
  const middle = start + Math.floor((end - start) / 2);
  return Object.freeze({
    left: buildBlockIndex(values, start, middle),
    right: buildBlockIndex(values, middle, end),
    value: null,
  });
}

function getBlockAt(node: BlockIndexNode | null, index: number, start: number, end: number): BlockState | null {
  if (!node || index < start || index >= end) return null;
  if (end - start === 1) return node.value;
  const middle = start + Math.floor((end - start) / 2);
  return index < middle
    ? getBlockAt(node.left, index, start, middle)
    : getBlockAt(node.right, index, middle, end);
}

function setBlockAt(
  node: BlockIndexNode | null,
  index: number,
  start: number,
  end: number,
  value: BlockState,
): BlockIndexNode | null {
  if (!node || index < start || index >= end) return node;
  if (end - start === 1) return Object.freeze({ left: null, right: null, value });
  const middle = start + Math.floor((end - start) / 2);
  return index < middle
    ? Object.freeze({ left: setBlockAt(node.left, index, start, middle, value), right: node.right, value: null })
    : Object.freeze({ left: node.left, right: setBlockAt(node.right, index, middle, end, value), value: null });
}

function ropeFromText(text: string, allocator: Allocator): RopeNode | null {
  if (text.length === 0) return null;
  let root: RopeNode | null = null;
  for (let from = 0; from < text.length; from += SOURCE_PIECE_CHUNK_SIZE) {
    const leaf = createLeaf(text.slice(from, Math.min(text.length, from + SOURCE_PIECE_CHUNK_SIZE)), allocator);
    root = mergeRopes(root, leaf, allocator);
  }
  return root;
}

function replaceRope(
  root: RopeNode | null,
  from: number,
  to: number,
  insert: string,
  allocator: Allocator,
): RopeNode | null {
  if (from === to && insert.length === 0) return root;
  const [left, rest] = splitRope(root, from, allocator);
  const [, right] = splitRope(rest, to - from, allocator);
  return mergeRopes(mergeRopes(left, ropeFromText(insert, allocator), allocator), right, allocator);
}

function splitRope(root: RopeNode | null, offset: number, allocator: Allocator): [RopeNode | null, RopeNode | null] {
  if (!root) return [null, null];
  allocator.nodesVisited += 1;
  if (offset <= 0) return [null, root];
  if (offset >= root.size) return [root, null];
  const leftSize = ropeSize(root.left);
  const ownEnd = leftSize + root.text.length;
  if (offset < leftSize) {
    const [left, middle] = splitRope(root.left, offset, allocator);
    return [left, cloneRopeNode(root, middle, root.right, allocator)];
  }
  if (offset > ownEnd) {
    const [middle, right] = splitRope(root.right, offset - ownEnd, allocator);
    return [cloneRopeNode(root, root.left, middle, allocator), right];
  }
  if (offset === leftSize) return [root.left, cloneRopeNode(root, null, root.right, allocator)];
  if (offset === ownEnd) return [cloneRopeNode(root, root.left, null, allocator), root.right];

  const cut = offset - leftSize;
  const leftPiece = createLeaf(root.text.slice(0, cut), allocator);
  const rightPiece = createLeaf(root.text.slice(cut), allocator);
  return [
    mergeRopes(root.left, leftPiece, allocator),
    mergeRopes(rightPiece, root.right, allocator),
  ];
}

function mergeRopes(left: RopeNode | null, right: RopeNode | null, allocator: Allocator): RopeNode | null {
  if (!left) return right;
  if (!right) return left;
  allocator.nodesVisited += 1;
  if (left.priority >= right.priority) {
    return cloneRopeNode(left, left.left, mergeRopes(left.right, right, allocator), allocator);
  }
  return cloneRopeNode(right, mergeRopes(left, right.left, allocator), right.right, allocator);
}

function createLeaf(text: string, allocator: Allocator): RopeNode {
  if (text.length === 0) throw new Error("Source piece leaves cannot be empty.");
  return createRopeNode(text, null, null, nextPriority(allocator), allocator);
}

function cloneRopeNode(root: RopeNode, left: RopeNode | null, right: RopeNode | null, allocator: Allocator): RopeNode {
  return createRopeNode(root.text, left, right, root.priority, allocator);
}

function createRopeNode(
  text: string,
  left: RopeNode | null,
  right: RopeNode | null,
  priority: number,
  allocator: Allocator,
): RopeNode {
  allocator.nodesCreated += 1;
  return Object.freeze({ text, left, right, priority, size: ropeSize(left) + text.length + ropeSize(right) });
}

function nextPriority(allocator: Allocator) {
  let value = (allocator.nextPriorityId++ + 0x9e3779b9) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

function ropeSize(root: RopeNode | null): number {
  return root?.size ?? 0;
}

function assertPieceBoundary(
  root: RopeNode | null,
  offset: number,
  blockId: string,
  patchIndex: number,
  allocator: Allocator,
) {
  const length = ropeSize(root);
  if (offset <= 0 || offset >= length) return;
  const before = ropeCharCodeAt(root, offset - 1, allocator);
  const after = ropeCharCodeAt(root, offset, allocator);
  if (isHighSurrogate(before) && isLowSurrogate(after)) {
    throw new SourcePieceStateError(
      "invalid-utf16-boundary",
      `Patch boundary ${offset} in ${blockId} splits a UTF-16 surrogate pair.`,
      { blockId, patchIndex },
    );
  }
}

function ropeCharCodeAt(root: RopeNode | null, offset: number, allocator: Allocator): number {
  if (!root || offset < 0 || offset >= root.size) {
    throw new SourcePieceStateError("invalid-patch", `UTF-16 offset ${offset} is outside the source piece.`);
  }
  allocator.nodesVisited += 1;
  const leftSize = ropeSize(root.left);
  if (offset < leftSize) return ropeCharCodeAt(root.left, offset, allocator);
  const ownOffset = offset - leftSize;
  if (ownOffset < root.text.length) return root.text.charCodeAt(ownOffset);
  return ropeCharCodeAt(root.right, ownOffset - root.text.length, allocator);
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}

function ropeSlice(root: RopeNode | null, from: number, to: number, allocator?: Allocator): string {
  const length = ropeSize(root);
  if (from < 0 || to < from || to > length) {
    throw new SourcePieceStateError("invalid-patch", `Invalid rope range ${from}..${to} for length ${length}.`);
  }
  if (from === to) return "";
  const parts: string[] = [];
  collectRopeSlice(root, from, to, parts, allocator);
  return parts.join("");
}

function collectRopeSlice(
  root: RopeNode | null,
  from: number,
  to: number,
  parts: string[],
  allocator?: Allocator,
) {
  if (!root || from >= to) return;
  if (allocator) allocator.nodesVisited += 1;
  const leftSize = ropeSize(root.left);
  const ownEnd = leftSize + root.text.length;
  if (from < leftSize) collectRopeSlice(root.left, from, Math.min(to, leftSize), parts, allocator);
  const ownFrom = Math.max(0, from - leftSize);
  const ownTo = Math.min(root.text.length, to - leftSize);
  if (ownFrom < ownTo) parts.push(root.text.slice(ownFrom, ownTo));
  if (to > ownEnd) {
    collectRopeSlice(root.right, Math.max(0, from - ownEnd), to - ownEnd, parts, allocator);
  }
}

function ropeToText(root: RopeNode | null, onPieces?: (count: number) => void): string {
  if (!root) return "";
  const parts: string[] = [];
  const visit = (node: RopeNode | null) => {
    if (!node) return;
    visit(node.left);
    parts.push(node.text);
    onPieces?.(1);
    visit(node.right);
  };
  visit(root);
  return parts.join("");
}
