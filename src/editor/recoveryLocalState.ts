/**
 * Pure local-buffer capture primitives used by the recovery codec.
 *
 * A registration only contains a read-only callback.  The callback is owned by
 * the eventual NodeView/CM adapter, but this module never receives an editor,
 * DOM node, dispatcher, or timer.  That keeps capture from accidentally
 * becoming a flush/transaction boundary.
 */

export const RECOVERY_LOCAL_STATE_SCHEMA = "lightmark.local-state" as const;
export const RECOVERY_LOCAL_BUFFER_KINDS = [
  "frontmatter",
  "htmlBlock",
  "footnote",
  "toc",
  "mermaid",
  "math",
] as const;

export type RecoveryLocalBufferKind = (typeof RECOVERY_LOCAL_BUFFER_KINDS)[number];
export type RecoveryLocalBufferStatus = "accepted" | "editing" | "conflicted" | "orphaned";

export type RecoveryLocalTextUi = {
  readonly anchor: number;
  readonly head: number;
  readonly direction: "forward" | "backward" | "none";
  readonly focused: boolean;
  readonly composing: boolean;
};

export type RecoveryLocalBufferV3 = {
  readonly id: string;
  readonly kind: RecoveryLocalBufferKind;
  readonly status: RecoveryLocalBufferStatus;
  readonly sourceRevision: number;
  readonly pmPath?: readonly number[];
  readonly positionHint?: number | null;
  readonly rawSpan?: { readonly from: number; readonly to: number };
  readonly payload: unknown;
  readonly ui?: RecoveryLocalTextUi;
  readonly error?: { readonly code: string; readonly message: string };
};

export type RecoveryExposedMarkdownRange = {
  readonly kind: "heading" | "inline";
  readonly from: number;
  readonly to: number;
  readonly blockFrom: number;
  readonly open: string;
  readonly close: string;
  readonly markName?: string;
  readonly headingLevel?: number;
  readonly headingInvalid?: boolean;
};

export type RecoveryExposedMarkdownV3 = {
  readonly active: boolean;
  readonly range: RecoveryExposedMarkdownRange;
  readonly docRevision: number;
  readonly selection: { readonly anchor: number; readonly head: number };
};

export type WysiwygFormatHistoryEntry = {
  readonly before: string;
  readonly after: string;
  readonly beforeAnchor: number;
  readonly beforeHead: number;
  readonly afterAnchor: number;
  readonly afterHead: number;
};

export type RecoveryHistoryV3 = {
  readonly sourceCheckpointId: string;
  readonly format: {
    readonly undo: readonly WysiwygFormatHistoryEntry[];
    readonly redo: readonly WysiwygFormatHistoryEntry[];
  };
  readonly pm: RecoveryHistoryAvailability;
  readonly source: RecoveryHistoryAvailability;
};

export type RecoveryHistoryAvailability = {
  /**
   * PM/CM history has no versioned adapter in this slice.  Keeping this type
   * explicit prevents a checkpoint id by itself from being presented as a
   * restorable history branch.
   */
  readonly status: "unavailable";
  readonly reason: string;
  readonly checkpointId?: string;
};

export type RecoveryCompositionV3 = {
  readonly active: boolean;
  readonly source: "pm" | "node-view";
  readonly revision: number;
};

export type RecoveryLocalStateV3 = {
  readonly schema: typeof RECOVERY_LOCAL_STATE_SCHEMA;
  readonly revision: number;
  readonly buffers: readonly RecoveryLocalBufferV3[];
  readonly exposedMarkdown: RecoveryExposedMarkdownV3 | null;
  readonly composition: RecoveryCompositionV3 | null;
  readonly history: RecoveryHistoryV3;
};

export type RecoveryLocalBufferCaptureResult =
  | { readonly ok: true; readonly buffer: RecoveryLocalBufferV3 }
  | {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
    readonly payload?: unknown;
    readonly status?: "conflicted" | "orphaned";
    readonly sourceRevision?: number;
    readonly pmPath?: readonly number[];
    readonly positionHint?: number | null;
    readonly rawSpan?: { readonly from: number; readonly to: number };
    readonly ui?: RecoveryLocalTextUi;
  };

export type RecoveryLocalBufferCapture = () => RecoveryLocalBufferCaptureResult;
export type RecoveryLocalBufferRestore = (buffer: RecoveryLocalBufferV3) => void;

