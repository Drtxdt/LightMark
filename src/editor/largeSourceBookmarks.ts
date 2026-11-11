import type { LargePosition } from "./largeSourceWindow";
export interface LargeSelectionBookmark { anchor: LargePosition; head: LargePosition }
export interface LargeHistoryBookmark { before: LargeSelectionBookmark; after: LargeSelectionBookmark }
export interface LargeSessionBookmarks {
  selection: LargeSelectionBookmark;
  undo: LargeHistoryBookmark[];
  redo: LargeHistoryBookmark[];
}
const sessions = new Map<string, LargeSessionBookmarks>();
const openedSizes = new Map<string, number>();
export function largeSessionOpenedSize(sessionId: string, sizeBytes: number) {
  if (!openedSizes.has(sessionId)) openedSizes.set(sessionId, sizeBytes);
  return openedSizes.get(sessionId)!;
}
/** Only coordinates survive view destruction; no editor instance or document text. */
export function largeSessionBookmarks(sessionId: string) {
  let state = sessions.get(sessionId);
  if (!state) {
    state = { selection: { anchor: { line: 0, column: 0 }, head: { line: 0, column: 0 } }, undo: [], redo: [] };
    sessions.set(sessionId, state);
  }
  return state;
}
export function releaseLargeSessionBookmarks(sessionId: string) { sessions.delete(sessionId); openedSizes.delete(sessionId); }
