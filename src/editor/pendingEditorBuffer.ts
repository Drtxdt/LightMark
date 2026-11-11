import type { PendingMathFlushRequest } from './documentMutationTracker';

export interface PendingEditorBuffer {
  readonly id: string;
  readonly kind: string;
  hasPending(): boolean;
  flush(request: PendingMathFlushRequest): void | Promise<void>;
}
type Registry = { buffers: Set<PendingEditorBuffer>; version: number; listeners: Set<() => void> };
const registries = new WeakMap<object, Registry>();
function registry(owner: object) {
  let value = registries.get(owner);
  if (!value) { value = { buffers: new Set(), version: 0, listeners: new Set() }; registries.set(owner, value); }
  return value;
}
export function notifyPendingEditorInput(owner: object) {
  const value = registry(owner);
  value.version++;
  for (const listener of value.listeners) listener();
}
export function subscribePendingEditorInput(owner: object, listener: () => void) {
  const value = registry(owner);
  value.listeners.add(listener);
  return () => { value.listeners.delete(listener); };
}
export function registerPendingEditorBuffer(owner: object, buffer: PendingEditorBuffer) {
  const value = registry(owner);
  if ([...value.buffers].some(entry => entry.id === buffer.id)) throw new Error('局部输入缓冲身份重复。');
  value.buffers.add(buffer);
  return () => { value.buffers.delete(buffer); };
}
export function pendingEditorInputVersion(owner: object) { return registries.get(owner)?.version ?? 0; }
export function hasPendingEditorBuffers(owner: object) { return [...(registries.get(owner)?.buffers ?? [])].some(buffer => buffer.hasPending()); }
export async function flushPendingEditorBuffers(owner: object, request: PendingMathFlushRequest) {
  for (const buffer of [...(registries.get(owner)?.buffers ?? [])]) await buffer.flush(request);
}
