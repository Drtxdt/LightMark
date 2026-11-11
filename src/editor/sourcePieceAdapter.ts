/**
 * A parser-backed, block-local adapter for the source piece engine.
 *
 * This module is deliberately independent of WYSIWYG and UI code.  It takes
 * one real Markdown/ProseMirror baseline, maps subsequent text-only PM
 * transactions to the current block piece coordinates, and keeps those
 * transactions provisional until an explicit checkpoint reparses the current
 * materialized source.  It never materializes the complete source on the
 * transaction hot path.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  AddMarkStep,
  AddNodeMarkStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
} from "@tiptap/pm/transform";
import type { Transaction } from "@tiptap/pm/state";
import {
  applySourcePiecePatchBatch,
  createSourcePieceState,
  getSourcePieceBlockSlice,
  materializeSourcePiece,
  materializeSourcePieceCheckpoint,
  type SourcePieceBlockInput,
  type SourcePiecePatch,
  type SourcePieceState,
} from "./sourcePieceState";
import {
  mapSourceTextLeaves,
  SourceProvenanceMappingError,
  type SourceLeafBaseline,
  type SourceLeafSpan,
  type SourceProvenanceFailureCode,
} from "./sourceLeafProvenance";

export type SourcePieceAdapterFailureCode =
  | SourceProvenanceFailureCode
  | "transaction-before-mismatch"
  | "piece-state-conflict"
  | "checkpoint-validation-failed"
  | "unsupported-step";

export type SourcePieceAdapterFailureDetails = {
  blockIndex?: number;
  leafIndex?: number;
  pmFrom?: number;
  pmTo?: number;
  expected?: string;
  actual?: string;
  cause?: string;
};

export class SourcePieceAdapterError extends Error {
  readonly code: SourcePieceAdapterFailureCode;
  readonly details: SourcePieceAdapterFailureDetails;

  constructor(
    code: SourcePieceAdapterFailureCode,
    message: string,
    details: SourcePieceAdapterFailureDetails = {},
  ) {
    super(message);
    this.name = "SourcePieceAdapterError";
    this.code = code;
    this.details = details;
  }
}

export type SourcePieceAdapterValidation = {
  readonly status: "validated" | "provisional";
  readonly validatedRevision: number;
  readonly checkpointId: string;
};

export type SourcePieceAdapterLeaf = {
  readonly index: number;
  readonly localIndex: number;
  readonly blockIndex: number;
  readonly rawFrom: number;
  readonly rawTo: number;
  /** PM baseline coordinate revision; current positions come from leafDeltaRoot. */
  readonly pmFrom: number;
  readonly pmTo: number;
  readonly pmRevision: number;
  /** Baseline leaf text; public leaf getters read current text from the piece root. */
  readonly text: string;
  readonly rawText: string;
  readonly marks: readonly string[];
  /** Current piece offset of the text content, excluding slot padding. */
  readonly pieceFrom: number;
  readonly pieceTo: number;
  /** Current piece span patched for this leaf, including empty-slot padding. */
  readonly spanFrom: number;
  readonly spanTo: number;
  readonly leadingPadding: string;
  readonly trailingPadding: string;
  readonly emptySlot: boolean;
};

export type SourcePieceAdapterBlock = {
  readonly id: string;
  readonly index: number;
  readonly kind: string;
  readonly rawFrom: number;
  readonly rawTo: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly separatorFrom: number;
  readonly separatorTo: number;
  /** Persistent baseline leaf metadata; current lengths come from leafDeltaRoot. */
  readonly leafRoot: LeafRecordTree | null;
  readonly leafCount: number;
  /** Length deltas at local leaf-order boundaries for the current piece. */
  readonly leafDeltaRoot: LeafDeltaTree | null;
};

type BlockTree = {
  readonly left: BlockTree | null;
  readonly right: BlockTree | null;
  readonly value: SourcePieceAdapterBlock | null;
};

type LeafLocator = {
  readonly blockIndex: number;
  readonly localIndex: number;
};

type LeafDeltaTree = {
  readonly left: LeafDeltaTree | null;
  readonly right: LeafDeltaTree | null;
  readonly sum: number;
};

type LeafRecordTree = {
  readonly left: LeafRecordTree | null;
  readonly right: LeafRecordTree | null;
  readonly value: SourcePieceAdapterLeaf | null;
};

export type SourcePieceAdapterState = {
  readonly documentId: string;
  readonly doc: ProseMirrorNode;
  readonly structure: string;
  /** Last parser-validated source baseline. */
  readonly baseline: SourceLeafBaseline;
  /** Persistent block metadata; only changed blocks are path-copied. */
  readonly blockRoot: BlockTree | null;
  readonly blockCount: number;
  /** Stable baseline leaf index -> current block/local metadata locator. */
  readonly leafLocators: readonly LeafLocator[];
  readonly source: SourcePieceState;
  /** Persistent point deltas at leaf-order boundaries; no history scan. */
  readonly leafDeltaRoot: LeafDeltaTree | null;
  readonly validation: SourcePieceAdapterValidation;
};

export type SourcePieceAdapterCheckpoint = {
  readonly state: SourcePieceAdapterState;
  readonly materialization: ReturnType<typeof materializeSourcePiece>;
};