export type RecoveryLocalBufferRegistration = {
  readonly id: string;
  readonly kind: RecoveryLocalBufferKind;
  readonly sourceRevision: number;
  readonly positionHint?: number | null;
  readonly capture: RecoveryLocalBufferCapture;
  readonly restore?: RecoveryLocalBufferRestore;
};

export type RecoveryLocalBufferRegistry = {
  readonly version: number;
  readonly entries: readonly RecoveryLocalBufferRegistration[];
};

export type RecoveryLocalBufferCaptureSnapshot = {
  readonly registryVersion: number;
  readonly complete: boolean;
  readonly status: "complete" | "incomplete";
  readonly failures: readonly RecoveryLocalBufferCaptureFailure[];
  readonly buffers: readonly RecoveryLocalBufferV3[];
};

export type RecoveryLocalBufferCaptureFailure = {
  readonly id: string;
  readonly kind: RecoveryLocalBufferKind;
  readonly code: string;
  readonly message: string;
};

export type RecoveryLocalBufferRestoreIssue = {
  readonly id: string;
  readonly kind: RecoveryLocalBufferKind;
  readonly status: RecoveryLocalBufferStatus;
  readonly code: string;
  readonly message: string;
  readonly payload: unknown;
  /** Complete unresolved buffer, including binding hints and typed error. */
  readonly buffer: RecoveryLocalBufferV3;
};

export type RecoveryLocalBufferRestoreSnapshot = {
  readonly applied: number;
  readonly issues: readonly RecoveryLocalBufferRestoreIssue[];
};

const MAX_REGISTRATIONS = 512;
const MAX_ID_LENGTH = 256;
const MAX_ERROR_CODE_LENGTH = 256;
const MAX_ERROR_MESSAGE_LENGTH = 4096;
const MAX_PATH_LENGTH = 4096;
const MAX_JSON_DEPTH = 128;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const kinds = new Set<string>(RECOVERY_LOCAL_BUFFER_KINDS);

export type RecoveryLocalRegistryErrorCode =
  | "invalid-registration"
  | "duplicate-id"
  | "unknown-id"
  | "registry-limit";

export class RecoveryLocalRegistryError extends Error {
  readonly code: RecoveryLocalRegistryErrorCode;

  constructor(code: RecoveryLocalRegistryErrorCode, message: string) {
    super(message);
    this.name = "RecoveryLocalRegistryError";
    this.code = code;
  }
}

export function createRecoveryLocalBufferRegistry(version = 0): RecoveryLocalBufferRegistry {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RecoveryLocalRegistryError("invalid-registration", "Registry version must be a non-negative safe integer.");
  }
  return freezeRegistry({ version, entries: [] });
}

export function registerRecoveryLocalBuffer(
  registry: RecoveryLocalBufferRegistry,
  registration: RecoveryLocalBufferRegistration,
): RecoveryLocalBufferRegistry {
  assertRegistry(registry);
  assertRegistration(registration);
  if (registry.entries.some((entry) => entry.id === registration.id)) {
    throw new RecoveryLocalRegistryError("duplicate-id", `A local buffer with id ${registration.id} is already registered.`);
  }
  if (registry.entries.length >= MAX_REGISTRATIONS) {
    throw new RecoveryLocalRegistryError("registry-limit", "The local buffer registry reached its supported entry limit.");
  }
  return freezeRegistry({
    version: registry.version + 1,
    entries: [...registry.entries, freezeRegistration(registration)],
  });
}

export function replaceRecoveryLocalBuffer(
  registry: RecoveryLocalBufferRegistry,
  registration: RecoveryLocalBufferRegistration,
): RecoveryLocalBufferRegistry {
  assertRegistry(registry);
  assertRegistration(registration);
  const index = registry.entries.findIndex((entry) => entry.id === registration.id);
  if (index < 0) {
    throw new RecoveryLocalRegistryError("unknown-id", `No local buffer with id ${registration.id} is registered.`);
  }
  const entries = [...registry.entries];
  entries[index] = freezeRegistration(registration);
  return freezeRegistry({ version: registry.version + 1, entries });
}

export function unregisterRecoveryLocalBuffer(
  registry: RecoveryLocalBufferRegistry,
  id: string,
): RecoveryLocalBufferRegistry {
  assertRegistry(registry);
  assertId(id);
  const entries = registry.entries.filter((entry) => entry.id !== id);
  if (entries.length === registry.entries.length) return registry;
  return freezeRegistry({ version: registry.version + 1, entries });
}

