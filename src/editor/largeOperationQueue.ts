import type { DocumentTab, EditorPaneId, LargeCoordinateSpace } from "../types";

/**
 * Identity captured at the edge of a large-file operation.  The raw tab and
 * pane are deliberately part of the identity: a session id alone is not
 * enough when a split pane is re-used while an IPC request is in flight.
 */
export interface LargeSessionIdentity {
  tab: DocumentTab;
  tabId: string;
  paneId: EditorPaneId;
  sessionId: string;
  /** Raw LargeFileState identity used by backend acknowledgements. */
  sessionIdentity: object;
  /** Optional mounted editor adapter used only for input/focus fences. */
  editorIdentity: object | null;
  revision: number;
  coordinateSpace: LargeCoordinateSpace;
}

export class LargeSessionStaleError extends Error {
  readonly code = "large-session-stale" as const;

  constructor(message = "大文件会话已变化，已阻止使用旧请求结果。") {
    super(message);
    this.name = "LargeSessionStaleError";
  }
}

export class LargeCompositionDeferredError extends Error {
  readonly code = "large-composition-deferred" as const;

  constructor(message = "输入法组合文字尚未结束，操作已延期。") {
    super(message);
    this.name = "LargeCompositionDeferredError";
  }
}

export function largeSessionIdentityMatches(
  captured: LargeSessionIdentity,
  current: LargeSessionIdentity | null,
) {
  return Boolean(
    current
      && current.tab === captured.tab
      && current.tabId === captured.tabId
      && current.sessionId === captured.sessionId
      && current.coordinateSpace === captured.coordinateSpace
      && current.sessionIdentity === captured.sessionIdentity,
  );
}

type QueuedOperation<T> = (
  captured: LargeSessionIdentity,
  current: LargeSessionIdentity,
) => Promise<T> | T;
export type LargeIdentityMatcher = (
  captured: LargeSessionIdentity,
  current: LargeSessionIdentity | null,
) => boolean;

export interface LargeQueueFailure {
  operation: string;
  error: unknown;
}

/**
 * Serializes operations for one raw tab.  A rejected operation clears the
 * tail before the next explicit operation is accepted, so one failed IPC
 * call cannot poison the queue.  This class never retries a rejected
 * operation; callers keep their outbox/input and must request a retry.
 */
export class LargeOperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lastFailureValue: LargeQueueFailure | null = null;

  enqueue<T>(
    operation: string,
    captured: LargeSessionIdentity,
    current: () => LargeSessionIdentity | null,
    task: QueuedOperation<T>,
    matches: LargeIdentityMatcher = largeSessionIdentityMatches,
  ) {
    const run = this.tail
      .catch(() => undefined)
      .then(async () => {
        const before = current();
        if (!matches(captured, before)) throw new LargeSessionStaleError();
        const result = await task(captured, before!);
        const after = current();
        if (!matches(captured, after)) throw new LargeSessionStaleError();
        return result;
      });
    this.tail = run.then(
      () => undefined,
      (error) => {
        this.lastFailureValue = { operation, error };
        return undefined;
      },
    );
    return run;
  }

  async idle() {
    await this.tail;
  }

  get lastFailure() {
    return this.lastFailureValue;
  }

  clearFailure() {
    this.lastFailureValue = null;
  }
}