/**
 * Capture a parser-proven baseline and build one source piece per top-level
 * Markdown block.  The first block owns a BOM, if present; the gap after each
 * block is its separator, so materialization is byte-for-byte the baseline.
 */
export function createSourcePieceAdapter(
  markdown: string,
  doc: ProseMirrorNode,
  documentId: string,
): SourcePieceAdapterState {
  const baseline = mapSourceTextLeaves(markdown, doc);
  if (baseline.blocks.length === 0 && markdown.length > 0) {
    throw new SourcePieceAdapterError(
      "unsupported-block",
      "A non-empty source has no parser-proven block to own its prefix or whitespace.",
    );
  }
  const blocks = buildBlocks(baseline);
  const source = createSourcePieceState(blocks.map(({ id, source, separator }) => ({ id, source, separator })), documentId);
  return makeAdapterState({
    documentId,
    doc,
    baseline,
    source,
    blockValues: blocks.map((block) => makeBlockMetadata(block, baseline, source.revision)),
    leafDeltaRoot: null,
    structure: baseline.structure,
    validation: {
      status: "validated",
      validatedRevision: source.revision,
      checkpointId: source.base.checkpointId,
    },
  });
}

/**
 * Apply one PM transaction without materializing the whole source.  The
 * parser proof is the initial exact leaf index; each input only maps the
 * changed leaf ranges and updates the affected block's piece/metadata.  The
 * resulting source is provisional until checkpoint validation succeeds.
 */
export function applySourcePieceAdapterTransaction(
  state: SourcePieceAdapterState,
  transaction: Transaction,
  transactionId?: string,
): SourcePieceAdapterState {
  if (transaction.before !== state.doc) {
    throw new SourcePieceAdapterError(
      "transaction-before-mismatch",
      "The PM transaction does not start from the adapter's current document.",
    );
  }
  if (!transaction.docChanged) return state;

  const stepChanges = collectStepChanges(state, transaction);
  if (stepChanges.length === 0) {
    throw new SourcePieceAdapterError(
      "unsupported-inline",
      "The document changed without a captured source text leaf covering the change.",
    );
  }

  const changed = buildChangedLeafPatches(state, transaction, stepChanges);
  const patches = [...changed.values()]
    .flatMap(({ patches: leafPatches }) => leafPatches)
    .sort((left, right) => left.blockId.localeCompare(right.blockId) || left.pieceFrom - right.pieceFrom);

  let nextSource: SourcePieceState;
  try {
    nextSource = applySourcePiecePatchBatch(state.source, {
      documentId: state.documentId,
      beforeRevision: state.source.revision,
      patches,
      ...(transactionId == null ? {} : { transactionId }),
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new SourcePieceAdapterError("piece-state-conflict", error.message, { cause: error.name });
    }
    throw error;
  }

  const nextBlockRoot = updateChangedBlocks(state, changed);
  const nextRevision = nextSource.revision;
  let leafDeltaRoot = state.leafDeltaRoot;
  for (const entry of changed.values()) {
    const delta = entry.patches.reduce((sum, patch) => sum + patch.insert.length - patch.expected.length, 0);
    if (delta !== 0) leafDeltaRoot = addLeafDelta(leafDeltaRoot, entry.leaf.index + 1, delta, 0, state.leafLocators.length + 1);
  }
  const nextValues = {
    documentId: state.documentId,
    doc: transaction.doc,
    structure: state.structure,
    baseline: state.baseline,
    blockRoot: nextBlockRoot,
    blockCount: state.blockCount,
    leafLocators: state.leafLocators,
    source: nextSource,
    leafDeltaRoot,
    validation: {
      status: "provisional" as const,
      validatedRevision: state.validation.validatedRevision,
      checkpointId: state.validation.checkpointId,
    },
  };
  return Object.freeze(nextValues);
}

/**
 * Materialize and parser-validate the current dirty pieces.  This is the
 * explicit validation/checkpoint boundary; a failure throws before any
 * caller-visible state is changed, leaving the old adapter state (including
 * its validated baseline and current provisional pieces) available for
 * recovery/export.
 */
export function checkpointSourcePieceAdapter(state: SourcePieceAdapterState): SourcePieceAdapterCheckpoint {
  const materialization = materializeSourcePieceCheckpoint(state.source);
  let baseline: SourceLeafBaseline;
  try {
    baseline = mapSourceTextLeaves(materialization.materialization.source, state.doc);
  } catch (error) {
    if (error instanceof SourceProvenanceMappingError) {
      throw new SourcePieceAdapterError(
        "checkpoint-validation-failed",
        `Checkpoint parser validation failed: ${error.message}`,
        { cause: error.code },
      );
    }
    throw error;
  }
  const blockValues = buildBlocks(baseline).map((block) => makeBlockMetadata(block, baseline, materialization.state.revision));
  const nextState = makeAdapterState({
    documentId: state.documentId,
    doc: state.doc,
    baseline,
    source: materialization.state,
    blockValues,
    leafDeltaRoot: null,
    structure: baseline.structure,
    validation: {
      status: "validated",
      validatedRevision: materialization.state.revision,
      checkpointId: materialization.state.base.checkpointId,
    },
  });
  return Object.freeze({ state: nextState, materialization: materialization.materialization });
}

export function tryCheckpointSourcePieceAdapter(
  state: SourcePieceAdapterState,
): { readonly ok: true; readonly value: SourcePieceAdapterCheckpoint } | { readonly ok: false; readonly error: SourcePieceAdapterError } {
  try {
    return { ok: true, value: checkpointSourcePieceAdapter(state) };
  } catch (error) {
    if (error instanceof SourcePieceAdapterError) return { ok: false, error };
    throw error;
  }
}

export function materializeSourcePieceAdapter(state: SourcePieceAdapterState) {
  return materializeSourcePiece(state.source);
}

export function getSourcePieceAdapterBlock(state: SourcePieceAdapterState, index: number): SourcePieceAdapterBlock | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= state.blockCount) return undefined;
  return getBlock(state.blockRoot, index, 0, state.blockCount);
}