/**
 * Invoke every registered callback once, in registration order.  A failed or
 * malformed callback becomes an orphan buffer and does not prevent later
 * callbacks from being captured.  Neither the registry object nor its version
 * changes during capture.
 */
export function captureRecoveryLocalBuffers(
  registry: RecoveryLocalBufferRegistry,
): RecoveryLocalBufferCaptureSnapshot {
  assertRegistry(registry);
  const outcomes = registry.entries.map((registration) => captureOne(registration));
  const buffers = outcomes.map((outcome) => outcome.buffer);
  const failures = outcomes
    .flatMap((outcome) => outcome.failure ? [Object.freeze(outcome.failure)] : []);
  return Object.freeze({
    registryVersion: registry.version,
    complete: failures.length === 0,
    status: failures.length === 0 ? "complete" as const : "incomplete" as const,
    failures: Object.freeze(failures),
    buffers: Object.freeze(buffers),
  });
}

/** Alias with the longer name used by recovery-boundary callers. */
export const captureRecoveryLocalBufferRegistry = captureRecoveryLocalBuffers;

type RecoveryLocalBufferRuntime = {
  registry: RecoveryLocalBufferRegistry;
  /** Runtime registrations beyond the untrusted/imported registry quota. */
  overflow: Map<string, RecoveryLocalBufferRegistration>;
  restores: Map<string, RecoveryLocalBufferRestore>;
  retained: Map<string, RecoveryLocalBufferV3>;
  retainedFailures: Map<string, RecoveryLocalBufferCaptureFailure>;
  lastRestore: RecoveryLocalBufferRestoreSnapshot;
};

const recoveryLocalRuntimes = new WeakMap<object, RecoveryLocalBufferRuntime>();

function createOwnerRuntime(): RecoveryLocalBufferRuntime {
  return {
    registry: createRecoveryLocalBufferRegistry(),
    overflow: new Map(),
    restores: new Map(),
    retained: new Map(),
    retainedFailures: new Map(),
    lastRestore: Object.freeze({ applied: 0, issues: Object.freeze([]) }),
  };
}

function ownerRuntime(owner: object) {
  let runtime = recoveryLocalRuntimes.get(owner);
  if (!runtime) {
    runtime = createOwnerRuntime();
    recoveryLocalRuntimes.set(owner, runtime);
  }
  return runtime;
}

/**
 * Attach a NodeView-local registration to an editor owner without exposing a
 * mutable registry to the caller.  The owner is intentionally opaque: this
 * helper does not inspect or mutate an editor, DOM node, or transaction.
 */
export function registerRecoveryLocalBufferForOwner(
  owner: object,
  registration: RecoveryLocalBufferRegistration,
) {
  assertOwner(owner);
  const runtime = ownerRuntime(owner);
  if (runtime.registry.entries.length >= MAX_REGISTRATIONS) {
    assertRegistration(registration);
    if (runtime.registry.entries.some((entry) => entry.id === registration.id) || runtime.overflow.has(registration.id)) {
      throw new RecoveryLocalRegistryError("duplicate-id", `A local buffer with id ${registration.id} is already registered.`);
    }
    runtime.overflow.set(registration.id, freezeRegistration(registration));
  } else {
    runtime.registry = registerRecoveryLocalBuffer(runtime.registry, registration);
  }
  if (registration.restore) runtime.restores.set(registration.id, registration.restore);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (runtime!.overflow.delete(registration.id)) {
      // Keep overflow registrations out of the imported registry quota.  A
      // later registration can use the freed slot without a constructor
      // throwing in the middle of a PM update.
    } else {
      const hadEntry = runtime!.registry.entries.some((entry) => entry.id === registration.id);
      runtime!.registry = unregisterRecoveryLocalBuffer(runtime!.registry, registration.id);
      if (hadEntry && runtime!.overflow.size > 0) {
        const [promotedId, promoted] = runtime!.overflow.entries().next().value as [string, RecoveryLocalBufferRegistration];
        runtime!.overflow.delete(promotedId);
        runtime!.registry = registerRecoveryLocalBuffer(runtime!.registry, promoted);
      }
    }
    runtime!.restores.delete(registration.id);
  };
}

