export interface DiskReadFence { readonly key: string; readonly generation: number; readonly active: boolean }
export interface DiskWriteLease { readonly key: string; readonly operationId: number }

/** Own writes and stat responses are independently asynchronous; fence both edges. */
export class DocumentDiskWriteFence {
  private readonly paths = new Map<string, { generation: number; active: number }>();
  private readonly operations = new Map<number, string>();
  private sequence = 0;
  constructor(private readonly keyForPath: (path: string) => string = path => path) {}
  begin(path: string): DiskWriteLease {
    const key = this.keyForPath(path), operationId = ++this.sequence;
    const current = this.paths.get(key);
    this.paths.set(key, { generation: operationId, active: (current?.active ?? 0) + 1 });
    this.operations.set(operationId, key);
    return Object.freeze({ key, operationId });
  }
  finish(lease: DiskWriteLease) {
    if (this.operations.get(lease.operationId) !== lease.key) return;
    this.operations.delete(lease.operationId);
    const current = this.paths.get(lease.key)!;
    this.paths.set(lease.key, { generation: ++this.sequence, active: Math.max(0, current.active - 1) });
  }
  capture(path: string): DiskReadFence {
    const key = this.keyForPath(path), current = this.paths.get(key);
    return Object.freeze({ key, generation: current?.generation ?? 0, active: Boolean(current?.active) });
  }
  canPublish(read: DiskReadFence) {
    const current = this.paths.get(read.key);
    return !read.active && !current?.active && read.generation === (current?.generation ?? 0);
  }
}