/** Explicit inspection helper; current text is materialized only for this leaf. */
export function getSourcePieceAdapterLeaf(state: SourcePieceAdapterState, leafIndex: number): SourcePieceAdapterLeaf | undefined {
  const locator = state.leafLocators[leafIndex];
  if (!locator) return undefined;
  const block = getSourcePieceAdapterBlock(state, locator.blockIndex);
  const leaf = block ? getLeafRecord(block.leafRoot, locator.localIndex, 0, block.leafCount) : undefined;
  return leaf && block ? materializePublicLeaf(state, block, leaf, locator.localIndex) : undefined;
}

/** Explicit inspection helper; not used by the transaction hot path. */
export function getSourcePieceAdapterBlockLeaves(state: SourcePieceAdapterState, index: number): readonly SourcePieceAdapterLeaf[] {
  const block = getSourcePieceAdapterBlock(state, index);
  if (!block) return [];
  const leaves: SourcePieceAdapterLeaf[] = [];
  for (let localIndex = 0; localIndex < block.leafCount; localIndex += 1) {
    const leaf = getLeafRecord(block.leafRoot, localIndex, 0, block.leafCount);
    if (leaf) leaves.push(materializePublicLeaf(state, block, leaf, localIndex));
  }
  return Object.freeze(leaves);
}

/** Return a leaf's PM range after lazily applying maps since its last update. */
export function getSourcePieceAdapterLeafRange(
  state: SourcePieceAdapterState,
  leafIndex: number,
): { readonly from: number; readonly to: number } | undefined {
  return state.leafLocators[leafIndex] ? getCurrentLeafRange(state, leafIndex) : undefined;
}

type ChangedLeaf = {
  readonly leaf: SourcePieceAdapterLeaf;
  readonly patches: readonly SourcePiecePatch[];
};

type StepChange = {
  readonly leafIndex: number;
  /** Range in the adapter's current PM document, before this transaction. */
  readonly beforeFrom: number;
  readonly beforeTo: number;
};

type LocalChange = {
  readonly leaf: SourcePieceAdapterLeaf;
  readonly beforeFrom: number;
  readonly beforeTo: number;
};

type BlockInputWithRange = SourcePieceBlockInput & {
  readonly index: number;
  readonly kind: string;
  readonly rawFrom: number;
  readonly rawTo: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly separatorFrom: number;
  readonly separatorTo: number;
};

function makeAdapterState(input: {
  readonly documentId: string;
  readonly doc: ProseMirrorNode;
  readonly baseline: SourceLeafBaseline;
  readonly source: SourcePieceState;
  readonly blockValues: readonly SourcePieceAdapterBlock[];
  readonly leafDeltaRoot: LeafDeltaTree | null;
  readonly structure: string;
  readonly leafLocators?: readonly LeafLocator[];
  readonly validation: SourcePieceAdapterValidation;
}): SourcePieceAdapterState {
  if (input.blockValues.length !== input.baseline.blocks.length) {
    throw new SourcePieceAdapterError(
      "block-count-mismatch",
      "Adapter block metadata does not match the parser baseline.",
    );
  }
  const leafLocators = input.leafLocators ?? buildLeafLocators(input.baseline, input.blockValues);
  const blockRoot = buildBlockTree(input.blockValues, 0, input.blockValues.length);
  return Object.freeze({
    documentId: input.documentId,
    doc: input.doc,
    structure: input.structure,
    baseline: input.baseline,
    blockRoot,
    blockCount: input.blockValues.length,
    leafLocators: input.leafLocators ?? Object.freeze(leafLocators),
    source: input.source,
    leafDeltaRoot: input.leafDeltaRoot,
    validation: Object.freeze({ ...input.validation }),
  });
}

function buildLeafLocators(
  baseline: SourceLeafBaseline,
  blockValues: readonly SourcePieceAdapterBlock[],
): readonly LeafLocator[] {
  const leafLocators: LeafLocator[] = [];
  const localIndexes = new Map<number, number>();
  for (const block of blockValues) {
    // Baseline leaves are already ordered by parser/PM traversal; assign a
    // stable local index without materializing every block's leaf tree.
    localIndexes.set(block.index, 0);
  }
  for (const leaf of baseline.leaves) {
    const localIndex = localIndexes.get(leaf.blockIndex) ?? 0;
    leafLocators[leaf.index] = { blockIndex: leaf.blockIndex, localIndex };
    localIndexes.set(leaf.blockIndex, localIndex + 1);
  }
  return leafLocators;
}

