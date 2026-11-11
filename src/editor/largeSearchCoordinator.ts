export function throwIfLargeSearchAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('大文件查找已取消。', 'AbortError');
}

/** Share identical in-flight searches and cancel obsolete query generations. */
export class LargeSearchCoordinator<T> {
  private active: { key: string; revision: number; controller: AbortController; promise: Promise<T> } | null = null;
  search(key: string, revision: number, run: (signal: AbortSignal) => Promise<T>) {
    if (this.active?.key === key && this.active.revision === revision) return this.active.promise;
    this.cancel();
    const controller = new AbortController();
    const entry = { key, revision, controller, promise: null as unknown as Promise<T> };
    entry.promise = Promise.resolve().then(() => {
      throwIfLargeSearchAborted(controller.signal);
      return run(controller.signal);
    }).finally(() => { if (this.active === entry) this.active = null; });
    this.active = entry;
    return entry.promise;
  }
  cancel() { this.active?.controller.abort(); this.active = null; }
}
