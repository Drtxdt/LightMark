import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmark-large-queue-"));
const sourcePath = path.join(root, "src", "editor", "largeOperationQueue.ts");
const outputPath = path.join(tempDir, "largeOperationQueue.mjs");
try {
  fs.writeFileSync(outputPath, ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText);
  const {
    LargeCompositionDeferredError,
    LargeOperationQueue,
    LargeSessionStaleError,
  } = await import(pathToFileURL(outputPath).href);

  const tab = {};
  const session = {};
  const identity = {
    tab,
    tabId: "tab-a",
    paneId: "main",
    sessionId: "session-a",
    sessionIdentity: session,
    editorIdentity: null,
    revision: 4,
    coordinateSpace: "utf16-code-units",
  };
  let current = identity;
  const queue = new LargeOperationQueue();
  let firstRuns = 0;
  let secondRuns = 0;
  const first = queue.enqueue("first", identity, () => current, async () => {
    firstRuns += 1;
    throw new Error("expected failure");
  });
  const second = queue.enqueue("second", identity, () => current, async () => {
    secondRuns += 1;
    return "recovered";
  });
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "recovered", "a failed task must not poison the queue tail");
  assert.equal(firstRuns, 1);
  assert.equal(secondRuns, 1);
  assert.equal(queue.lastFailure.operation, "first");

  const staleQueue = new LargeOperationQueue();
  let staleTaskRuns = 0;
  const stale = staleQueue.enqueue("stale", identity, () => current, async () => {
    staleTaskRuns += 1;
  });
  current = { ...identity, sessionId: "new-session", sessionIdentity: {} };
  await assert.rejects(stale, LargeSessionStaleError);
  assert.equal(staleTaskRuns, 0, "stale operations must be rejected before task execution");

  const deferred = new LargeCompositionDeferredError();
  assert.equal(deferred.code, "large-composition-deferred");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("large operation queue checks passed");