function buildBlocks(baseline: SourceLeafBaseline): BlockInputWithRange[] {
  const result: BlockInputWithRange[] = [];
  for (let index = 0; index < baseline.blocks.length; index += 1) {
    const block = baseline.blocks[index];
    const nextFrom = baseline.blocks[index + 1]?.from ?? baseline.rawSource.length;
    // The first parsed block owns any prefix before its token (BOM, blank
    // lines, or leading whitespace) so a no-op materialization covers [0,n].
    const rawFrom = index === 0 ? 0 : block.from;
    const contentFrom = block.from;
    const contentTo = block.to;
    const rawTo = nextFrom;
    if (rawFrom > contentFrom || contentFrom > contentTo || contentTo > rawTo) {
      throw new SourcePieceAdapterError(
        "structure-changed",
        `Invalid parser block range at ${index}.`,
        { blockIndex: index },
      );
    }
    result.push({
      id: blockIdForIndex(index),
      index,
      kind: block.kind,
      rawFrom,
      rawTo,
      contentFrom,
      contentTo,
      separatorFrom: contentTo,
      separatorTo: rawTo,
      source: baseline.rawSource.slice(rawFrom, contentTo),
      separator: baseline.rawSource.slice(contentTo, rawTo),
    });
  }
  if (result.length > 0 && result[result.length - 1].rawTo !== baseline.rawSource.length) {
    throw new SourcePieceAdapterError(
      "structure-changed",
      "Parser block ranges do not cover the complete source.",
      { expected: String(baseline.rawSource.length), actual: String(result[result.length - 1].rawTo) },
    );
  }
  return result;
}

function makeBlockMetadata(input: BlockInputWithRange, baseline: SourceLeafBaseline, pmRevision: number): SourcePieceAdapterBlock {
  const sourceLeaves = baseline.leaves.filter((leaf) => leaf.blockIndex === input.index);
  const leaves = sourceLeaves.map((leaf, localIndex) => makeLeafMetadata(leaf, localIndex, input, pmRevision));
  return Object.freeze({
    id: input.id,
    index: input.index,
    kind: input.kind,
    rawFrom: input.rawFrom,
    rawTo: input.rawTo,
    contentFrom: input.contentFrom,
    contentTo: input.contentTo,
    separatorFrom: input.separatorFrom,
    separatorTo: input.separatorTo,
    leafRoot: buildLeafRecordTree(leaves, 0, leaves.length),
    leafCount: leaves.length,
    leafDeltaRoot: null,
  });
}

function makeLeafMetadata(leaf: SourceLeafSpan, localIndex: number, block: BlockInputWithRange, pmRevision: number): SourcePieceAdapterLeaf {
  const emptySlot = Boolean(leaf.emptySlot);
  const leadingPadding = leaf.emptySlot?.leadingPadding ?? "";
  const trailingPadding = leaf.emptySlot?.trailingPadding ?? "";
  const spanFrom = leaf.rawFrom - block.rawFrom;
  const pieceFrom = spanFrom + leadingPadding.length;
  return Object.freeze({
    index: leaf.index,
    localIndex,
    blockIndex: block.index,
    rawFrom: leaf.rawFrom,
    rawTo: leaf.rawTo,
    pmFrom: leaf.pmFrom,
    pmTo: leaf.pmTo,
    pmRevision,
    text: leaf.text,
    rawText: leaf.rawText,
    marks: Object.freeze([...leaf.marks]),
    pieceFrom,
    pieceTo: pieceFrom + leaf.text.length,
    spanFrom,
    spanTo: spanFrom + leaf.rawText.length,
    leadingPadding,
    trailingPadding,
    emptySlot,
  });
}

function updateChangedBlocks(state: SourcePieceAdapterState, changed: ReadonlyMap<number, ChangedLeaf>) {
  const grouped = new Map<number, ChangedLeaf[]>();
  for (const item of changed.values()) {
    const group = grouped.get(item.leaf.blockIndex);
    if (group) group.push(item);
    else grouped.set(item.leaf.blockIndex, [item]);
  }
  let nextRoot = state.blockRoot;
  for (const [blockIndex, entries] of grouped) {
    const block = getBlock(nextRoot, blockIndex, 0, state.blockCount);
    if (!block) throw new SourcePieceAdapterError("piece-state-conflict", `Missing metadata block ${blockIndex}.`);
    let leafDeltaRoot = block.leafDeltaRoot;
    for (const entry of entries) {
      const locator = state.leafLocators[entry.leaf.index];
      if (!locator || locator.blockIndex !== blockIndex) {
        throw new SourcePieceAdapterError("piece-state-conflict", `Missing local leaf locator ${entry.leaf.index}.`);
      }
      const baseLeaf = getLeafRecord(block.leafRoot, locator.localIndex, 0, block.leafCount);
      if (!baseLeaf) throw new SourcePieceAdapterError("piece-state-conflict", `Missing leaf ${entry.leaf.index}.`);
      const delta = entry.patches.reduce((sum, patch) => sum + patch.insert.length - patch.expected.length, 0);
      if (delta !== 0) leafDeltaRoot = addLeafDelta(leafDeltaRoot, locator.localIndex + 1, delta, 0, block.leafCount + 1);
    }
    if (leafDeltaRoot !== block.leafDeltaRoot) {
      // Leaf source text remains in the persistent source-piece rope.  The
      // baseline leaf records are reused, so a long leaf is never rebuilt on
      // every input; current text/length is derived from the local delta tree.
      const nextBlock = Object.freeze({ ...block, leafDeltaRoot });
      nextRoot = setBlock(nextRoot, blockIndex, 0, state.blockCount, nextBlock);
    }
  }
  return nextRoot;
}

