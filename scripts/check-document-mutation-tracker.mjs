import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { EditorState, Plugin } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-document-tracker-"));
const modulePath = path.join(tempDir, "documentMutationTracker.mjs");

try {
  fs.writeFileSync(modulePath, ts.transpileModule(
    fs.readFileSync(path.join(root, "src", "editor", "documentMutationTracker.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: false,
      },
    },
  ).outputText, "utf8");

  const {
    createDocumentMutationTracker,
    documentMutationTokensEqual,
    DOCUMENT_APPENDED_TRANSACTION_META_KEY,
    DOCUMENT_FLUSH_META_KEY,
  } = await import(pathToFileURL(modulePath).href);
  const sessionIdentity = {};
  const tracker = createDocumentMutationTracker({ sessionIdentity, initialRevision: 4 });
  const initial = tracker.token();
  assert.deepEqual(initial, {
    documentGeneration: 0,
    pendingInputVersion: 0,
    revision: 4,
  });
  assert.equal(documentMutationTokensEqual(initial, tracker.token()), true);

  const successfulFlush = tracker.beginFlush(initial);
  assert.equal(tracker.activeFlushId, successfulFlush.id);
  tracker.recordDocumentChange({ kind: "pending-flush", flushId: successfulFlush.id });
  tracker.setRevision(5);
  const successfulAfter = tracker.token();
  const successfulReceipt = successfulFlush.complete(successfulAfter);
  assert.equal(successfulReceipt.sessionIdentity, sessionIdentity);
  assert.equal(successfulReceipt.flushId, successfulFlush.id);
  assert.equal(successfulReceipt.authorizedMutationCount, 1);
  assert.equal(successfulReceipt.firstAuthorizedGeneration, 1);
  assert.equal(successfulReceipt.lastAuthorizedGeneration, 1);
  assert.equal(tracker.activeFlushId, null, "completed flushes release their bounded ledger");
  assert.throws(() => successfulFlush.complete(), /已结束/);

  const appendedFlush = tracker.beginFlush(tracker.token());
  tracker.recordDocumentChange({ kind: "pending-flush", flushId: appendedFlush.id });
  tracker.recordDocumentChange({ kind: "pending-flush", flushId: appendedFlush.id });
  tracker.setRevision(6);
  const appendedReceipt = appendedFlush.complete();
  assert.equal(appendedReceipt.authorizedMutationCount, 2, "root and explicitly tagged appended transactions are both counted");
  assert.equal(appendedReceipt.lastAuthorizedGeneration, 3);

  const externalDuringFlush = tracker.beginFlush(tracker.token());
  tracker.recordDocumentChange({ kind: "pending-flush", flushId: externalDuringFlush.id });
  tracker.recordDocumentChange({ kind: "document" });
  tracker.setRevision(8);
  assert.throws(
    () => externalDuringFlush.complete(),
    /未授权变化|来源无法证明/,
    "an untagged appended or external document transaction invalidates the flush",
  );
  assert.equal(tracker.activeFlushId, null, "a failed receipt releases the bounded ledger");

  const pendingInputDuringFlush = tracker.beginFlush(tracker.token());
  tracker.recordPendingInput();
  assert.throws(
    () => pendingInputDuringFlush.complete(),
    /未授权变化|来源无法证明/,
    "new composition or pending input invalidates the flush even without a document revision",
  );
  assert.equal(tracker.activeFlushId, null);

  const wrongOriginFlush = tracker.beginFlush(tracker.token());
  tracker.recordDocumentChange({ kind: "pending-flush", flushId: "another-flush" });
  tracker.setRevision(9);
  assert.throws(() => wrongOriginFlush.complete(), /未授权变化|来源无法证明/);
  assert.equal(tracker.activeFlushId, null);

  const staleExpected = tracker.token();
  tracker.recordDocumentChange();
  assert.throws(() => tracker.beginFlush(staleExpected), /开始前已变化/);
  assert.equal(tracker.activeFlushId, null);

  const failedFlush = tracker.beginFlush(tracker.token());
  failedFlush.fail();
  assert.equal(tracker.activeFlushId, null, "explicit flush failure releases its active ledger");
  const reusableFlush = tracker.beginFlush(tracker.token());
  reusableFlush.fail();

  const schema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: {
        content: "inline*",
        group: "block",
        toDOM: () => ["p", 0],
      },
      text: { group: "inline" },
    },
  });
  const doc = schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, schema.text("a")),
  ]);
  const appendPlugin = new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      const root = transactions[0];
      if (!root?.getMeta(DOCUMENT_FLUSH_META_KEY) || !transactions.some((item) => item.docChanged)) return null;
      return newState.tr.insertText("!", 1);
    },
  });
  const pmState = EditorState.create({ schema, doc, plugins: [appendPlugin] });
  const pmRoot = pmState.tr
    .insertText("x", 1)
    .setMeta(DOCUMENT_FLUSH_META_KEY, "pm-flush");
  const applied = pmState.applyTransaction(pmRoot);
  assert.equal(applied.transactions.length, 2, "the PM plugin must produce one appended transaction");
  const pmAppended = applied.transactions[1];
  assert.equal(
    pmAppended.getMeta(DOCUMENT_APPENDED_TRANSACTION_META_KEY),
    applied.transactions[0],
    "Tiptap/PM must link an appended transaction to the root transaction",
  );
  const pmTracker = createDocumentMutationTracker({ sessionIdentity: {} });
  const pmFlush = pmTracker.beginFlush(pmTracker.token());
  const rootIsTagged = pmRoot.getMeta(DOCUMENT_FLUSH_META_KEY) === pmFlush.id;
  // Rebind the real PM transaction's metadata to the active receipt id, as
  // the production Math flush does before dispatching its root transaction.
  const taggedRoot = applied.transactions[0].setMeta(DOCUMENT_FLUSH_META_KEY, pmFlush.id);
  assert.equal(taggedRoot.getMeta(DOCUMENT_FLUSH_META_KEY), pmFlush.id);
  pmTracker.recordDocumentChange({ kind: "pending-flush", flushId: pmFlush.id });
  const appendedIsCausal =
    taggedRoot.getMeta(DOCUMENT_FLUSH_META_KEY) === pmFlush.id
    && pmAppended.getMeta(DOCUMENT_APPENDED_TRANSACTION_META_KEY) === applied.transactions[0];
  assert.equal(appendedIsCausal, true);
  pmTracker.recordDocumentChange(
    appendedIsCausal
      ? { kind: "pending-flush", flushId: pmFlush.id }
      : { kind: "document" },
  );
  pmTracker.setRevision(1);
  assert.equal(pmFlush.complete().authorizedMutationCount, 2);
  assert.equal(rootIsTagged, false, "the fixture root starts unbound and is tagged only by the production flush");

  const falseLinked = pmTracker.beginFlush(pmTracker.token());
  pmTracker.recordDocumentChange({ kind: "pending-flush", flushId: falseLinked.id });
  // A same-batch-looking transaction whose appendedTransaction points at a
  // different root is not authorized by the PM causal relation.
  const unrelatedRoot = pmState.tr.insertText("?", 1);
  const falseLinkedAppended = pmState.tr
    .insertText("?", 1)
    .setMeta(DOCUMENT_APPENDED_TRANSACTION_META_KEY, unrelatedRoot);
  const falseCausal =
    falseLinkedAppended.getMeta(DOCUMENT_APPENDED_TRANSACTION_META_KEY) === applied.transactions[0];
  assert.equal(falseCausal, false);
  pmTracker.recordDocumentChange({ kind: "document" });
  assert.throws(() => falseLinked.complete(), /未授权变化|来源无法证明/);
  assert.equal(pmTracker.activeFlushId, null);

  console.log("document mutation tracker checks passed (bounded flush receipts and invalidation races)");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