export function captureRecoveryLocalBuffersForOwner(
  owner: object,
): RecoveryLocalBufferCaptureSnapshot {
  assertOwner(owner);
  const runtime = recoveryLocalRuntimes.get(owner);
  if (!runtime) {
    return Object.freeze({
      registryVersion: 0,
      complete: true,
      status: "complete" as const,
      failures: Object.freeze([]),
      buffers: Object.freeze([]),
    });
  }
  const captured = captureRecoveryLocalBuffers(runtime.registry);
  rememberOwnerCapture(runtime, captured);
  const overflowEntries = [...runtime.overflow.values()];
  if (overflowEntries.length) {
    const overflowOutcomes = overflowEntries.map((registration) => captureOne(registration));
    const overflowBuffers = overflowOutcomes.map((outcome) => outcome.buffer);
    const overflowFailures = overflowOutcomes.flatMap((outcome) => outcome.failure ? [outcome.failure] : []);
    const capacityFailures = overflowEntries.map((registration) => ({
      id: registration.id,
      kind: registration.kind,
      code: "registry-limit",
      message: "Runtime local buffer registration exceeds the export capacity; the editor session remains intact.",
    }));
    const overflowCapture = Object.freeze({
      registryVersion: runtime.registry.version,
      complete: false,
      status: "incomplete" as const,
      failures: Object.freeze([...captured.failures, ...overflowFailures, ...capacityFailures]),
      buffers: Object.freeze([...captured.buffers, ...overflowBuffers]),
    });
    rememberOwnerCapture(runtime, Object.freeze({
      ...overflowCapture,
      failures: Object.freeze([...overflowFailures, ...capacityFailures]),
      buffers: Object.freeze(overflowBuffers),
    }));
    return mergeOwnerRetainedBuffers(runtime, overflowCapture);
  }
  return mergeOwnerRetainedBuffers(runtime, captured);
}

/**
 * Keep a last known local value when a live callback reports a typed failure.
 * Explicit recovery capture is allowed to fail, but a transient DOM/position
 * failure must not erase the last complete payload from a later attempt.  A
 * null payload is a data gap: retain an earlier complete value when one
 * exists, otherwise keep the failed null buffer and its typed failure.
 */
function rememberOwnerCapture(
  runtime: RecoveryLocalBufferRuntime,
  captured: RecoveryLocalBufferCaptureSnapshot,
) {
  const failures = new Map<string, RecoveryLocalBufferCaptureFailure>();
  captured.failures.forEach((failure) => {
    // Registry capacity is a capture limitation, not a local value failure.
    // Do not retain accepted overflow values after their NodeViews unmount.
    if (failure.code !== "registry-limit") failures.set(failure.id, failure);
  });
  for (const buffer of captured.buffers) {
    const failure = failures.get(buffer.id);
    if (!failure) {
      runtime.retained.delete(buffer.id);
      runtime.retainedFailures.delete(buffer.id);
      continue;
    }
    const previous = runtime.retained.get(buffer.id);
    if (buffer.payload !== null || !previous) runtime.retained.set(buffer.id, buffer);
    runtime.retainedFailures.set(buffer.id, failure);
  }
}

function mergeOwnerRetainedBuffers(
  runtime: RecoveryLocalBufferRuntime,
  captured: RecoveryLocalBufferCaptureSnapshot,
) {
  const retained = [...runtime.retained.values()];
  const capturedFailureIds = new Set(captured.failures.map((failure) => failure.id));
  const retainedFailures = [...runtime.retainedFailures.entries()]
    .filter(([id]) => !capturedFailureIds.has(id))
    .map(([, failure]) => failure);
  if (!retained.length && !retainedFailures.length) return captured;
  const retainedById = new Map(retained.map((buffer) => [buffer.id, buffer]));
  const buffers = captured.buffers.map((buffer) => retainedById.get(buffer.id) ?? buffer);
  const capturedIds = new Set(captured.buffers.map((buffer) => buffer.id));
  retained.forEach((buffer) => {
    if (!capturedIds.has(buffer.id)) buffers.push(buffer);
  });
  return Object.freeze({
    ...captured,
    complete: captured.complete && retainedFailures.length === 0,
    status: captured.complete && retainedFailures.length === 0 ? "complete" as const : "incomplete" as const,
    failures: Object.freeze([...captured.failures, ...retainedFailures]),
    buffers: Object.freeze(buffers),
  });
}

/**
 * Retain the last local value before a NodeView is destroyed, then remove its
 * callback.  Removing the stale callback matters after PM remounts: a later
 * restore must never match an old NodeView by stable id and write into a
 * detached DOM tree.  Callback failures remain explicit capture failures.
 */