function collectStepChanges(state: SourcePieceAdapterState, transaction: Transaction): readonly StepChange[] {
  const changes: StepChange[] = [];
  transaction.steps.forEach((step, stepIndex) => {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      const markedStep = step as AddMarkStep | RemoveMarkStep;
      const beforeFrom = mapStepPositionToTransactionBefore(transaction, stepIndex, markedStep.from, -1);
      const beforeTo = mapStepPositionToTransactionBefore(transaction, stepIndex, markedStep.to, 1);
      throw new SourcePieceAdapterError(
        "marks-changed",
        "The transaction changed marks outside the text-only source adapter slice.",
        { pmFrom: beforeFrom, pmTo: beforeTo },
      );
    }
    if (step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
      const markedStep = step as AddNodeMarkStep | RemoveNodeMarkStep;
      const beforePosition = mapStepPositionToTransactionBefore(transaction, stepIndex, markedStep.pos, -1);
      throw new SourcePieceAdapterError(
        "marks-changed",
        "The transaction changed a node mark outside the text-only source adapter slice.",
        { pmFrom: beforePosition, pmTo: beforePosition + 1 },
      );
    }
    if (step instanceof ReplaceAroundStep) {
      throw new SourcePieceAdapterError(
        "structure-changed",
        "Replace-around steps require a structure-aware source adapter.",
      );
    }
    if (!(step instanceof ReplaceStep)) {
      throw new SourcePieceAdapterError(
        "unsupported-step",
        `The source adapter does not have a proof for ${step.constructor.name || "an unknown"} document step.`,
      );
    }
    const replaceStructure = (step as unknown as { readonly structure?: boolean }).structure === true;
    if (replaceStructure || step.slice.openStart !== 0 || step.slice.openEnd !== 0) {
      throw new SourcePieceAdapterError(
        "structure-changed",
        "A structural or open-slice replace step requires a structure-aware source adapter.",
      );
    }
    const ranges: Array<{ oldFrom: number; oldTo: number }> = [];
    step.getMap().forEach((oldFrom, oldTo) => ranges.push({ oldFrom, oldTo }));
    if (ranges.length !== 1) {
      throw new SourcePieceAdapterError(
        "unsupported-step",
        "A replace step with multiple mapped ranges is outside the text-only source adapter slice.",
      );
    }
    const { oldFrom, oldTo } = ranges[0];
    const beforeFrom = mapStepPositionToTransactionBefore(transaction, stepIndex, oldFrom, -1);
    const beforeTo = mapStepPositionToTransactionBefore(transaction, stepIndex, oldTo, 1);
    if (beforeFrom > beforeTo) {
      throw new SourcePieceAdapterError(
        "unsupported-step",
        "The replace step produced an inverted source range.",
        { pmFrom: beforeFrom, pmTo: beforeTo },
      );
    }
    const leafIndex = findCurrentLeafCoveringRange(state, beforeFrom, beforeTo);
    if (leafIndex == null) {
      throw new SourcePieceAdapterError(
        "unsupported-inline",
        "A document-changing step is outside every parser-proven leaf.",
        { pmFrom: beforeFrom, pmTo: beforeTo },
      );
    }
    changes.push({ leafIndex, beforeFrom, beforeTo });
  });
  return Object.freeze(changes);
}

