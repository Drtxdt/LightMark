import type { MarkdownSnapshot, SnapshotOptions, SnapshotReason } from "./documentRuntime";

type SnapshotSource = {
  tabId: () => string;
  revision: () => number;
  dirty: () => boolean;
  previousMarkdown: () => string;
  blocks: () => readonly object[];
  serializeBlock: (block: object) => string;
  convertBlock: (html: string) => string;
  combineBlocks: (blocks: readonly string[], previousMarkdown: string, sourceBlocks: readonly object[]) => string;
  oracle: (previousMarkdown: string) => string;
  verifyIncremental?: (reason: SnapshotReason) => boolean;
};

type PendingSnapshot = {
  revision: number;
  reason: SnapshotReason;
  promise: Promise<MarkdownSnapshot>;
  signal?: AbortSignal;
};

const IDLE_BUDGET_MS = 8;

export type WysiwygSnapshotDiagnostics = {
  compatibility: "unknown" | "compatible" | "fallback";
  oracleChecks: number;
  serializedBlocks: number;
  reusedBlocks: number;
  idleYields: number;
  maxSliceMs: number;
  mismatch?: {
    at: number;
    incrementalLength: number;
    oracleLength: number;
    incrementalExcerpt: string;
    oracleExcerpt: string;
  };
};

export class WysiwygSnapshotCache {
  private cached: MarkdownSnapshot | null = null;
  private pending: PendingSnapshot | null = null;
  private readonly markdownByBlock = new WeakMap<object, string>();
  private incrementalCompatible: boolean | null = null;
  private oracleChecks = 0;
  private serializedBlocks = 0;
  private reusedBlocks = 0;
  private idleYields = 0;
  private maxSliceMs = 0;
  private mismatch: WysiwygSnapshotDiagnostics["mismatch"];

  constructor(private readonly source: SnapshotSource) {}

  diagnostics(): WysiwygSnapshotDiagnostics {
    return {
      compatibility: this.incrementalCompatible == null
        ? "unknown"
        : this.incrementalCompatible ? "compatible" : "fallback",
      oracleChecks: this.oracleChecks,
      serializedBlocks: this.serializedBlocks,
      reusedBlocks: this.reusedBlocks,
      idleYields: this.idleYields,
      maxSliceMs: this.maxSliceMs,
      mismatch: this.mismatch,
    };
  }

  invalidate() {
    // Immutable ProseMirror nodes remain valid cache keys. Keep their serialized
    // blocks while invalidating only the assembled document snapshot.
    this.cached = null;
    this.pending = null;
  }

  async snapshot(reason: SnapshotReason, options: SnapshotOptions = {}) {
    const revision = this.source.revision();
    if (this.cached?.revision === revision && this.cached.tabId === this.source.tabId()) {
      return { ...this.cached, dirty: this.source.dirty() };
    }
    if (
      this.pending?.revision === revision
      && this.pending.reason === reason
      && !this.pending.signal?.aborted
    ) return this.pending.promise;

    const run = this.buildSnapshot(revision, reason, options);
    const pending = { revision, reason, promise: run, signal: options.signal };
    this.pending = pending;
    try {
      const snapshot = await run;
      if (this.source.revision() === revision) this.cached = snapshot;
      return { ...snapshot };
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  private async buildSnapshot(revision: number, reason: SnapshotReason, options: SnapshotOptions) {
    throwIfAborted(options.signal);
    const previousMarkdown = this.source.previousMarkdown();
    const blocks = [...this.source.blocks()];
    const serialized: string[] = [];
    let sliceStarted = now();

    for (const block of blocks) {
      throwIfAborted(options.signal);
      const blockStarted = now();
      let markdown = this.markdownByBlock.get(block);
      if (markdown == null) {
        markdown = this.source.convertBlock(this.source.serializeBlock(block));
        this.markdownByBlock.set(block, markdown);
        this.serializedBlocks += 1;
      } else {
        this.reusedBlocks += 1;
      }
      serialized.push(markdown);
      const sliceDuration = now() - sliceStarted;
      this.maxSliceMs = Math.max(this.maxSliceMs, isIdleReason(reason) ? sliceDuration : now() - blockStarted);
      if (isIdleReason(reason) && sliceDuration >= IDLE_BUDGET_MS) {
        this.idleYields += 1;
        await yieldToMainThread(options.signal);
        sliceStarted = now();
      }
    }

    const incremental = this.source.combineBlocks(serialized, previousMarkdown, blocks);
    const mustVerify = this.incrementalCompatible !== true || this.source.verifyIncremental?.(reason) === true;
    let markdown = incremental;
    if (mustVerify || this.incrementalCompatible === false) {
      throwIfAborted(options.signal);
      if (isIdleReason(reason)) await yieldToMainThread(options.signal);
      this.oracleChecks += 1;
      const oracle = this.source.oracle(previousMarkdown);
      throwIfAborted(options.signal);
      if (oracle === incremental) {
        this.incrementalCompatible = true;
        this.mismatch = undefined;
      } else {
        this.incrementalCompatible = false;
        const at = firstDifference(incremental, oracle);
        this.mismatch = {
          at,
          incrementalLength: incremental.length,
          oracleLength: oracle.length,
          incrementalExcerpt: incremental.slice(Math.max(0, at - 40), at + 80),
          oracleExcerpt: oracle.slice(Math.max(0, at - 40), at + 80),
        };
        markdown = oracle;
      }
    }

    return { tabId: this.source.tabId(), revision, markdown, dirty: this.source.dirty() } satisfies MarkdownSnapshot;
  }
}

function firstDifference(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return index;
  return length;
}

function isIdleReason(reason: SnapshotReason) {
  return reason === "indexIdle" || reason === "draft";
}

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

async function yieldToMainThread(signal?: AbortSignal) {
  throwIfAborted(signal);
  const schedulerApi = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (schedulerApi?.yield) await schedulerApi.yield();
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("文档快照已取消。", "AbortError");
}
