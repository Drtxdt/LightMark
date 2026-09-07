export type WindowCloseTicket<Authorization, SaveReceipt, DraftReceipt> = {
  authorization: Authorization;
  saveReceipts: readonly SaveReceipt[];
  draftReceipts: readonly DraftReceipt[];
  requireClean: boolean;
};

export function createWindowCloseTicket<Authorization, SaveReceipt, DraftReceipt>(
  authorization: Authorization,
  options: {
    saveReceipts?: readonly SaveReceipt[];
    draftReceipts?: readonly DraftReceipt[];
    requireClean?: boolean;
  } = {},
): WindowCloseTicket<Authorization, SaveReceipt, DraftReceipt> {
  return {
    authorization,
    saveReceipts: options.saveReceipts ?? [],
    draftReceipts: options.draftReceipts ?? [],
    requireClean: options.requireClean ?? false,
  };
}

export function windowCloseTicketIsCurrent<Authorization, SaveReceipt, DraftReceipt>(
  ticket: WindowCloseTicket<Authorization, SaveReceipt, DraftReceipt>,
  isAuthorizationCurrent: (
    authorization: Authorization,
    saveReceipts: readonly SaveReceipt[],
    draftReceipts: readonly DraftReceipt[],
  ) => boolean,
  hasUnsavedWork: () => boolean,
) {
  return isAuthorizationCurrent(ticket.authorization, ticket.saveReceipts, ticket.draftReceipts)
    && (!ticket.requireClean || !hasUnsavedWork());
}

export function invalidateWindowCloseTicketIfStale<Authorization, SaveReceipt, DraftReceipt>(
  ticket: WindowCloseTicket<Authorization, SaveReceipt, DraftReceipt>,
  isAuthorizationCurrent: (
    authorization: Authorization,
    saveReceipts: readonly SaveReceipt[],
    draftReceipts: readonly DraftReceipt[],
  ) => boolean,
  hasUnsavedWork: () => boolean,
  releasePreparation: () => void,
) {
  if (windowCloseTicketIsCurrent(ticket, isAuthorizationCurrent, hasUnsavedWork)) return false;
  releasePreparation();
  return true;
}

export async function closeWindowWithTicket<Authorization, SaveReceipt, DraftReceipt>(
  ticket: WindowCloseTicket<Authorization, SaveReceipt, DraftReceipt>,
  isAuthorizationCurrent: (
    authorization: Authorization,
    saveReceipts: readonly SaveReceipt[],
    draftReceipts: readonly DraftReceipt[],
  ) => boolean,
  hasUnsavedWork: () => boolean,
  close: () => Promise<unknown>,
) {
  if (!windowCloseTicketIsCurrent(ticket, isAuthorizationCurrent, hasUnsavedWork)) {
    return { closed: false as const };
  }
  try {
    await close();
    return { closed: true as const };
  } catch (error) {
    return { closed: false as const, error };
  }
}

export function createWindowClosePreparationGate() {
  let active = false;
  return {
    tryEnter() {
      if (active) return false;
      active = true;
      return true;
    },
    release() {
      active = false;
    },
    get active() {
      return active;
    },
  };
}

export type WindowCloseDecision = "cancel" | "discard" | "save";

export type WindowClosePreparationResult<Authorization, SaveReceipt, DraftReceipt> =
  | {
      status: "ready";
      ticket: WindowCloseTicket<Authorization, SaveReceipt, DraftReceipt>;
    }
  | { status: "cancelled" }
  | { status: "blocked"; action?: WindowCloseDecision; error: unknown };

type SavePreparationResult<SaveReceipt> = {
  saved: boolean;
  receipts: readonly SaveReceipt[];
  error?: unknown;
};

type DraftPreparationResult<DraftReceipt> = {
  ok: boolean;
  receipts: readonly DraftReceipt[];
  failures?: readonly { error: unknown }[];
};

