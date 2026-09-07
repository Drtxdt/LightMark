import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-source-piece-"));

try {
  const compiled = compileTypeScriptModuleGraph(path.resolve("src/editor/sourcePieceState.ts"), tempDir);
  const piece = await import(pathToFileURL(compiled).href);
  const {
    SourcePieceStateError,
    applySourcePiecePatchBatch,
    createSourcePieceState,
    getSourcePieceBlockRoot,
    getSourcePieceBlockLength,
    getSourcePieceBlockText,
    getSourcePieceDelta,
    getSourcePieceHistoryLengths,
    materializeSourcePiece,
    materializeSourcePieceCheckpoint,
    redoSourcePiece,
    undoSourcePiece,
  } = piece;

  const errorCode = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof SourcePieceStateError, error);
      return error.code;
    }
    assert.fail("expected a typed source-piece failure");
  };

  assert.equal(errorCode(() => createSourcePieceState([{ id: "bad", source: "\uD800", separator: "" }], "doc-bad")), "invalid-unpaired-surrogate");

  const sourceBlocks = [
    { id: "bom", source: "\uFEFFa😀\r\nb", separator: "\r\n" },
    { id: "empty", source: "", separator: "\n" },
    { id: "mixed", source: "c\rd\n", separator: "" },
  ];
  let state = createSourcePieceState(sourceBlocks, "doc-main");
  const initial = materializeSourcePiece(state);
  assert.equal(initial.source, "\uFEFFa😀\r\nb\r\n\nc\rd\n");
  assert.deepEqual(initial.blocks.map(({ id, source, separator }) => ({ id, source, separator })), sourceBlocks);
  assert.equal(initial.cost.blocksVisited, 3);
  assert.equal(initial.cost.separatorUtf16Units, 3);
  assert.equal(getSourcePieceBlockText(state, "empty"), "");

  // Two patches in one block use before-batch coordinates. The BOM, emoji and
  // mixed line endings remain ordinary UTF-16 source units in the piece.
  const bomRootBefore = getSourcePieceBlockRoot(state, "bom");
  const mixedRootBefore = getSourcePieceBlockRoot(state, "mixed");
  state = applySourcePiecePatchBatch(state, {
    documentId: "doc-main",
    beforeRevision: 0,
    transactionId: "multi-bom",
    patches: [
      { blockId: "bom", pieceFrom: 1, pieceTo: 2, expected: "a", insert: "A" },
      { blockId: "bom", pieceFrom: 6, pieceTo: 7, expected: "b", insert: "B" },
    ],
  });
  assert.equal(materializeSourcePiece(state).source, "\uFEFFA😀\r\nB\r\n\nc\rd\n");
  assert.equal(getSourcePieceBlockRoot(state, "mixed"), mixedRootBefore, "untouched block piece root must be reused");
  assert.notEqual(getSourcePieceBlockRoot(state, "bom"), bomRootBefore, "edited block must receive a persistent root");
  assert.deepEqual(getSourcePieceDelta(state).forward, [
    { blockId: "bom", pieceFrom: 1, pieceTo: 2, expected: "a", insert: "A" },
    { blockId: "bom", pieceFrom: 6, pieceTo: 7, expected: "b", insert: "B" },
  ]);

  // Different-length patches in one block compute inverse coordinates in the
  // after-batch piece view, not by reusing the before-batch positions.
  let variableState = state;
  variableState = applySourcePiecePatchBatch(variableState, {
    documentId: "doc-main",
    beforeRevision: variableState.revision,
    patches: [
      { blockId: "bom", pieceFrom: 1, pieceTo: 2, expected: "A", insert: "AAA" },
      { blockId: "bom", pieceFrom: 6, pieceTo: 7, expected: "B", insert: "" },
    ],
  });
  assert.equal(getSourcePieceBlockText(variableState, "bom"), "\uFEFFAAA😀\r\n");
  assert.deepEqual(getSourcePieceDelta(variableState).inverse, [
    { blockId: "bom", pieceFrom: 1, pieceTo: 4, expected: "AAA", insert: "A" },
    { blockId: "bom", pieceFrom: 8, pieceTo: 8, expected: "", insert: "B" },
  ]);
  assert.equal(getSourcePieceBlockText(undoSourcePiece(variableState), "bom"), "\uFEFFA😀\r\nB");
  assert.equal(getSourcePieceBlockText(redoSourcePiece(undoSourcePiece(variableState)), "bom"), "\uFEFFAAA😀\r\n");

  // A bad expected fragment or overlap must leave every block and revision
  // untouched, including a valid patch earlier in the same batch.
  const failedState = state;
  const failedRoot = getSourcePieceBlockRoot(state, "bom");
  assert.equal(errorCode(() => applySourcePiecePatchBatch(state, {
    documentId: "doc-main",
    beforeRevision: state.revision,
    patches: [
      { blockId: "bom", pieceFrom: 1, pieceTo: 2, expected: "A", insert: "X" },
      { blockId: "mixed", pieceFrom: 0, pieceTo: 1, expected: "wrong", insert: "Y" },
    ],
  })), "expected-mismatch");
  assert.equal(state, failedState);
  assert.equal(getSourcePieceBlockRoot(state, "bom"), failedRoot);
  assert.equal(errorCode(() => applySourcePiecePatchBatch(state, {
    documentId: "doc-main",
    beforeRevision: state.revision,
    patches: [
      { blockId: "bom", pieceFrom: 1, pieceTo: 4, expected: "A😀", insert: "x" },
      { blockId: "bom", pieceFrom: 2, pieceTo: 4, expected: "😀", insert: "y" },
    ],
  })), "patch-overlap");
  assert.equal(errorCode(() => applySourcePiecePatchBatch(state, {
    documentId: "doc-main",
    beforeRevision: state.revision,
    patches: [{ blockId: "bom", pieceFrom: 3, pieceTo: 3, expected: "", insert: "x" }],
  })), "invalid-utf16-boundary");
  assert.equal(errorCode(() => applySourcePiecePatchBatch(state, {
    documentId: "doc-main",
    beforeRevision: state.revision,
    patches: [{ blockId: "bom", pieceFrom: 1, pieceTo: 1, expected: "", insert: "\uD800" }],
  })), "invalid-unpaired-surrogate");
  assert.equal(errorCode(() => applySourcePiecePatchBatch(state, {
    documentId: "doc-main",
    beforeRevision: 0,
    patches: [{ blockId: "bom", pieceFrom: 0, pieceTo: 0, expected: "", insert: "x" }],
  })), "stale-revision");
  assert.equal(errorCode(() => applySourcePiecePatchBatch(state, {
    documentId: "other-document",
    beforeRevision: state.revision,
    patches: [{ blockId: "bom", pieceFrom: 0, pieceTo: 0, expected: "", insert: "x" }],
  })), "document-mismatch");

  // Empty block insertion and a second block change in one atomic batch.
  state = applySourcePiecePatchBatch(state, {
    documentId: "doc-main",
    beforeRevision: state.revision,
    transactionId: "empty-and-mixed",
    patches: [
      { blockId: "empty", pieceFrom: 0, pieceTo: 0, expected: "", insert: "\uFEFF中" },
      { blockId: "mixed", pieceFrom: 1, pieceTo: 2, expected: "\r", insert: "\n" },
    ],
  });
  assert.equal(materializeSourcePiece(state).source, "\uFEFFA😀\r\nB\r\n\uFEFF中\nc\nd\n");
  assert.equal(getSourcePieceBlockText(state, "mixed"), "c\nd\n");

  const beforeUndo = materializeSourcePiece(state).source;
  const afterUndo = undoSourcePiece(state);
  assert.equal(materializeSourcePiece(afterUndo).source, "\uFEFFA😀\r\nB\r\n\nc\rd\n");
  assert.equal(afterUndo.revision, state.revision + 1);
  assert.deepEqual(getSourcePieceHistoryLengths(afterUndo), { undo: 1, redo: 1 });
  const afterRedo = redoSourcePiece(afterUndo);
  assert.equal(materializeSourcePiece(afterRedo).source, beforeUndo);
  assert.equal(afterRedo.revision, afterUndo.revision + 1);
  assert.deepEqual(getSourcePieceHistoryLengths(afterRedo), { undo: 2, redo: 0 });

  // Adjacent before-batch deletions produce two inverse insertions at one
  // after-batch offset; applying inverse right-to-left must restore order.
  let adjacent = createSourcePieceState([{ id: "adj", source: "abcdef", separator: "" }], "doc-adjacent");
  adjacent = applySourcePiecePatchBatch(adjacent, {
    documentId: "doc-adjacent",
    beforeRevision: 0,
    patches: [
      { blockId: "adj", pieceFrom: 1, pieceTo: 2, expected: "b", insert: "" },
      { blockId: "adj", pieceFrom: 2, pieceTo: 3, expected: "c", insert: "" },
    ],
  });
  assert.equal(getSourcePieceBlockText(adjacent, "adj"), "adef");
  assert.deepEqual(getSourcePieceDelta(adjacent).inverse, [
    { blockId: "adj", pieceFrom: 1, pieceTo: 1, expected: "", insert: "b" },
    { blockId: "adj", pieceFrom: 1, pieceTo: 1, expected: "", insert: "c" },
  ]);
  const adjacentUndo = undoSourcePiece(adjacent);
  assert.equal(getSourcePieceBlockText(adjacentUndo, "adj"), "abcdef");
  assert.equal(getSourcePieceBlockText(redoSourcePiece(adjacentUndo), "adj"), "adef");

  // A new branch after undo discards redo rather than applying an unrelated
  // forward delta to the changed piece root.
  let branched = undoSourcePiece(state);
  branched = applySourcePiecePatchBatch(branched, {
    documentId: "doc-main",
    beforeRevision: branched.revision,
    patches: [{ blockId: "empty", pieceFrom: 0, pieceTo: 0, expected: "", insert: "branch" }],
  });
  assert.deepEqual(getSourcePieceHistoryLengths(branched), { undo: 2, redo: 0 });
  assert.equal(errorCode(() => redoSourcePiece(branched)), "history-empty");

  // Checkpoint rebuilds piece roots and base descriptors but keeps inverse
  // history usable. This is an explicit materialization boundary, not an
  // operation performed by every input transaction.
  const checkpoint = materializeSourcePieceCheckpoint(afterRedo);
  assert.equal(checkpoint.materialization.source, beforeUndo);
  assert.equal(materializeSourcePiece(checkpoint.state).source, beforeUndo);
  assert.equal(checkpoint.state.base.checkpointId, "doc-main:source-piece-checkpoint-1");
  assert.notEqual(getSourcePieceBlockRoot(checkpoint.state, "bom"), getSourcePieceBlockRoot(afterRedo, "bom"));
  const undoneCheckpoint = undoSourcePiece(checkpoint.state);
  assert.equal(materializeSourcePiece(undoneCheckpoint).source, "\uFEFFA😀\r\nB\r\n\nc\rd\n");

  // A consumer can replay the transition delta, including the post-checkpoint
  // undo/redo events. The history entry remains the original operation, while
  // the exposed transition always spans the current state revision.
  let eventState = createSourcePieceState([{ id: "event", source: "abc", separator: "" }], "doc-events");
  let eventReplay = createSourcePieceState([{ id: "event", source: "abc", separator: "" }], "doc-events");
  const consumeEvent = (nextState, expectedSource) => {
    const delta = getSourcePieceDelta(nextState);
    assert.ok(delta);
    assert.equal(delta.documentId, "doc-events");
    assert.equal(delta.beforeRevision, nextState.revision - 1);
    assert.equal(delta.afterRevision, nextState.revision);
    eventReplay = applySourcePiecePatchBatch(eventReplay, {
      documentId: "doc-events",
      beforeRevision: eventReplay.revision,
      patches: delta.forward,
    });
    assert.equal(materializeSourcePiece(nextState).source, expectedSource);
    assert.equal(materializeSourcePiece(eventReplay).source, expectedSource);
  };
  eventState = applySourcePiecePatchBatch(eventState, {
    documentId: "doc-events",
    beforeRevision: eventState.revision,
    transactionId: "event-edit",
    patches: [{ blockId: "event", pieceFrom: 1, pieceTo: 2, expected: "b", insert: "B" }],
  });
  consumeEvent(eventState, "aBc");
  const eventCheckpoint = materializeSourcePieceCheckpoint(eventState);
  eventState = eventCheckpoint.state;
  eventReplay = materializeSourcePieceCheckpoint(eventReplay).state;
  assert.equal(getSourcePieceDelta(eventState), null);
  eventState = undoSourcePiece(eventState);
  consumeEvent(eventState, "abc");
  assert.equal(getSourcePieceDelta(eventState).forward[0].insert, "b");
  eventState = redoSourcePiece(eventState);
  consumeEvent(eventState, "aBc");
  assert.equal(getSourcePieceDelta(eventState).forward[0].insert, "B");

  // Deterministic multi-block differential oracle. Inserts deliberately use
  // Unicode and line-ending code units; the engine must match String.slice.
  const randomBlocks = [
    { id: "r0", source: "\uFEFFab\r\n", separator: "\n" },
    { id: "r1", source: "😀中\nc", separator: "\r\n" },
    { id: "r2", source: "", separator: "" },
    { id: "r3", source: "x\ry\n", separator: "\r" },
  ];
  const model = new Map(randomBlocks.map((block) => [block.id, block.source]));
  let randomState = createSourcePieceState(randomBlocks, "doc-random");
  const oracleStack = [randomBlocks.map(({ id, separator }) => `${model.get(id)}${separator}`).join("")];
  let randomSeed = 0x1a2b3c4d;
  const nextRandom = () => {
    randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0;
    return randomSeed;
  };
  const alphabet = ["a", "Z", "中", "😀", "\r", "\n", "\uFEFF"];
  const randomText = () => {
    let result = "";
    for (let i = 0; i < nextRandom() % 4; i += 1) result += alphabet[nextRandom() % alphabet.length];
    return result;
  };
  const utf16Boundaries = (value) => {
    const result = [0];
    for (let index = 1; index < value.length; index += 1) {
      const before = value.charCodeAt(index - 1);
      const after = value.charCodeAt(index);
      if (!(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)) result.push(index);
    }
    result.push(value.length);
    return result;
  };
  const ids = randomBlocks.map(({ id }) => id);
  for (let operation = 0; operation < 320; operation += 1) {
    const chosen = [];
    const count = 1 + (nextRandom() % 3);
    while (chosen.length < count) {
      const id = ids[nextRandom() % ids.length];
      if (!chosen.includes(id)) chosen.push(id);
    }
    const patches = chosen.map((id) => {
      const value = model.get(id);
      const boundaries = utf16Boundaries(value);
      const fromIndex = nextRandom() % boundaries.length;
      const toIndex = fromIndex + (nextRandom() % (boundaries.length - fromIndex));
      const from = boundaries[fromIndex];
      const to = boundaries[toIndex];
      return {
        blockId: id,
        pieceFrom: from,
        pieceTo: to,
        expected: value.slice(from, to),
        insert: randomText(),
      };
    });
    const changed = patches.some((patch) => patch.expected !== patch.insert);
    const beforeOracle = randomBlocks.map(({ id, separator }) => `${model.get(id)}${separator}`).join("");
    randomState = applySourcePiecePatchBatch(randomState, {
      documentId: "doc-random",
      beforeRevision: randomState.revision,
      transactionId: `random-${operation}`,
      patches,
    });
    for (const patch of patches) {
      const value = model.get(patch.blockId);
      model.set(patch.blockId, value.slice(0, patch.pieceFrom) + patch.insert + value.slice(patch.pieceTo));
    }
    const afterOracle = randomBlocks.map(({ id, separator }) => `${model.get(id)}${separator}`).join("");
    if (!changed) assert.equal(afterOracle, beforeOracle);
    else oracleStack.push(afterOracle);
    if (operation % 37 === 0) {
      const materialized = materializeSourcePiece(randomState);
      assert.equal(materialized.source, randomBlocks.map(({ id, separator }) => `${model.get(id)}${separator}`).join(""));
    }
    if (operation === 119 || operation === 239) {
      const checkpointState = materializeSourcePieceCheckpoint(randomState);
      randomState = checkpointState.state;
      assert.equal(checkpointState.materialization.source, randomBlocks.map(({ id, separator }) => `${model.get(id)}${separator}`).join(""));
    }
  }
  assert.equal(
    materializeSourcePiece(randomState).source,
    randomBlocks.map(({ id, separator }) => `${model.get(id)}${separator}`).join(""),
  );

  // Checkpoint boundaries do not discard the persistent history chain. Walk
  // the actual state back to the initial oracle, then forward to the final
  // oracle and compare every materialized source.
  let walked = randomState;
  for (let index = oracleStack.length - 2; index >= 0; index -= 1) {
    walked = undoSourcePiece(walked);
    assert.equal(materializeSourcePiece(walked).source, oracleStack[index], `random undo ${index}`);
  }
  assert.deepEqual(getSourcePieceHistoryLengths(walked), { undo: 0, redo: oracleStack.length - 1 });
  for (let index = 1; index < oracleStack.length; index += 1) {
    walked = redoSourcePiece(walked);
    assert.equal(materializeSourcePiece(walked).source, oracleStack[index], `random redo ${index}`);
  }
  assert.deepEqual(getSourcePieceHistoryLengths(walked), { undo: oracleStack.length - 1, redo: 0 });

  // Keep input and explicit materialization measurements separate. These are
  // diagnostics only; this check intentionally has no frame-budget claim.
  let longState = createSourcePieceState([{ id: "long", source: "a".repeat(256 * 1024), separator: "\r\n" }], "doc-long");
  const inputStart = performance.now();
  for (let index = 0; index < 160; index += 1) {
    const from = getSourcePieceBlockLength(longState, "long");
    longState = applySourcePiecePatchBatch(longState, {
      documentId: "doc-long",
      beforeRevision: longState.revision,
      patches: [{ blockId: "long", pieceFrom: from, pieceTo: from, expected: "", insert: "😀" }],
    });
  }
  const inputElapsedMs = performance.now() - inputStart;
  const materializeStart = performance.now();
  const longMaterialization = materializeSourcePiece(longState);
  const materializeElapsedMs = performance.now() - materializeStart;
  assert.equal(longMaterialization.source.length, 256 * 1024 + 160 * 2 + 2);
  assert.ok(longState.operationCost.nodesCreated > 0);
  assert.ok(longMaterialization.cost.copiedUtf16Units >= 256 * 1024);
  console.log(JSON.stringify({
    input: {
      operations: 160,
      elapsedMs: Number(inputElapsedMs.toFixed(3)),
      lastOperationCost: longState.operationCost,
    },
    materialize: {
      elapsedMs: Number(materializeElapsedMs.toFixed(3)),
      cost: longMaterialization.cost,
    },
  }));
  console.log("source piece state checks passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
