import type { DocumentSourcePatch } from './documentRuntime';

/** Map a proven unchanged source range through a concurrent edit. Ambiguity rejects. */
export function rebaseUnchangedSourcePatch(before: string, after: string, patch: DocumentSourcePatch): DocumentSourcePatch {
  if (before.slice(patch.from, patch.to) !== patch.expected) throw new Error('原引用范围校验失败，已保留当前正文。');
  if (before === after) return patch;
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) { oldEnd--; newEnd--; }
  let from = patch.from, to = patch.to;
  if (from === to) {
    if (from >= oldEnd) from = to = from + newEnd - oldEnd;
    else if (from === prefix) from = to = newEnd;
    else if (from > prefix) throw new Error('原插入位置已被修改，已保留当前输入和新资源。');
  } else if (from >= oldEnd) { from += newEnd - oldEnd; to += newEnd - oldEnd; }
  else if (to > prefix) throw new Error('原引用已被修改或删除，请刷新资源列表。');
  if (after.slice(from, to) !== patch.expected) throw new Error('引用位置已失效，已保留当前正文。');
  return { ...patch, from, to };
}