/**
 * Coordinate the asynchronous part of the window-close decision.  The
 * caller supplies production capture/save/draft functions, so this logic can
 * be tested without launching a native window while App.vue still uses the
 * exact same implementation.
 */
export async function prepareWindowClose<
  Authorization,
  Tab,
  SaveReceipt,
  DraftReceipt,
>(options: {
  captureAuthorization: () => Authorization;
  preparePromptAuthorization?: () => Promise<Authorization>;
  getDirtyTabs: () => readonly Tab[];
  requestDecision: (dirtyTabs: readonly Tab[]) => Promise<WindowCloseDecision>;
  saveAll: (authorization: Authorization) => Promise<SavePreparationResult<SaveReceipt>>;
  flushDrafts: (
    authorization: Authorization,
    tabs: readonly Tab[],
  ) => Promise<DraftPreparationResult<DraftReceipt>>;
  isAuthorizationCurrent: (
    authorization: Authorization,
    saveReceipts: readonly SaveReceipt[],
    draftReceipts: readonly DraftReceipt[],
  ) => boolean;
}): Promise<WindowClosePreparationResult<Authorization, SaveReceipt, DraftReceipt>> {
  const blocked = (error: unknown, action?: WindowCloseDecision) => ({
    status: "blocked" as const,
    action,
    error,
  });
  let promptAuthorization: Authorization;
  try {
    promptAuthorization = options.preparePromptAuthorization
      ? await options.preparePromptAuthorization()
      : options.captureAuthorization();
  } catch (error) {
    return blocked(error);
  }
  const dirtyTabs = options.getDirtyTabs();
  const flushFor = (authorization: Authorization) => (
    options.flushDrafts(authorization, options.getDirtyTabs())
  );
  const ready = (
    authorization: Authorization,
    saveReceipts: readonly SaveReceipt[],
    draftReceipts: readonly DraftReceipt[],
    requireClean: boolean,
  ) => ({
    status: "ready" as const,
    ticket: createWindowCloseTicket(authorization, {
      saveReceipts,
      draftReceipts,
      requireClean,
    }),
  });
  if (dirtyTabs.length === 0) {
    const drafts = await flushFor(promptAuthorization);
    if (!drafts.ok || !options.isAuthorizationCurrent(promptAuthorization, [], drafts.receipts)) {
      return blocked(firstDraftError(drafts) ?? new Error("退出前的文档准备未完成。"));
    }
    return ready(promptAuthorization, [], drafts.receipts, false);
  }

  const decision = await options.requestDecision(dirtyTabs);
  if (decision === "cancel") return { status: "cancelled" };
  if (decision === "save") {
    const saveAuthorization = options.captureAuthorization();
    const saved = await options.saveAll(saveAuthorization);
    if (!saved.saved) return blocked(saved.error ?? new Error("仍有未保存修改，未准备关闭窗口。"), decision);
    const drafts = await flushFor(saveAuthorization);
    if (!drafts.ok
      || options.getDirtyTabs().length > 0
      || !options.isAuthorizationCurrent(saveAuthorization, saved.receipts, drafts.receipts)) {
      return blocked(firstDraftError(drafts) ?? new Error("仍有未保存修改，未准备关闭窗口。"), decision);
    }
    return ready(saveAuthorization, saved.receipts, drafts.receipts, true);
  }

  if (!options.isAuthorizationCurrent(promptAuthorization, [], [])) {
    return blocked(new Error("确认期间文档版本发生了变化，未退出。"), decision);
  }
  const drafts = await flushFor(promptAuthorization);
  if (!drafts.ok || !options.isAuthorizationCurrent(promptAuthorization, [], drafts.receipts)) {
    return blocked(firstDraftError(drafts) ?? new Error("退出前的恢复草稿未完成。"), decision);
  }
  return ready(promptAuthorization, [], drafts.receipts, false);
}

function firstDraftError<DraftReceipt>(result: DraftPreparationResult<DraftReceipt>) {
  return result.failures?.[0]?.error;
}
