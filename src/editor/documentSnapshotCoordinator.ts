import type { SnapshotReason } from "./documentRuntime";

export class DocumentSnapshotCoordinator {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controllers = new Map<string, AbortController>();

  schedule(
    tabId: string,
    task: (signal: AbortSignal) => Promise<void>,
    onError: (error: unknown) => void,
    delayMs = 500,
  ) {
    this.cancel(tabId);
    this.timers.set(tabId, setTimeout(() => {
      this.timers.delete(tabId);
      const controller = new AbortController();
      this.controllers.set(tabId, controller);
      void task(controller.signal).catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) onError(error);
      }).finally(() => {
        if (this.controllers.get(tabId) === controller) this.controllers.delete(tabId);
      });
    }, delayMs));
  }

  prepare(tabId: string, reason: SnapshotReason) {
    const timer = this.timers.get(tabId);
    if (timer) clearTimeout(timer);
    this.timers.delete(tabId);
    if (reason !== "indexIdle") this.abort(tabId);
  }

  cancel(tabId: string) {
    const timer = this.timers.get(tabId);
    if (timer) clearTimeout(timer);
    this.timers.delete(tabId);
    this.abort(tabId);
  }

  private abort(tabId: string) {
    this.controllers.get(tabId)?.abort();
    this.controllers.delete(tabId);
  }
}