export function retainAndUnregisterRecoveryLocalBufferForOwner(owner: object, id: string) {
  assertOwner(owner);
  const runtime = ownerRuntime(owner);
  const registration = [...runtime.registry.entries, ...runtime.overflow.values()].find((entry) => entry.id === id);
  if (!registration) return null;
  const outcome = captureOne(registration);
  runtime.retained.set(id, outcome.buffer);
  if (outcome.failure) runtime.retainedFailures.set(id, outcome.failure);
  else runtime.retainedFailures.delete(id);
  if (runtime.overflow.delete(id)) {
    // The registration was already outside the normal quota.
  } else {
    const hadEntry = runtime.registry.entries.some((entry) => entry.id === id);
    runtime.registry = unregisterRecoveryLocalBuffer(runtime.registry, id);
    if (hadEntry && runtime.overflow.size > 0) {
      const [promotedId, promoted] = runtime.overflow.entries().next().value as [string, RecoveryLocalBufferRegistration];
      runtime.overflow.delete(promotedId);
      runtime.registry = registerRecoveryLocalBuffer(runtime.registry, promoted);
    }
  }
  runtime.restores.delete(id);
  return outcome.buffer;
}

/**
 * Restore only accepted/editing buffers.  A conflicted/orphaned buffer is
 * deliberately retained as an issue and never passed to a NodeView callback.
 * Cross-session ids are allowed to change; kind + positionHint is a guarded
 * fallback when an exact id is unavailable after PM reconstruction.
 */
export function restoreRecoveryLocalBuffersForOwner(
  owner: object,
  buffers: readonly RecoveryLocalBufferV3[],
): RecoveryLocalBufferRestoreSnapshot {
  assertOwner(owner);
  const runtime = ownerRuntime(owner);
  const issues: RecoveryLocalBufferRestoreIssue[] = [];
  let applied = 0;
  for (const buffer of buffers) {
    if (buffer.status === "conflicted" || buffer.status === "orphaned") {
      retainUnresolvedBuffer(runtime, buffer);
      issues.push(restoreIssue(buffer, "unresolved-buffer", "Conflicted or orphaned local buffer was retained without automatic application."));
      continue;
    }
    const registration = findRestoreRegistration(runtime, buffer);
    if (!registration) {
      retainUnresolvedBuffer(runtime, buffer);
      issues.push(restoreIssue(buffer, "restore-unbound", "No mounted NodeView restore callback matches this local buffer."));
      continue;
    }
    const restore = runtime?.restores.get(registration.id);
    if (!restore) {
      retainUnresolvedBuffer(runtime, buffer);
      issues.push(restoreIssue(buffer, "restore-unavailable", "The mounted NodeView did not expose a restore callback."));
      continue;
    }
    try {
      restore(buffer);
      runtime.retained.delete(buffer.id);
      runtime.retainedFailures.delete(buffer.id);
      applied += 1;
    } catch (error) {
      retainUnresolvedBuffer(runtime, buffer);
      issues.push(restoreIssue(
        buffer,
        "restore-failed",
        error instanceof Error ? error.message : String(error),
      ));
    }
  }
  const snapshot = Object.freeze({
    applied,
    issues: Object.freeze(issues),
  });
  if (runtime) runtime.lastRestore = snapshot;
  return snapshot;
}

export function recoveryLocalBufferRestoreIssuesForOwner(owner: object) {
  assertOwner(owner);
  return recoveryLocalRuntimes.get(owner)?.lastRestore
    ?? Object.freeze({ applied: 0, issues: Object.freeze([]) });
}

/**
 * Return whether a previous restore or an unmounted NodeView left local data
 * that still needs an explicit recovery decision.  This is intentionally a
 * cheap runtime flag: it does not invoke capture callbacks or inspect PM/DOM.
 */
export function hasRecoveryLocalBufferIssuesForOwner(owner: object) {
  assertOwner(owner);
  const runtime = recoveryLocalRuntimes.get(owner);
  if (!runtime) return false;
  if (runtime.lastRestore.issues.length > 0 || runtime.retainedFailures.size > 0) return true;
  return [...runtime.retained.values()].some((buffer) => buffer.status !== "accepted");
}

type RecoveryLocalBufferCaptureOutcome = {
  readonly buffer: RecoveryLocalBufferV3;
  readonly failure?: RecoveryLocalBufferCaptureFailure;
};

