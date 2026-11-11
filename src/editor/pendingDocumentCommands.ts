/** Document-owned pending command positions. These records never retain views or dispatch closures. */
export type CommandModel = 'source' | 'wysiwyg';
export type PendingCommandKind = 'asset' | 'image';
export interface NativeCommandAnchor {
  from: number;
  to: number;
  binding?: Readonly<Record<string, string | number>>;
}
export interface CommandMapRange { from: number; to: number; inserted: number; attributeOnly?: boolean }
export type CommandPositionMap = readonly CommandMapRange[];
export interface PendingCommandHandle { readonly id: string; readonly documentId: string; readonly epoch: number }
export interface RawCommandProjection { from: number; to: number; expected: string; markdown: string; revision: number }
export interface PendingCommandRecord {
  handle: PendingCommandHandle;
  kind: PendingCommandKind;
  native: { lease: number; model: CommandModel; anchor: NativeCommandAnchor | null; queued: CommandPositionMap[] } | null;
  raw: RawCommandProjection | null;
  sequence: number;
  failure: string | null;
}
const commands = new Map<string, PendingCommandRecord>();

export function beginPendingCommand(identity: { documentId: string; epoch: number }, kind: PendingCommandKind, model: CommandModel, lease: number, anchor: NativeCommandAnchor) {
  const handle = Object.freeze({ id: crypto.randomUUID(), documentId: identity.documentId, epoch: identity.epoch });
  commands.set(handle.id, { handle, kind, native: { lease, model, anchor: { ...anchor }, queued: [] }, raw: null, sequence: 0, failure: null });
  return handle;
}
export function pendingCommand(handle: PendingCommandHandle) {
  const command = commands.get(handle.id);
  if (!command || command.handle.documentId !== handle.documentId || command.handle.epoch !== handle.epoch) throw new Error('原文档已关闭，已保留新资源，未插入其他文档。');
  if (command.failure) throw new Error(command.failure);
  return command;
}
export function pendingCommandsForDocument(documentId: string) { return [...commands.values()].filter(command => command.handle.documentId === documentId && !command.failure); }
export function releasePendingCommand(handle: PendingCommandHandle) { commands.delete(handle.id); }
export function clearPendingCommands(documentId: string) {
  for (const [key, command] of commands) if (command.handle.documentId === documentId) commands.delete(key);
}
export function failPendingCommand(command: PendingCommandRecord, reason = '原引用或插入位置已修改或删除，已保留新输入和资源，请刷新资源列表。') {
  command.failure = reason;
  command.native = null;
  command.raw = null;
}

function mapPoint(position: number, map: CommandPositionMap, affinity: -1 | 1) {
  let delta = 0;
  for (const change of map) {
    if (position < change.from) break;
    if (position <= change.to) {
      const side = change.from === change.to ? affinity : position === change.from ? -1 : position === change.to ? 1 : affinity;
      return change.from + delta + (side < 0 ? 0 : change.inserted);
    }
    delta += change.inserted - (change.to - change.from);
  }
  return position + delta;
}
export function mapCommandAnchor(anchor: NativeCommandAnchor, kind: PendingCommandKind, model: CommandModel | 'markdown', maps: readonly CommandPositionMap[]) {
  let current = { ...anchor };
  for (const map of maps) {
    const point = current.from === current.to;
    for (const change of map) {
      if (model === 'wysiwyg' && change.attributeOnly) continue;
      const deletesPoint = point && change.from < current.from && change.to > current.from;
      const deletesRange = !point && change.from <= current.from && change.to >= current.to && change.to > change.from;
      const modifiesSelectedText = kind === 'image' && !point && change.from < current.to && change.to > current.from;
      const modifiesSourceReference = kind === 'asset' && model !== 'wysiwyg'
        && (change.from === change.to ? change.from >= current.from && change.from <= current.to : change.from < current.to && change.to > current.from);
      if (deletesPoint || deletesRange || modifiesSelectedText || modifiesSourceReference) throw new Error('原引用或插入位置已修改或删除，已保留新输入和资源，请刷新资源列表。');
    }
    const from = mapPoint(current.from, map, 1);
    const to = point ? from : Math.max(from, mapPoint(current.to, map, -1));
    current = { ...current, from, to };
  }
  return current;
}
export function mapPendingCommands(documentId: string, lease: number, maps: readonly CommandPositionMap[], validate?: (anchor: NativeCommandAnchor) => boolean) {
  for (const command of pendingCommandsForDocument(documentId)) {
    const native = command.native;
    if (!native || native.lease !== lease) continue;
    const changed = maps.some(map => map.length > 0);
    if (changed) { command.sequence++; command.raw = null; }
    if (!native.anchor) {
      native.queued.push(...maps);
      if (native.queued.length > 2048) failPendingCommand(command, '定位转换期间编辑过多，已保留资源，请重新插入。');
      continue;
    }
    try {
      native.anchor = mapCommandAnchor(native.anchor, command.kind, native.model, maps);
      if (command.kind === 'asset' && validate && !validate(native.anchor)) failPendingCommand(command);
    } catch (error) { failPendingCommand(command, String(error instanceof Error ? error.message : error)); }
  }
}
export function projectPendingCommand(command: PendingCommandRecord, lease: number, sequence: number, projection: RawCommandProjection) {
  if (command.failure || command.native?.lease !== lease || command.sequence !== sequence) return;
  command.raw = projection;
}
export function detachPendingCommands(documentId: string, lease: number) {
  for (const command of pendingCommandsForDocument(documentId)) {
    if (command.native?.lease !== lease) continue;
    if (!command.raw) failPendingCommand(command, '原编辑视图未能保存精确插入位置，已保留资源，未插入其他文档。');
    else command.native = null;
  }
}
export function hydratePendingCommand(command: PendingCommandRecord, lease: number, anchor: NativeCommandAnchor, validate?: (anchor: NativeCommandAnchor) => boolean) {
  if (command.failure || command.native?.lease !== lease) return;
  try {
    command.native.anchor = mapCommandAnchor(anchor, command.kind, command.native.model, command.native.queued);
    command.native.queued = [];
    if (command.kind === 'asset' && validate && !validate(command.native.anchor)) failPendingCommand(command);
  } catch (error) { failPendingCommand(command, String(error instanceof Error ? error.message : error)); }
}
export function mapInactivePendingCommands(documentId: string, before: string, after: string, revision: number, map: CommandPositionMap) {
  for (const command of pendingCommandsForDocument(documentId)) {
    if (command.native || !command.raw) continue;
    if (command.raw.markdown !== before) { failPendingCommand(command); continue; }
    try {
      const anchor = mapCommandAnchor(command.raw, command.kind, 'markdown', [map]);
      command.raw = { ...command.raw, from: anchor.from, to: anchor.to, markdown: after, revision };
      command.sequence++;
    } catch (error) { failPendingCommand(command, String(error instanceof Error ? error.message : error)); }
  }
}