function buildChangedLeafPatches(
  state: SourcePieceAdapterState,
  transaction: Transaction,
  stepChanges: readonly StepChange[],
): ReadonlyMap<number, ChangedLeaf> {
  const grouped = new Map<number, LocalChange[]>();
  for (const change of stepChanges) {
    const leaf = getLeaf(state, change.leafIndex);
    if (!leaf) {
      throw new SourcePieceAdapterError(
        "source-leaf-not-found",
        `Missing current source leaf ${change.leafIndex}.`,
        { leafIndex: change.leafIndex },
      );
    }
    const group = grouped.get(change.leafIndex);
    const localChange = { leaf, beforeFrom: change.beforeFrom, beforeTo: change.beforeTo } satisfies LocalChange;
    if (group) group.push(localChange);
    else grouped.set(change.leafIndex, [localChange]);
  }

  const changed = new Map<number, ChangedLeaf>();
  for (const [leafIndex, entries] of grouped) {
    const leaf = entries[0].leaf;
    const merged = mergeLocalChanges(entries);
    const patches: SourcePiecePatch[] = [];
    for (const range of merged) {
      const leafRange = getCurrentLeafRange(state, leafIndex);
      if (range.beforeFrom < leafRange.from || range.beforeTo > leafRange.to) {
        throw new SourcePieceAdapterError(
          "unsupported-inline",
          `The mapped source range for leaf ${leafIndex} escaped its current PM span.`,
          { leafIndex, pmFrom: range.beforeFrom, pmTo: range.beforeTo },
        );
      }
      const afterFromResult = transaction.mapping.mapResult(range.beforeFrom, -1);
      const afterToResult = transaction.mapping.mapResult(range.beforeTo, 1);
      const afterFrom = afterFromResult.pos;
      const afterTo = afterToResult.pos;
      if (afterFrom > afterTo) {
        throw new SourcePieceAdapterError(
          "unsupported-step",
          `The mapped source range for leaf ${leafIndex} is inverted after the transaction.`,
          { leafIndex, pmFrom: afterFrom, pmTo: afterTo },
        );
      }
      const finalLeafFrom = transaction.mapping.map(leafRange.from, -1);
      const finalLeafTo = transaction.mapping.map(leafRange.to, 1);
      if (afterFrom < finalLeafFrom || afterTo > finalLeafTo) {
        throw new SourcePieceAdapterError(
          "structure-changed",
          `The transaction range for leaf ${leafIndex} crossed its final PM span.`,
          { leafIndex, pmFrom: afterFrom, pmTo: afterTo },
        );
      }
      assertLocalStructureUnchanged(
        state.doc,
        transaction.doc,
        { from: range.beforeFrom, to: range.beforeTo },
        { from: afterFrom, to: afterTo },
        leafIndex,
      );
      const text = transaction.doc.textBetween(afterFrom, afterTo, "\n", "\uFFFC");
      if (text.includes("\n") || text.includes("\uFFFC")) {
        throw new SourcePieceAdapterError(
          "structure-changed",
          `Transaction range for leaf ${leafIndex} crosses a block boundary.`,
          { leafIndex, pmFrom: afterFrom, pmTo: afterTo },
        );
      }
      const marks = collectMarks(transaction.doc, afterFrom, afterTo);
      if (text.length > 0 && !sameMarks(leaf.marks, marks)) {
        throw new SourcePieceAdapterError(
          "marks-changed",
          `Transaction changed marks for source leaf ${leafIndex}.`,
          { leafIndex, pmFrom: afterFrom, pmTo: afterTo, expected: leaf.marks.join("|"), actual: marks.join("|") },
        );
      }

      const relativeFrom = range.beforeFrom - leafRange.from;
      const relativeTo = range.beforeTo - leafRange.from;
      const currentTextLength = leaf.pieceTo - leaf.pieceFrom;
      const blockId = blockIdForIndex(leaf.blockIndex);
      let pieceFrom: number;
      let pieceTo: number;
      let insert: string;
      if (leaf.emptySlot && currentTextLength === 0 && relativeFrom === 0 && relativeTo === 0) {
        // An empty cell's padding belongs to its unique parser span.  The
        // first insertion replaces that span atomically while keeping the
        // padding bytes around the newly inserted content.
        pieceFrom = leaf.spanFrom;
        pieceTo = leaf.spanTo;
        insert = `${leaf.leadingPadding}${text}${leaf.trailingPadding}`;
      } else {
        if (relativeFrom < 0 || relativeTo < relativeFrom || relativeTo > currentTextLength) {
          throw new SourcePieceAdapterError(
            "unsupported-inline",
            `The mapped source range for leaf ${leafIndex} escaped its current piece span.`,
            { leafIndex, pmFrom: range.beforeFrom, pmTo: range.beforeTo },
          );
        }
        pieceFrom = leaf.pieceFrom + relativeFrom;
        pieceTo = leaf.pieceFrom + relativeTo;
        insert = text;
      }
      let expected: string;
      try {
        expected = getSourcePieceBlockSlice(state.source, blockId, pieceFrom, pieceTo);
      } catch (error) {
        if (error instanceof Error) {
          throw new SourcePieceAdapterError("piece-state-conflict", error.message, { leafIndex, cause: error.name });
        }
        throw error;
      }
      patches.push({ blockId, pieceFrom, pieceTo, expected, insert });
    }
    changed.set(leafIndex, Object.freeze({ leaf, patches: Object.freeze(patches) }));
  }
  return changed;
}

function mergeLocalChanges(entries: readonly LocalChange[]): readonly LocalChange[] {
  const ordered = [...entries].sort((left, right) =>
    left.beforeFrom - right.beforeFrom || left.beforeTo - right.beforeTo,
  );
  const merged: LocalChange[] = [];
  for (const entry of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || entry.beforeFrom > previous.beforeTo) {
      merged.push(entry);
      continue;
    }
    merged[merged.length - 1] = {
      leaf: previous.leaf,
      beforeFrom: previous.beforeFrom,
      beforeTo: Math.max(previous.beforeTo, entry.beforeTo),
    };
  }
  return merged;
}