function captureOne(registration: RecoveryLocalBufferRegistration): RecoveryLocalBufferCaptureOutcome {
  let result: RecoveryLocalBufferCaptureResult;
  try {
    result = registration.capture();
  } catch (error) {
    return orphanOutcome(registration, {
      code: "capture-threw",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (!result || typeof result !== "object") {
    return orphanOutcome(registration, {
      code: "capture-result-invalid",
      message: "Local buffer capture did not return a result object.",
    });
  }
  if (result.ok === false) return orphanOutcome(registration, result);
  if (result.ok !== true || !result.buffer || typeof result.buffer !== "object") {
    return orphanOutcome(registration, {
      code: "capture-result-invalid",
      message: "Local buffer capture result must be an ok/failed discriminated value.",
    });
  }

  const candidate = result.buffer;
  if (candidate.id !== registration.id || candidate.kind !== registration.kind) {
    return orphanOutcome(registration, {
      code: "capture-identity-mismatch",
      message: "Local buffer capture identity does not match its registration.",
      payload: cloneOrNull(candidate.payload),
      sourceRevision: candidate.sourceRevision,
      pmPath: candidate.pmPath,
      positionHint: candidate.positionHint,
      rawSpan: candidate.rawSpan,
      ui: candidate.ui,
    });
  }

  try {
    return { buffer: freezeBuffer(copyBuffer(candidate)) };
  } catch (error) {
    return orphanOutcome(registration, {
      code: "capture-buffer-invalid",
      message: error instanceof Error ? error.message : String(error),
      payload: cloneOrNull(candidate.payload),
    });
  }
}

function orphanOutcome(
  registration: RecoveryLocalBufferRegistration,
  failure: Parameters<typeof orphanBuffer>[1],
): RecoveryLocalBufferCaptureOutcome {
  const buffer = orphanBuffer(registration, failure);
  return {
    buffer,
    failure: {
      id: buffer.id,
      kind: buffer.kind,
      code: buffer.error?.code || "capture-failed",
      message: buffer.error?.message || "Local buffer capture failed.",
    },
  };
}

function orphanBuffer(
  registration: RecoveryLocalBufferRegistration,
  failure: {
    readonly code: string;
    readonly message: string;
    readonly payload?: unknown;
    readonly status?: "conflicted" | "orphaned";
    readonly sourceRevision?: number;
    readonly pmPath?: readonly number[];
    readonly positionHint?: number | null;
    readonly rawSpan?: { readonly from: number; readonly to: number };
    readonly ui?: RecoveryLocalTextUi;
  },
): RecoveryLocalBufferV3 {
  const status = failure.status === "conflicted" ? "conflicted" : "orphaned";
  const sourceRevision = validRevision(failure.sourceRevision) ? failure.sourceRevision : registration.sourceRevision;
  const positionHint = validPositionHint(failure.positionHint) ? failure.positionHint : registration.positionHint;
  const errorCode = safeErrorPart(failure.code, "capture-failed", MAX_ERROR_CODE_LENGTH);
  const errorMessage = safeErrorPart(failure.message, "Local buffer capture failed.", MAX_ERROR_MESSAGE_LENGTH);
  let payload: unknown;
  try {
    payload = cloneJsonValue(failure.payload === undefined ? null : failure.payload);
  } catch {
    payload = null;
  }
  const pmPath = safeOptionalPath(failure.pmPath);
  const rawSpan = safeRawSpan(failure.rawSpan);
  const ui = safeUi(failure.ui);
  return freezeBuffer({
    id: registration.id,
    kind: registration.kind,
    status,
    sourceRevision,
    ...(pmPath ? { pmPath } : {}),
    ...(positionHint !== undefined ? { positionHint } : {}),
    ...(rawSpan ? { rawSpan } : {}),
    payload,
    ...(ui ? { ui } : {}),
    error: { code: errorCode, message: errorMessage },
  });
}

function copyBuffer(buffer: RecoveryLocalBufferV3): RecoveryLocalBufferV3 {
  assertId(buffer.id);
  if (!kinds.has(buffer.kind)) throw new Error("Local buffer kind is unsupported.");
  if (!validRevision(buffer.sourceRevision)) throw new Error("Local buffer sourceRevision is invalid.");
  if (buffer.status !== "accepted" && buffer.status !== "editing" && buffer.status !== "conflicted" && buffer.status !== "orphaned") {
    throw new Error("Local buffer status is unsupported.");
  }
  const pmPath = copyOptionalPath(buffer.pmPath);
  const rawSpan = copyRawSpan(buffer.rawSpan);
  if (buffer.positionHint !== undefined && !validPositionHint(buffer.positionHint)) {
    throw new Error("Local buffer positionHint is invalid.");
  }
  const positionHint = buffer.positionHint;
  const ui = copyUi(buffer.ui);
  const payload = cloneJsonValue(buffer.payload);
  const error = buffer.error == null ? undefined : copyError(buffer.error);
  if ((buffer.status === "conflicted" || buffer.status === "orphaned") && !error) {
    throw new Error("Conflicted or orphaned local buffers must retain a typed error.");
  }
  return {
    id: buffer.id,
    kind: buffer.kind,
    status: buffer.status,
    sourceRevision: buffer.sourceRevision,
    ...(pmPath ? { pmPath } : {}),
    ...(positionHint !== undefined ? { positionHint } : {}),
    ...(rawSpan ? { rawSpan } : {}),
    payload,
    ...(ui ? { ui } : {}),
    ...(error ? { error } : {}),
  };
}

function copyError(value: { readonly code: string; readonly message: string }) {
  if (!value || typeof value !== "object") throw new Error("Local buffer error must be an object.");
  return {
    code: safeErrorPart(value.code, "capture-failed", MAX_ERROR_CODE_LENGTH),
    message: safeErrorPart(value.message, "Local buffer capture failed.", MAX_ERROR_MESSAGE_LENGTH),
  };
}

function copyUi(value: RecoveryLocalTextUi | null | undefined): RecoveryLocalTextUi | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object") throw new Error("Local buffer UI selection must be an object.");
  if (!validOffset(value.anchor) || !validOffset(value.head)) throw new Error("Local buffer UI offsets are invalid.");
  if (value.direction !== "forward" && value.direction !== "backward" && value.direction !== "none") {
    throw new Error("Local buffer UI selection direction is unsupported.");
  }
  if (typeof value.focused !== "boolean" || typeof value.composing !== "boolean") {
    throw new Error("Local buffer UI focus/composition flags are invalid.");
  }
  return {
    anchor: value.anchor,
    head: value.head,
    direction: value.direction,
    focused: value.focused,
    composing: value.composing,
  };
}

function copyOptionalPath(value: readonly number[] | null | undefined): number[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PATH_LENGTH || value.some((entry) => !validOffset(entry))) {
    throw new Error("Local buffer PM path is invalid.");
  }
  return [...value];
}

function copyRawSpan(value: { readonly from: number; readonly to: number } | null | undefined) {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || !validOffset(value.from) || !validOffset(value.to) || value.from > value.to) {
    throw new Error("Local buffer raw span is invalid.");
  }
  return { from: value.from, to: value.to };
}

