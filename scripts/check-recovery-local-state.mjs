import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-recovery-local-state-"));

try {
  const modulePath = compileTypeScriptModuleGraph(path.resolve("src/editor/recoveryLocalState.ts"), tempDir);
  const registryApi = await import(pathToFileURL(modulePath).href);
  const {
    captureRecoveryLocalBufferRegistry,
    captureRecoveryLocalBuffers,
    createRecoveryLocalBufferRegistry,
    registerRecoveryLocalBuffer,
    replaceRecoveryLocalBuffer,
    unregisterRecoveryLocalBuffer,
    registerRecoveryLocalBufferForOwner,
    captureRecoveryLocalBuffersForOwner,
    restoreRecoveryLocalBuffersForOwner,
    retainAndUnregisterRecoveryLocalBufferForOwner,
    hasRecoveryLocalBufferIssuesForOwner,
    RecoveryLocalRegistryError,
  } = registryApi;

  let successfulReads = 0;
  let failedReads = 0;
  let thrownReads = 0;
  const acceptedPayload = { accepted: { yaml: "title: old", editing: false }, draft: { yaml: "title: draft", editing: true } };
  const acceptedBuffer = () => ({
    ok: true,
    buffer: {
      id: "fm-1",
      kind: "frontmatter",
      status: "editing",
      sourceRevision: 4,
      pmPath: [0, 1],
      positionHint: 12,
      rawSpan: { from: 0, to: 8 },
      payload: acceptedPayload,
      ui: { anchor: 5, head: 5, direction: "none", focused: true, composing: false },
    },
  });
  let registry = createRecoveryLocalBufferRegistry();
  registry = registerRecoveryLocalBuffer(registry, {
    id: "fm-1",
    kind: "frontmatter",
    sourceRevision: 4,
    positionHint: 12,
    capture: () => {
      successfulReads += 1;
      return acceptedBuffer();
    },
  });
  registry = registerRecoveryLocalBuffer(registry, {
    id: "html-1",
    kind: "htmlBlock",
    sourceRevision: 4,
    capture: () => {
      failedReads += 1;
      return {
        ok: false,
        code: "node-view-destroyed",
        message: "HTML NodeView was destroyed before capture.",
        status: "orphaned",
        payload: { accepted: { html: "<script>keep</script>", editing: false }, draft: { html: "<b>draft</b>" } },
      };
    },
  });
  registry = registerRecoveryLocalBuffer(registry, {
    id: "toc-1",
    kind: "toc",
    sourceRevision: 4,
    capture: () => {
      thrownReads += 1;
      throw new Error("getPos unavailable");
    },
  });

  const beforeCapture = registry;
  const first = captureRecoveryLocalBuffers(registry);
  assert.equal(first.registryVersion, registry.version, "capture reports stable registry version");
  assert.equal(first.complete, false, "a failed callback marks the total capture incomplete");
  assert.equal(first.status, "incomplete", "capture exposes an explicit incomplete status");
  assert.deepEqual(first.failures.map((failure) => [failure.id, failure.code]), [
    ["html-1", "node-view-destroyed"],
    ["toc-1", "capture-threw"],
  ], "capture exposes typed failures alongside retained buffers");
  assert.equal(registry, beforeCapture, "capture does not replace or mutate registry");
  assert.deepEqual([...first.buffers].map((buffer) => buffer.id), ["fm-1", "html-1", "toc-1"], "capture order follows registration order");
  assert.equal(successfulReads, 1);
  assert.equal(failedReads, 1);
  assert.equal(thrownReads, 1);
  assert.deepEqual(first.buffers[0].payload, acceptedPayload, "successful payload is copied");
  assert.notEqual(first.buffers[0].payload, acceptedPayload, "successful payload is not aliased");
  assert.equal(first.buffers[1].status, "orphaned", "typed capture failure is retained");
  assert.equal(first.buffers[1].error.code, "node-view-destroyed");
  assert.equal(first.buffers[1].payload.accepted.html, "<script>keep</script>", "orphan payload preserves raw HTML as data");
  assert.equal(first.buffers[2].status, "orphaned", "thrown callback becomes orphan");
  assert.equal(first.buffers[2].error.code, "capture-threw");
  assert.equal(first.buffers[2].payload, null);
  assert.equal(Object.isFrozen(first), true, "capture snapshot is immutable");
  assert.equal(Object.isFrozen(first.buffers[0]), true, "captured buffer is immutable");
  acceptedPayload.draft.yaml = "mutated after capture";
  assert.equal(first.buffers[0].payload.draft.yaml, "title: draft", "later callback owner mutation cannot alter capture");

  const second = captureRecoveryLocalBufferRegistry(registry);
  assert.equal(second.registryVersion, first.registryVersion, "alias keeps capture semantics");
  assert.equal(successfulReads, 2);
  assert.equal(failedReads, 2);
  assert.equal(thrownReads, 2);

  const replacement = {
    id: "fm-1",
    kind: "frontmatter",
    sourceRevision: 5,
    positionHint: null,
    capture: () => ({
      ok: true,
      buffer: {
        id: "fm-1",
        kind: "frontmatter",
        status: "accepted",
        sourceRevision: 5,
        positionHint: null,
        payload: {
          accepted: { yaml: "title: next", editing: false },
          draft: "title: next",
        },
      },
    }),
  };
  const replaced = replaceRecoveryLocalBuffer(registry, replacement);
  assert.equal(replaced.version, registry.version + 1, "replace advances version");
  assert.equal(captureRecoveryLocalBuffers(replaced).buffers[0].payload.draft, "title: next");
  const unregisteredUnknown = unregisterRecoveryLocalBuffer(replaced, "missing");
  assert.equal(unregisteredUnknown, replaced, "removing an unknown id is a no-op");
  const unregistered = unregisterRecoveryLocalBuffer(replaced, "html-1");
  assert.equal(unregistered.version, replaced.version + 1, "unregister advances version");
  assert.deepEqual([...unregistered.entries].map((entry) => entry.id), ["fm-1", "toc-1"]);
  const completeRegistry = unregisterRecoveryLocalBuffer(unregistered, "toc-1");
  const completeCapture = captureRecoveryLocalBuffers(completeRegistry);
  assert.equal(completeCapture.complete, true, "a fully captured registry is explicitly complete");
  assert.equal(completeCapture.status, "complete");
  assert.deepEqual(completeCapture.failures, []);
  const knownOrphanRegistry = registerRecoveryLocalBuffer(createRecoveryLocalBufferRegistry(), {
    id: "html-known-orphan",
    kind: "htmlBlock",
    sourceRevision: 4,
    capture: () => ({
      ok: true,
      buffer: {
        id: "html-known-orphan",
        kind: "htmlBlock",
        status: "orphaned",
        sourceRevision: 4,
        payload: { accepted: { html: "<b>kept</b>", editing: false }, draft: "<b>kept</b>" },
        error: { code: "stale-position", message: "NodeView position is stale." },
      },
    }),
  });
  const knownOrphanCapture = captureRecoveryLocalBuffers(knownOrphanRegistry);
  assert.equal(knownOrphanCapture.status, "complete", "a fully retained orphan payload is complete but unresolved");
  assert.equal(knownOrphanCapture.buffers[0].status, "orphaned");
  assert.equal(knownOrphanCapture.buffers[0].payload.accepted.html, "<b>kept</b>");

  const retainedOwner = {};
  const retainedBuffer = {
    id: "retained-html",
    kind: "htmlBlock",
    status: "orphaned",
    sourceRevision: 6,
    positionHint: 88,
    rawSpan: { from: 12, to: 24 },
    payload: { accepted: { html: "<b>keep this</b>", editing: false }, draft: { html: "<i>local</i>" } },
    ui: { anchor: 3, head: 3, direction: "none", focused: false, composing: false },
    error: { code: "stale-position", message: "NodeView position is no longer bound." },
  };
  const retainedRestore = restoreRecoveryLocalBuffersForOwner(retainedOwner, [retainedBuffer]);
  assert.equal(retainedRestore.issues.length, 1, "orphan restore produces a visible issue");
  assert.deepEqual(retainedRestore.issues[0].buffer, retainedBuffer, "restore issue retains the complete original buffer");
  const retainedCapture = captureRecoveryLocalBuffersForOwner(retainedOwner);
  assert.equal(retainedCapture.complete, true, "a complete orphan payload remains exportable");
  assert.deepEqual(retainedCapture.buffers[0], retainedBuffer, "subsequent capture preserves the complete orphan buffer");
  assert.equal(hasRecoveryLocalBufferIssuesForOwner(retainedOwner), true, "retained orphan data remains visible to pending checks");

  const destroyedOwner = {};
  const destroyedCleanup = registerRecoveryLocalBufferForOwner(destroyedOwner, {
    id: "destroyed-local",
    kind: "htmlBlock",
    sourceRevision: 2,
    positionHint: 9,
    capture: () => ({
      ok: true,
      buffer: {
        id: "destroyed-local",
        kind: "htmlBlock",
        status: "editing",
        sourceRevision: 2,
        positionHint: 9,
        payload: { accepted: { html: "old", editing: false }, draft: { html: "still local", editing: true } },
      },
    }),
  });
  const retainedOnDestroy = retainAndUnregisterRecoveryLocalBufferForOwner(destroyedOwner, "destroyed-local");
  assert.equal(retainedOnDestroy.status, "editing", "destroyed NodeView retains its last local value before unregistering");
  destroyedCleanup();
  assert.equal(captureRecoveryLocalBuffersForOwner(destroyedOwner).buffers[0].payload.draft.html, "still local", "stale callbacks cannot erase the retained local value");
  assert.equal(hasRecoveryLocalBufferIssuesForOwner(destroyedOwner), true, "an unmounted editing buffer remains visible to pending checks");

  const failedOwner = {};
  const failedCleanup = registerRecoveryLocalBufferForOwner(failedOwner, {
    id: "failed-local",
    kind: "htmlBlock",
    sourceRevision: 2,
    capture: () => { throw new Error("DOM detached"); },
  });
  retainAndUnregisterRecoveryLocalBufferForOwner(failedOwner, "failed-local");
  failedCleanup();
  const failedCapture = captureRecoveryLocalBuffersForOwner(failedOwner);
  assert.equal(failedCapture.complete, false, "a callback data gap remains an incomplete capture");
  assert.equal(failedCapture.failures[0].code, "capture-threw", "callback data gap remains typed");

  const lastLocalOwner = {};
  let lastLocalMode = "payload";
  const lastLocalCleanup = registerRecoveryLocalBufferForOwner(lastLocalOwner, {
    id: "last-local",
    kind: "htmlBlock",
    sourceRevision: 3,
    capture: () => {
      if (lastLocalMode === "payload") {
        return {
          ok: false,
          code: "dom-value-unavailable",
          message: "HTML control temporarily detached.",
          status: "orphaned",
          payload: { accepted: { html: "old", editing: false }, draft: { html: "stable local" } },
        };
      }
      if (lastLocalMode === "null") throw new Error("DOM detached before a local value was readable");
      return {
        ok: true,
        buffer: {
          id: "last-local",
          kind: "htmlBlock",
          status: "accepted",
          sourceRevision: 3,
          payload: { accepted: { html: "new", editing: false }, draft: { html: "new" } },
        },
      };
    },
  });
  const firstLastLocal = captureRecoveryLocalBuffersForOwner(lastLocalOwner);
  assert.equal(firstLastLocal.complete, false, "a typed failure with a payload remains incomplete");
  assert.equal(firstLastLocal.buffers[0].payload.draft.html, "stable local", "the first failed capture exposes its local payload");
  lastLocalMode = "null";
  const secondLastLocal = captureRecoveryLocalBuffersForOwner(lastLocalOwner);
  assert.equal(secondLastLocal.complete, false, "a later null callback remains a data gap");
  assert.equal(secondLastLocal.buffers[0].payload.draft.html, "stable local", "a null callback cannot erase the last local payload");
  lastLocalMode = "success";
  const thirdLastLocal = captureRecoveryLocalBuffersForOwner(lastLocalOwner);
  assert.equal(thirdLastLocal.complete, true, "a later complete callback clears the retained failure");
  assert.equal(thirdLastLocal.buffers[0].payload.draft.html, "new", "the current complete value replaces the retained one");
  lastLocalCleanup();

  const assertRegistryError = (fn, code, label) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof RecoveryLocalRegistryError, `${label}: typed registry error`);
      assert.equal(error.code, code, `${label}: code`);
      return;
    }
    assert.fail(`${label}: expected ${code}`);
  };

  const overflowOwner = {};
  const overflowCleanups = [];
  for (let index = 0; index < 513; index += 1) {
    const id = `runtime-${index}`;
    overflowCleanups.push(registerRecoveryLocalBufferForOwner(overflowOwner, {
      id,
      kind: "frontmatter",
      sourceRevision: 1,
      positionHint: index,
      capture: () => ({
        ok: true,
        buffer: {
          id,
          kind: "frontmatter",
          status: "accepted",
          sourceRevision: 1,
          positionHint: index,
          payload: { accepted: { yaml: `title: ${index}`, editing: false }, draft: { yaml: `title: ${index}`, editing: false } },
        },
      }),
    }));
  }
  const overflowCapture = captureRecoveryLocalBuffersForOwner(overflowOwner);
  assert.equal(overflowCapture.buffers.length, 513, "runtime overflow still captures every mounted value");
  assert.equal(overflowCapture.complete, false, "runtime overflow is an explicit export completeness failure");
  assert.equal(overflowCapture.failures.some((failure) => failure.code === "registry-limit"), true, "runtime overflow exposes a typed capacity failure");
  assertRegistryError(() => registerRecoveryLocalBufferForOwner(overflowOwner, {
    id: "runtime-0",
    kind: "frontmatter",
    sourceRevision: 1,
    capture: () => ({
      ok: true,
      buffer: {
        id: "runtime-0",
        kind: "frontmatter",
        status: "accepted",
        sourceRevision: 1,
        payload: { accepted: { yaml: "duplicate", editing: false }, draft: { yaml: "duplicate", editing: false } },
      },
    }),
  }), "duplicate-id", "duplicate id across normal and overflow runtime slots");
  overflowCleanups.forEach((cleanup) => cleanup());
  assert.equal(captureRecoveryLocalBuffersForOwner(overflowOwner).buffers.length, 0, "unmount releases overflow registrations");

  assertRegistryError(() => registerRecoveryLocalBuffer(registry, {
    id: "fm-1", kind: "frontmatter", sourceRevision: 4, capture: acceptedBuffer,
  }), "duplicate-id", "duplicate id");
  assertRegistryError(() => replaceRecoveryLocalBuffer(registry, {
    id: "missing", kind: "frontmatter", sourceRevision: 4, capture: acceptedBuffer,
  }), "unknown-id", "replace missing id");
  assertRegistryError(() => registerRecoveryLocalBuffer(registry, {
    id: "bad\u0000id", kind: "frontmatter", sourceRevision: 4, capture: acceptedBuffer,
  }), "invalid-registration", "NUL id");

  console.log("check-recovery-local-state: passed (immutable registry capture and orphan retention)");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
