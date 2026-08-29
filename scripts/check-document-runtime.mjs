import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-runtime-"));
const transpile = (sourcePath, destination, rewrites = []) => {
  let output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  for (const [from, to] of rewrites) output = output.replaceAll(from, to);
  fs.writeFileSync(destination, output);
};

try {
  transpile(path.join(root, "src", "editor", "documentRuntime.ts"), path.join(tempDir, "documentRuntime.mjs"));
  transpile(
    path.join(root, "src", "editor", "documentSnapshotCoordinator.ts"),
    path.join(tempDir, "documentSnapshotCoordinator.mjs"),
    [["./documentRuntime", "./documentRuntime.mjs"]],
  );
  transpile(
    path.join(root, "src", "editor", "wysiwygSnapshot.ts"),
    path.join(tempDir, "wysiwygSnapshot.mjs"),
    [["./documentRuntime", "./documentRuntime.mjs"]],
  );
  const runtime = await import(pathToFileURL(path.join(tempDir, "documentRuntime.mjs")).href);
  const { DocumentSnapshotCoordinator } = await import(pathToFileURL(path.join(tempDir, "documentSnapshotCoordinator.mjs")).href);
  const { WysiwygSnapshotCache } = await import(pathToFileURL(path.join(tempDir, "wysiwygSnapshot.mjs")).href);

  let projected = null;
  const unsubscribe = runtime.subscribeDocumentRuntime((tabId, state) => {
    if (tabId === "derived-tab") projected = state;
  });
  runtime.publishDocumentDerivedState("derived-tab", { revision: 1, outline: [{ key: "root" }], words: 10 });
  runtime.publishDocumentDerivedPatch("derived-tab", { revision: 2, words: 11 });
  assert.equal(projected.revision, 2);
  assert.equal(projected.words, 11);
  assert.deepEqual(projected.outline, [{ key: "root" }], "a stats patch must preserve the existing outline projection");
  unsubscribe();

  const coordinator = new DocumentSnapshotCoordinator();
  let coordinatedRuns = 0;
  coordinator.schedule("cancelled", async () => { coordinatedRuns += 1; }, () => {}, 5);
  coordinator.cancel("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(coordinatedRuns, 0, "cancelled idle snapshots must never start");
  coordinator.schedule("active", async () => { coordinatedRuns += 1; }, () => {}, 0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(coordinatedRuns, 1, "eligible idle snapshot must run once");

  let revision = 1;
  let dirty = true;
  let blocks = [{ html: "<p>one</p>" }];
  let conversions = 0;
  let blockSerializations = 0;
  let slowSerialization = false;
  const combine = (parts, previous) => `${parts.filter(Boolean).join("\n\n")}${previous.endsWith("\n") ? "\n" : ""}`;
  const cache = new WysiwygSnapshotCache({
    tabId: () => "tab-a",
    revision: () => revision,
    dirty: () => dirty,
    previousMarkdown: () => "one\n",
    blocks: () => blocks,
    serializeBlock: (block) => {
      blockSerializations += 1;
      if (slowSerialization) {
        const until = performance.now() + 9;
        while (performance.now() < until) { /* force an idle yield boundary */ }
      }
      return block.html;
    },
    convertBlock: (value) => { conversions += 1; return value === "<p>one</p>" ? "one" : "two"; },
    combineBlocks: combine,
    oracle: () => `${blocks.map((block) => block.html === "<p>one</p>" ? "one" : "two").join("\n\n")}\n`,
  });
  assert.equal((await cache.snapshot("save")).markdown, "one\n");
  dirty = false;
  assert.equal((await cache.snapshot("export")).dirty, false, "cached snapshots must project current dirty state");
  assert.equal(conversions, 1);
  assert.equal(blockSerializations, 1);
  assert.deepEqual(cache.diagnostics(), {
    compatibility: "compatible",
    oracleChecks: 1,
    serializedBlocks: 1,
    reusedBlocks: 0,
    idleYields: 0,
    maxSliceMs: cache.diagnostics().maxSliceMs,
    mismatch: undefined,
  });

  revision += 1;
  blocks = [{ html: "<p>two</p>" }];
  slowSerialization = true;
  cache.invalidate();
  const controller = new AbortController();
  const idle = cache.snapshot("indexIdle", { signal: controller.signal });
  controller.abort();
  const save = await cache.snapshot("save");
  await assert.rejects(idle, { name: "AbortError" });
  assert.equal(save.markdown, "two\n", "a cancelled idle snapshot must not poison a save snapshot");
  assert.equal(cache.diagnostics().serializedBlocks, 2, "only the immutable replacement block should be serialized");

  const mismatchBlock = { html: "<p>candidate</p>" };
  const mismatchCache = new WysiwygSnapshotCache({
    tabId: () => "tab-mismatch",
    revision: () => 1,
    dirty: () => true,
    previousMarkdown: () => "oracle\n",
    blocks: () => [mismatchBlock],
    serializeBlock: (block) => block.html,
    convertBlock: () => "candidate",
    combineBlocks: combine,
    oracle: () => "oracle\n",
    verifyIncremental: () => true,
  });
  assert.equal((await mismatchCache.snapshot("save")).markdown, "oracle\n", "an oracle mismatch must fall back without writing the candidate");
  assert.equal(mismatchCache.diagnostics().compatibility, "fallback");
  assert.equal(mismatchCache.diagnostics().mismatch?.at, 0);

  let adapterRevision = 4;
  const adapter = {
    tabId: "old-tab", paneId: "main", mode: "source",
    get revision() { return adapterRevision; },
    async snapshot() { return { tabId: "old-tab", revision: adapterRevision, markdown: "latest", dirty: true }; },
    derivedState() { return { revision: adapterRevision }; },
    async replaceMarkdown() {}, navigate() {},
  };
  const unregister = runtime.registerDocumentSession(adapter);
  runtime.rebindDocumentSession("old-tab", "new-tab");
  assert.equal((await runtime.snapshotDocumentTab("new-tab", "save")).tabId, "new-tab");
  unregister();
  assert.equal(runtime.documentSessionForTab("new-tab"), null, "unregister must remove a rebound tab id");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("document runtime and cancellable snapshot checks passed");
