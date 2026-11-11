import { invoke } from "@tauri-apps/api/core";
import { reactive } from "vue";
import type { DirtyState, LargeCoordinateSpace } from "../types";
import { LARGE_WINDOW_BYTES, type LargePosition } from "./largeSourceWindow";
import { throwIfLargeSearchAborted } from './largeSearchCoordinator';

type LargeReceiptObserver = (command: string, args: Record<string, unknown>, receipt: unknown) => Promise<void> | void;
const receiptObservers = new Map<string, LargeReceiptObserver>();
/** Session-scoped debug receipt gate; release builds cannot install hooks. */
export function observeLargeSourceReceipts(sessionId: string, observer: LargeReceiptObserver) {
  if (!import.meta.env?.DEV) throw new Error("Large-file receipt observers are available only in development builds.");
  receiptObservers.set(sessionId, observer);
  return () => { if (receiptObservers.get(sessionId) === observer) receiptObservers.delete(sessionId); };
}
export async function invokeLargeSource<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const observer = typeof args.sessionId === "string" ? receiptObservers.get(args.sessionId) : undefined;
  const receipt = await invoke<T>(command, args);
  await observer?.(command, args, receipt);
  return receipt;
}

export interface LargeSourceIdentity {
  sessionId: string;
  revision: number;
  coordinateSpace: LargeCoordinateSpace;
}
/** A replayed completed job may describe an older root; never roll back the live projection. */
export function assertLargeStateReceipt(receipt: DirtyState, current: Pick<DirtyState, 'revision' | 'savedRevision' | 'coordinateSpace'>) {
  if (!receipt || receipt.coordinateSpace !== current.coordinateSpace || typeof receipt.isDirty !== 'boolean'
    || !Number.isSafeInteger(receipt.revision) || receipt.revision < current.revision
    || !Number.isSafeInteger(receipt.savedRevision) || receipt.savedRevision < current.savedRevision || receipt.savedRevision > receipt.revision
    || !Number.isSafeInteger(receipt.pendingEditCount) || receipt.pendingEditCount < 0) {
    throw new Error('大文件完成回执已过期或不完整，当前正文与输入已保留。');
  }
}
export interface LargeSourceRange extends LargeSourceIdentity {
  startLine: number; startColumn: number;
  endLine: number; endColumn: number;
  totalLines: number; text: string; truncated: boolean;
  contextPrefix?: string;
  contextReliable?: boolean;
}
export interface LargeRangeRequest {
  start: LargePosition;
  end?: LargePosition;
  maxBytes?: number;
  includeContext?: boolean;
}
export async function resolveLargeSourcePosition(identity: LargeSourceIdentity, position: LargePosition, mode: 'previous' | 'next' | 'clamp') {
  const receipt = await invokeLargeSource<LargeSourceIdentity & LargePosition>('resolve_large_position', {
    sessionId: identity.sessionId, expectedRevision: identity.revision, coordinateSpace: identity.coordinateSpace,
    line: position.line, column: position.column, mode,
  });
  if (receipt.sessionId !== identity.sessionId || receipt.revision !== identity.revision || receipt.coordinateSpace !== identity.coordinateSpace
    || !Number.isSafeInteger(receipt.line) || receipt.line < 0 || !Number.isSafeInteger(receipt.column) || receipt.column < 0) {
    throw new Error('大文件导航回执与捕获的文档坐标不一致。');
  }
  return { line: receipt.line, column: receipt.column };
}
export async function readLargeSourceRange(identity: LargeSourceIdentity, range: LargeRangeRequest) {
  const maxBytes = Math.min(LARGE_WINDOW_BYTES, Math.max(4, range.maxBytes ?? LARGE_WINDOW_BYTES));
  const receipt = await invokeLargeSource<LargeSourceRange>(range.includeContext ? "read_large_preview_range" : "read_file_range", {
    sessionId: identity.sessionId, expectedRevision: identity.revision,
    coordinateSpace: identity.coordinateSpace,
    startLine: range.start.line, startColumn: range.start.column,
    endLine: range.end?.line, endColumn: range.end?.column, maxBytes,
  });
  if (receipt.sessionId !== identity.sessionId || receipt.revision !== identity.revision
    || receipt.coordinateSpace !== identity.coordinateSpace
    || new TextEncoder().encode(receipt.text).byteLength > maxBytes) {
    throw new Error("大文件范围回执与捕获的会话、版本或读取上限不一致。");
  }
  return receipt;
}

export interface LargeSourceJob extends LargeSourceIdentity {
  jobId: string;
  kind: "search" | "replace";
  status: "running" | "completed" | "cancelled" | "failed";
  progress: number;
  result?: unknown;
  error?: string;
}
export const largeSourceJobs = reactive(new Map<string, LargeSourceJob>());
export async function cancelLargeSourceJob(sessionId: string) {
  const job = largeSourceJobs.get(sessionId);
  if (!job || job.status !== "running") return;
  await invokeLargeSource("cancel_large_job", { jobId: job.jobId, sessionId: job.sessionId,
    expectedRevision: job.revision, coordinateSpace: job.coordinateSpace });
}
export async function runLargeSourceJob<T>(identity: LargeSourceIdentity, kind: "search" | "replace", args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  throwIfLargeSearchAborted(signal);
  let jobId: string | undefined;
  let cancelRequest: Promise<unknown> | undefined;
  const cancel = () => {
    if (jobId && !cancelRequest) cancelRequest = invokeLargeSource('cancel_large_job', {
      jobId, sessionId: identity.sessionId, expectedRevision: identity.revision, coordinateSpace: identity.coordinateSpace,
    }).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    let job = await invokeLargeSource<LargeSourceJob>(kind === "search" ? "start_large_search_job" : "start_large_replace_job", {
      ...args, sessionId: identity.sessionId, expectedRevision: identity.revision, coordinateSpace: identity.coordinateSpace,
    });
    while (true) {
      if (typeof job.jobId !== 'string' || !job.jobId || jobId != null && job.jobId !== jobId
        || job.sessionId !== identity.sessionId || job.revision !== identity.revision
        || job.coordinateSpace !== identity.coordinateSpace || job.kind !== kind || !Number.isFinite(job.progress)
        || job.progress < 0 || job.progress > 1 || !['running', 'completed', 'cancelled', 'failed'].includes(job.status)) {
        throw new Error("大文件后台任务回执不属于捕获的文档版本。");
      }
      jobId = job.jobId;
      if (signal?.aborted) { cancel(); await cancelRequest; throwIfLargeSearchAborted(signal); }
      largeSourceJobs.set(identity.sessionId, job);
      if (job.status === "completed") return job.result as T;
      if (job.status === "cancelled") throw new Error("已取消大文件后台任务，正文保持原样。");
      if (job.status === "failed") throw new Error(job.error ?? "大文件后台任务失败。");
      await new Promise((resolve) => setTimeout(resolve, 75));
      job = await invokeLargeSource<LargeSourceJob>("poll_large_job", { jobId, sessionId: identity.sessionId,
        expectedRevision: identity.revision, coordinateSpace: identity.coordinateSpace });
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (largeSourceJobs.get(identity.sessionId)?.jobId === jobId) largeSourceJobs.delete(identity.sessionId);
  }
}
