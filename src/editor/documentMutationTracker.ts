export type DocumentMutationToken = Readonly<{
  documentGeneration: number;
  pendingInputVersion: number;
  revision: number;
}>;

export const DOCUMENT_FLUSH_META_KEY = "lightmarkPendingFlushId" as const;
export const DOCUMENT_APPENDED_TRANSACTION_META_KEY = "appendedTransaction" as const;

export type PendingMathFlushRequest = Readonly<{
  flushId: string;
}>;

export type DocumentMutationOrigin =
  | { kind: "pending-flush"; flushId: string }
  | { kind: "document" };

export type DocumentFlushReceipt = Readonly<{
  sessionIdentity: object;
  flushId: string;
  before: DocumentMutationToken;
  after: DocumentMutationToken;
  firstAuthorizedGeneration: number | null;
  lastAuthorizedGeneration: number | null;
  authorizedMutationCount: number;
}>;

export interface DocumentFlushHandle {
  readonly id: string;
  readonly before: DocumentMutationToken;
  complete(after?: DocumentMutationToken): DocumentFlushReceipt;
  fail(): void;
}

export interface DocumentMutationTracker {
  token(): DocumentMutationToken;
  recordDocumentChange(origin?: DocumentMutationOrigin): number;
  setRevision(nextRevision: number): number;
  recordPendingInput(): number;
  beginFlush(expected?: DocumentMutationToken): DocumentFlushHandle;
  readonly activeFlushId: string | null;
}

type ActiveFlush = {
  id: string;
  before: DocumentMutationToken;
  invalid: boolean;
  unauthorizedMutationCount: number;
  authorizedMutationCount: number;
  firstAuthorizedGeneration: number | null;
  lastAuthorizedGeneration: number | null;
};

export function createDocumentMutationTracker(options: {
  sessionIdentity: object;
  initialRevision?: number;
}): DocumentMutationTracker {
  let documentGeneration = 0;
  let pendingInputVersion = 0;
  let revision = options.initialRevision ?? 0;
  let flushSequence = 0;
  let activeFlush: ActiveFlush | null = null;

  const token = (): DocumentMutationToken => ({
    documentGeneration,
    pendingInputVersion,
    revision,
  });

  const failActiveFlushForMutation = () => {
    if (!activeFlush) return;
    activeFlush.invalid = true;
    activeFlush.unauthorizedMutationCount += 1;
  };

  const recordDocumentChange = (
    origin: DocumentMutationOrigin = { kind: "document" },
  ) => {
    documentGeneration += 1;
    if (!activeFlush) return documentGeneration;
    if (origin.kind === "pending-flush" && origin.flushId === activeFlush.id) {
      activeFlush.authorizedMutationCount += 1;
      activeFlush.firstAuthorizedGeneration ??= documentGeneration;
      activeFlush.lastAuthorizedGeneration = documentGeneration;
      return documentGeneration;
    }
    failActiveFlushForMutation();
    return documentGeneration;
  };

  const setRevision = (nextRevision: number) => {
    revision = nextRevision;
    return revision;
  };

  const recordPendingInput = () => {
    pendingInputVersion += 1;
    failActiveFlushForMutation();
    return pendingInputVersion;
  };

  const beginFlush = (expected?: DocumentMutationToken) => {
    if (activeFlush) throw new Error("文档 flush 已在进行中。");
    const before = token();
    if (expected && !documentMutationTokensEqual(expected, before)) {
      throw new Error("文档版本在 flush 开始前已变化。");
    }
    const id = `document-flush-${++flushSequence}`;
    activeFlush = {
      id,
      before,
      invalid: false,
      unauthorizedMutationCount: 0,
      authorizedMutationCount: 0,
      firstAuthorizedGeneration: null,
      lastAuthorizedGeneration: null,
    };
    let finished = false;
    const handle: DocumentFlushHandle = {
      id,
      before,
      complete(after: DocumentMutationToken = token()): DocumentFlushReceipt {
        if (finished) throw new Error("文档 flush receipt 已结束。");
        finished = true;
        const current = token();
        const currentFlush = activeFlush;
        activeFlush = null;
        if (!currentFlush || currentFlush.id !== id) throw new Error("文档 flush 会话已失效。");
        if (!documentMutationTokensEqual(after, current)) {
          throw new Error("文档 flush 完成时版本已变化。");
        }
        if (currentFlush.invalid || currentFlush.unauthorizedMutationCount > 0) {
          throw new Error("文档 flush 期间发生了未授权变化。");
        }
        const generationDelta = current.documentGeneration - before.documentGeneration;
        if (generationDelta !== currentFlush.authorizedMutationCount) {
          throw new Error("文档 flush 的 revision 变化来源无法证明。");
        }
        return {
          sessionIdentity: options.sessionIdentity,
          flushId: id,
          before,
          after: current,
          firstAuthorizedGeneration: currentFlush.firstAuthorizedGeneration,
          lastAuthorizedGeneration: currentFlush.lastAuthorizedGeneration,
          authorizedMutationCount: currentFlush.authorizedMutationCount,
        };
      },
      fail() {
        if (finished) return;
        finished = true;
        if (activeFlush?.id === id) activeFlush = null;
      },
    };
    return handle;
  };

  return {
    token,
    recordDocumentChange,
    setRevision,
    recordPendingInput,
    beginFlush,
    get activeFlushId() {
      return activeFlush?.id ?? null;
    },
  };
}

export function documentMutationTokensEqual(
  left: DocumentMutationToken,
  right: DocumentMutationToken,
) {
  return left.documentGeneration === right.documentGeneration
    && left.pendingInputVersion === right.pendingInputVersion
    && left.revision === right.revision;
}
