import { toRaw } from "vue";
import type { DocumentSessionAdapter } from "../editor/documentRuntime";
import {
  documentMutationTokensEqual,
  type DocumentFlushReceipt,
  type DocumentMutationToken,
} from "../editor/documentMutationTracker";
import type { DocumentTab } from "../types";

export interface SaveVersion {
  tab: object;
  tabId: string;
  path: string;
  epoch: number;
  revision: number | null;
  session: object | null;
  pendingVersion?: number | null;
  mutationToken?: DocumentMutationToken | null;
  flushReceipt?: DocumentFlushReceipt;
}

/**
 * A draft flush that was authorized by the window-close prompt.  A pending
 * editor buffer may legitimately acquire a new document revision while it is
 * being flushed; the before/after pair lets the close coordinator distinguish
 * that expected flush from a new edit made after the prompt.
 */
export interface WindowCloseDraftReceipt {
  tab: DocumentTab;
  tabId: string;
  path: string;
  session: DocumentSessionAdapter | null;
  beforeEpoch: number;
  beforeRevision: number | null;
  beforePendingVersion: number | null;
  beforePending: boolean;
  beforeMutationToken: DocumentMutationToken | null;
  afterEpoch: number;
  afterRevision: number | null;
  afterPendingVersion: number | null;
  afterPending: boolean;
  afterMutationToken: DocumentMutationToken | null;
  flushReceipt?: DocumentFlushReceipt;
  content: string;
  dirty: boolean;
  draftId: string;
}

const mutationEpochs = new WeakMap<object, number>();

function identity(tab: object) {
  return toRaw(tab) as object;
}

export function mutationEpoch(tab: object) {
  return mutationEpochs.get(identity(tab)) ?? 0;
}

export function advanceMutationEpoch(tab: object) {
  const raw = identity(tab);
  const next = mutationEpoch(raw) + 1;
  mutationEpochs.set(raw, next);
  return next;
}

export function saveVersionIsCurrent(
  version: SaveVersion,
  current: {
    tab: object;
    tabId: string;
    path: string;
    epoch: number;
    revision: number | null;
    session: object | null;
    pendingVersion?: number | null;
    mutationToken?: DocumentMutationToken | null;
  },
) {
  const versionPending = version.pendingVersion ?? null;
  const currentPending = current.pendingVersion ?? null;
  return identity(version.tab) === identity(current.tab)
    && version.tabId === current.tabId
    && version.path === current.path
    && version.epoch === current.epoch
    && version.session === current.session
    && version.revision === current.revision
    && versionPending === currentPending
    && (!version.mutationToken
      || (current.mutationToken != null && documentMutationTokensEqual(version.mutationToken, current.mutationToken)));
}

export class SaveTransactionQueue {
  private readonly lanes = new WeakMap<object, Promise<unknown>>();

  enqueue<T>(tab: object, task: () => Promise<T>) {
    const identityTab = identity(tab);
    const previous = this.lanes.get(identityTab) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    let tracked: Promise<T>;
    tracked = run.then(
      (value) => {
        if (this.lanes.get(identityTab) === tracked) this.lanes.delete(identityTab);
        return value;
      },
      (error) => {
        if (this.lanes.get(identityTab) === tracked) this.lanes.delete(identityTab);
        throw error;
      },
    );
    this.lanes.set(identityTab, tracked);
    return tracked;
  }
}

export type VersionedSavePhase = "before-write" | "after-write" | "after-commit";

export type VersionedSaveResult<T> =
  | { saved: true; snapshot: T }
  | { saved: false; phase: VersionedSavePhase };

export async function runVersionedSave<T>(options: {
  isCurrent: () => boolean;
  write: () => Promise<void>;
  stat: () => Promise<T>;
  commit: (snapshot: T) => boolean;
  afterCommit?: () => Promise<void>;
  isStable: () => boolean;
}): Promise<VersionedSaveResult<T>> {
  if (!options.isCurrent()) return { saved: false, phase: "before-write" };
  await options.write();
  const snapshot = await options.stat();
  if (!options.isCurrent()) return { saved: false, phase: "after-write" };
  if (!options.commit(snapshot)) return { saved: false, phase: "after-write" };
  await options.afterCommit?.();
  if (!options.isStable()) return { saved: false, phase: "after-commit" };
  return { saved: true, snapshot };
}