function cloneOrNull(value: unknown) {
  try {
    return cloneJsonValue(value === undefined ? null : value);
  } catch {
    return null;
  }
}

function safeOptionalPath(value: readonly number[] | null | undefined) {
  try {
    return copyOptionalPath(value);
  } catch {
    return undefined;
  }
}

function safeRawSpan(value: { readonly from: number; readonly to: number } | null | undefined) {
  try {
    return copyRawSpan(value);
  } catch {
    return undefined;
  }
}

function safeUi(value: RecoveryLocalTextUi | null | undefined) {
  try {
    return copyUi(value);
  } catch {
    return undefined;
  }
}

function cloneJsonValue(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > MAX_JSON_DEPTH) throw new Error("Local buffer payload is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Local buffer payload contains a non-finite number.");
    return value;
  }
  if (typeof value !== "object") throw new Error("Local buffer payload contains a non-JSON value.");
  if (seen.has(value)) throw new Error("Local buffer payload contains a cycle.");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => cloneJsonValue(entry, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (forbiddenKeys.has(key)) throw new Error("Local buffer payload contains a forbidden key.");
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: cloneJsonValue((value as Record<string, unknown>)[key], depth + 1, seen),
    });
  }
  seen.delete(value);
  return result;
}

function freezeBuffer(buffer: RecoveryLocalBufferV3): RecoveryLocalBufferV3 {
  deepFreeze(buffer.payload);
  if (buffer.pmPath) Object.freeze(buffer.pmPath);
  if (buffer.rawSpan) Object.freeze(buffer.rawSpan);
  if (buffer.ui) Object.freeze(buffer.ui);
  if (buffer.error) Object.freeze(buffer.error);
  return Object.freeze(buffer);
}