function mapStepPositionToTransactionBefore(
  transaction: Transaction,
  stepIndex: number,
  position: number,
  assoc: -1 | 1,
) {
  let mapped = position;
  for (let index = stepIndex - 1; index >= 0; index -= 1) {
    mapped = transaction.mapping.maps[index].invert().mapResult(mapped, assoc).pos;
  }
  return mapped;
}

function findCurrentLeafCoveringRange(state: SourcePieceAdapterState, from: number, to: number) {
  const leaves = state.baseline.leaves;
  if (leaves.length === 0) return null;
  let low = 0;
  let high = leaves.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const range = getCurrentLeafRange(state, middle);
    if (range.to < to) low = middle + 1;
    else high = middle;
  }
  if (from !== to) {
    const candidate = leaves[low];
    if (!candidate) return null;
    const range = getCurrentLeafRange(state, candidate.index);
    return range.from <= from && to <= range.to ? candidate.index : null;
  }
  const candidates: number[] = [];
  const start = Math.max(0, low - 2);
  const end = Math.min(leaves.length - 1, low + 2);
  for (let index = start; index <= end; index += 1) {
    const range = getCurrentLeafRange(state, index);
    if (range.from <= from && from <= range.to) candidates.push(index);
  }
  if (candidates.length === 1) return candidates[0];
  const empty = candidates.filter((index) => {
    const leaf = leaves[index];
    return leaf.pmFrom === leaf.pmTo && getCurrentLeafRange(state, index).from === from;
  });
  if (empty.length === 1) return empty[0];
  const ends = candidates.filter((index) => getCurrentLeafRange(state, index).to === from && leaves[index].pmFrom < leaves[index].pmTo);
  if (ends.length === 1) return ends[0];
  const starts = candidates.filter((index) => getCurrentLeafRange(state, index).from === from && leaves[index].pmFrom < leaves[index].pmTo);
  if (starts.length === 1) return starts[0];
  return null;
}

function assertLocalStructureUnchanged(
  beforeDoc: ProseMirrorNode,
  afterDoc: ProseMirrorNode,
  beforeRange: { readonly from: number; readonly to: number },
  afterRange: { readonly from: number; readonly to: number },
  leafIndex: number,
) {
  const beforeSpine = structuralSpine(beforeDoc, beforeRange.from);
  const afterSpine = structuralSpine(afterDoc, afterRange.from);
  if (beforeSpine !== afterSpine) {
    throw new SourcePieceAdapterError(
      "structure-changed",
      `Transaction changed the structural ancestor spine for source leaf ${leafIndex}.`,
      { leafIndex, pmFrom: beforeRange.from, pmTo: beforeRange.to },
    );
  }
}

/** Compare only the changed leaf's ancestor spine; never serialize the doc. */
function structuralSpine(doc: ProseMirrorNode, position: number) {
  const bounded = Math.max(0, Math.min(position, doc.content.size));
  const resolved = doc.resolve(bounded);
  const entries: unknown[] = [];
  for (let depth = 0; depth <= resolved.depth; depth += 1) {
    const node = resolved.node(depth);
    entries.push({
      type: node.type.name,
      attrs: node.attrs || null,
      index: depth < resolved.depth ? resolved.index(depth) : 0,
      // Textblock content length/child count is intentionally ignored;
      // paragraph text edits can split/merge text nodes without changing the
      // structural spine. Non-text parent counts catch list/table/block
      // structure edits without walking their whole child arrays.
      structuralChildCount: node.isTextblock ? 0 : node.childCount,
    });
  }
  return JSON.stringify(entries);
}

function getLeaf(state: SourcePieceAdapterState, leafIndex: number) {
  const locator = state.leafLocators[leafIndex];
  if (!locator) return undefined;
  const block = getBlock(state.blockRoot, locator.blockIndex, 0, state.blockCount);
  const leaf = block ? getLeafRecord(block.leafRoot, locator.localIndex, 0, block.leafCount) : undefined;
  return leaf && block ? materializeCurrentLeaf(block, leaf, locator.localIndex) : undefined;
}

function getCurrentLeafRange(state: SourcePieceAdapterState, leafIndex: number) {
  const baseline = state.baseline.leaves[leafIndex];
  if (!baseline) return { from: 0, to: 0 };
  const before = prefixLeafDelta(state.leafDeltaRoot, leafIndex, 0, state.leafLocators.length + 1);
  const through = prefixLeafDelta(state.leafDeltaRoot, leafIndex + 1, 0, state.leafLocators.length + 1);
  return {
    from: baseline.pmFrom + before,
    to: baseline.pmTo + through,
  };
}

function addLeafDelta(root: LeafDeltaTree | null, index: number, delta: number, from: number, to: number): LeafDeltaTree | null {
  if (from >= to || index < from || index >= to || delta === 0) return root;
  const middle = from + Math.floor((to - from) / 2);
  if (index === middle) {
    return Object.freeze({
      left: root?.left ?? null,
      right: root?.right ?? null,
      sum: (root?.sum ?? 0) + delta,
    });
  }
  if (index < middle) {
    return Object.freeze({
      left: addLeafDelta(root?.left ?? null, index, delta, from, middle),
      right: root?.right ?? null,
      sum: (root?.sum ?? 0) + delta,
    });
  }
  return Object.freeze({
    left: root?.left ?? null,
    right: addLeafDelta(root?.right ?? null, index, delta, middle + 1, to),
    sum: (root?.sum ?? 0) + delta,
  });
}

function prefixLeafDelta(root: LeafDeltaTree | null, index: number, from: number, to: number): number {
  if (!root || index < from) return 0;
  if (index >= to) return root.sum;
  const middle = from + Math.floor((to - from) / 2);
  const leftSum = root.left?.sum ?? 0;
  const rightSum = root.right?.sum ?? 0;
  const own = root.sum - leftSum - rightSum;
  if (index < middle) return prefixLeafDelta(root.left, index, from, middle);
  if (index === middle) return leftSum + own;
  return leftSum + own + prefixLeafDelta(root.right, index, middle + 1, to);
}

function buildLeafRecordTree(values: readonly SourcePieceAdapterLeaf[], from: number, to: number): LeafRecordTree | null {
  if (from >= to) return null;
  const middle = from + Math.floor((to - from) / 2);
  return Object.freeze({
    left: buildLeafRecordTree(values, from, middle),
    right: buildLeafRecordTree(values, middle + 1, to),
    value: values[middle],
  });
}

function getLeafRecord(root: LeafRecordTree | null, index: number, from: number, to: number): SourcePieceAdapterLeaf | undefined {
  if (!root || from >= to) return undefined;
  const middle = from + Math.floor((to - from) / 2);
  if (index === middle) return root.value ?? undefined;
  return index < middle
    ? getLeafRecord(root.left, index, from, middle)
    : getLeafRecord(root.right, index, middle + 1, to);
}

function materializeCurrentLeaf(
  block: SourcePieceAdapterBlock,
  leaf: SourcePieceAdapterLeaf,
  localIndex: number,
): SourcePieceAdapterLeaf {
  const before = prefixLeafDelta(block.leafDeltaRoot, localIndex, 0, block.leafCount + 1);
  const through = prefixLeafDelta(block.leafDeltaRoot, localIndex + 1, 0, block.leafCount + 1);
  const currentTextLength = leaf.text.length + through - before;
  const spanFrom = leaf.spanFrom + before;
  const spanTo = leaf.spanTo + through;
  const pieceFrom = spanFrom + leaf.leadingPadding.length;
  return Object.freeze({
    ...leaf,
    pieceFrom,
    pieceTo: pieceFrom + currentTextLength,
    spanFrom,
    spanTo,
  });
}

/** Explicit inspection materializes only this leaf's current text. */
function materializePublicLeaf(
  state: SourcePieceAdapterState,
  block: SourcePieceAdapterBlock,
  leaf: SourcePieceAdapterLeaf,
  localIndex: number,
): SourcePieceAdapterLeaf {
  const current = materializeCurrentLeaf(block, leaf, localIndex);
  const text = getSourcePieceBlockSlice(state.source, block.id, current.pieceFrom, current.pieceTo);
  return Object.freeze({ ...current, text });
}

function buildBlockTree(values: readonly SourcePieceAdapterBlock[], from: number, to: number): BlockTree | null {
  if (from >= to) return null;
  const middle = from + Math.floor((to - from) / 2);
  return Object.freeze({
    left: buildBlockTree(values, from, middle),
    right: buildBlockTree(values, middle + 1, to),
    value: values[middle],
  });
}

function getBlock(root: BlockTree | null, index: number, from: number, to: number): SourcePieceAdapterBlock | undefined {
  if (!root || from >= to) return undefined;
  const middle = from + Math.floor((to - from) / 2);
  if (index === middle) return root.value ?? undefined;
  return index < middle ? getBlock(root.left, index, from, middle) : getBlock(root.right, index, middle + 1, to);
}

function setBlock(root: BlockTree | null, index: number, from: number, to: number, value: SourcePieceAdapterBlock): BlockTree | null {
  if (!root || from >= to) return root;
  const middle = from + Math.floor((to - from) / 2);
  if (index === middle) return Object.freeze({ left: root.left, right: root.right, value });
  if (index < middle) return Object.freeze({ left: setBlock(root.left, index, from, middle, value), right: root.right, value: root.value });
  return Object.freeze({ left: root.left, right: setBlock(root.right, index, middle + 1, to, value), value: root.value });
}

function blockIdForIndex(index: number) {
  return `source-block:${index}`;
}

function collectMarks(doc: ProseMirrorNode, from: number, to: number) {
  const marks: string[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      const fingerprint = `${mark.type.name}:${JSON.stringify(mark.attrs || {})}`;
      if (!marks.includes(fingerprint)) marks.push(fingerprint);
    }
  });
  return marks.sort();
}

function sameMarks(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((mark, index) => mark === right[index]);
}

/** Shape excludes text content and marks; marks are checked per leaf. */
function documentStructure(node: ProseMirrorNode): string {
  const json = node.toJSON() as Record<string, unknown>;
  return JSON.stringify(stripText(json));
}

function stripText(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(item && typeof item === "object" && (item as Record<string, unknown>).type === "text"))
      .map(stripText);
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "text") continue;
    const stripped = stripText(child);
    if (key === "content" && Array.isArray(stripped) && stripped.length === 0) continue;
    result[key] = stripped;
  }
  return result;
}