function deepFreeze(value: unknown, seen = new Set<object>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry, seen));
  } else {
    Object.keys(value).forEach((key) => deepFreeze((value as Record<string, unknown>)[key], seen));
  }
  return value;
}

function freezeRegistration(registration: RecoveryLocalBufferRegistration) {
  return Object.freeze({ ...registration });
}

function findRestoreRegistration(
  runtime: RecoveryLocalBufferRuntime | undefined,
  buffer: RecoveryLocalBufferV3,
) {
  if (!runtime) return null;
  const entries = [...runtime.registry.entries, ...runtime.overflow.values()];
  const exact = entries.find((entry) => entry.id === buffer.id);
  if (exact) return exact;
  if (buffer.positionHint === undefined || buffer.positionHint === null) return null;
  const candidates = entries.filter((entry) => (
    entry.kind === buffer.kind
    && entry.positionHint !== undefined
    && entry.positionHint !== null
    && entry.positionHint === buffer.positionHint
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

function restoreIssue(
  buffer: RecoveryLocalBufferV3,
  code: string,
  message: string,
): RecoveryLocalBufferRestoreIssue {
  return {
    id: buffer.id,
    kind: buffer.kind,
    status: buffer.status,
    code: safeErrorPart(code, "restore-failed", MAX_ERROR_CODE_LENGTH),
    message: safeErrorPart(message, "Local buffer restore failed.", MAX_ERROR_MESSAGE_LENGTH),
    payload: buffer.payload,
    buffer,
  };
}

function retainUnresolvedBuffer(runtime: RecoveryLocalBufferRuntime, buffer: RecoveryLocalBufferV3) {
  runtime.retained.set(buffer.id, freezeBuffer(copyBuffer(buffer)));
  runtime.retainedFailures.delete(buffer.id);
}

function freezeRegistry(registry: RecoveryLocalBufferRegistry): RecoveryLocalBufferRegistry {
  Object.freeze(registry.entries);
  return Object.freeze(registry);
}

function assertRegistry(registry: RecoveryLocalBufferRegistry) {
  if (!registry || typeof registry !== "object"
    || !Number.isSafeInteger(registry.version) || registry.version < 0
    || !Array.isArray(registry.entries) || registry.entries.length > MAX_REGISTRATIONS) {
    throw new RecoveryLocalRegistryError("invalid-registration", "Invalid local buffer registry.");
  }
  const ids = new Set<string>();
  for (const entry of registry.entries) {
    assertRegistration(entry);
    if (ids.has(entry.id)) {
      throw new RecoveryLocalRegistryError("invalid-registration", "Local buffer registry contains duplicate ids.");
    }
    ids.add(entry.id);
  }
}

function assertOwner(owner: object) {
  if (!owner || (typeof owner !== "object" && typeof owner !== "function")) {
    throw new RecoveryLocalRegistryError("invalid-registration", "Local buffer registry owner is invalid.");
  }
}

function assertRegistration(registration: RecoveryLocalBufferRegistration) {
  if (!registration || typeof registration !== "object") {
    throw new RecoveryLocalRegistryError("invalid-registration", "Local buffer registration must be an object.");
  }
  try {
    assertId(registration.id);
    if (!kinds.has(registration.kind)) throw new Error("Local buffer kind is unsupported.");
    if (!validRevision(registration.sourceRevision)) throw new Error("Local buffer sourceRevision is invalid.");
    if (registration.positionHint !== undefined && !validPositionHint(registration.positionHint)) {
      throw new Error("Local buffer positionHint is invalid.");
    }
    if (typeof registration.capture !== "function") throw new Error("Local buffer capture must be a function.");
    if (registration.restore !== undefined && typeof registration.restore !== "function") {
      throw new Error("Local buffer restore must be a function when provided.");
    }
  } catch (error) {
    throw new RecoveryLocalRegistryError("invalid-registration", error instanceof Error ? error.message : String(error));
  }
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH || value.includes("\u0000")) {
    throw new RecoveryLocalRegistryError("invalid-registration", "Local buffer id is invalid.");
  }
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validPositionHint(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || validOffset(value);
}

function safeErrorPart(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) return fallback;
  return value.slice(0, maxLength);
}
