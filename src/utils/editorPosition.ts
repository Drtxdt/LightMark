import type { EditorMode, EditorPositionSnapshot } from "../types";

export function clampMarkdownPosition(
  input: Pick<Partial<EditorPositionSnapshot>, "markdownAnchor" | "markdownHead">,
  markdownLength: number,
) {
  const max = Math.max(0, markdownLength);
  return {
    markdownAnchor: clampNumber(input.markdownAnchor, 0, max),
    markdownHead: clampNumber(input.markdownHead, 0, max),
  };
}

export function normalizeScrollSnapshot(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const nextScrollTop = clampNumber(scrollTop, 0, maxScrollTop);
  return {
    scrollTop: nextScrollTop,
    scrollRatio: maxScrollTop > 0 ? nextScrollTop / maxScrollTop : 0,
  };
}

export function lineInfoAtMarkdownOffset(markdown: string, offset: number) {
  const anchor = clampNumber(offset, 0, markdown.length);
  const before = markdown.slice(0, anchor);
  const lines = before.split(/\r?\n/);
  const line = lines.length;
  const column = lines[lines.length - 1]?.length ?? 0;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEndMatch = markdown.slice(anchor).match(/\r?\n/);
  const lineEnd = lineEndMatch ? anchor + lineEndMatch.index! : markdown.length;
  return {
    markdownLine: line,
    markdownColumn: column,
    markdownLineText: markdown.slice(lineStart, lineEnd),
  };
}

export function buildEditorPositionSnapshot(input: {
  editorMode: EditorMode;
  markdown: string;
  markdownAnchor: number;
  markdownHead?: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  updatedAt?: number;
}): EditorPositionSnapshot {
  const clamped = clampMarkdownPosition(
    {
      markdownAnchor: input.markdownAnchor,
      markdownHead: input.markdownHead ?? input.markdownAnchor,
    },
    input.markdown.length,
  );
  const line = lineInfoAtMarkdownOffset(input.markdown, clamped.markdownAnchor);
  const scroll =
    typeof input.scrollTop === "number" && typeof input.scrollHeight === "number" && typeof input.clientHeight === "number"
      ? normalizeScrollSnapshot(input.scrollTop, input.scrollHeight, input.clientHeight)
      : { scrollTop: 0, scrollRatio: 0 };
  return {
    editorMode: input.editorMode,
    ...clamped,
    ...line,
    ...scroll,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

export function mergeEditorPosition(
  previous: EditorPositionSnapshot | null | undefined,
  patch: Partial<EditorPositionSnapshot>,
  markdownLength: number,
): EditorPositionSnapshot {
  const base: EditorPositionSnapshot = previous ?? {
    editorMode: patch.editorMode ?? "wysiwyg",
    markdownAnchor: 0,
    markdownHead: 0,
    markdownLine: 1,
    markdownColumn: 0,
    markdownLineText: "",
    scrollTop: 0,
    scrollRatio: 0,
    updatedAt: 0,
  };
  const clamped = clampMarkdownPosition(
    {
      markdownAnchor: patch.markdownAnchor ?? base.markdownAnchor,
      markdownHead: patch.markdownHead ?? base.markdownHead,
    },
    markdownLength,
  );
  return {
    ...base,
    ...patch,
    ...clamped,
    scrollTop: Math.max(0, patch.scrollTop ?? base.scrollTop),
    scrollRatio: clampNumber(patch.scrollRatio ?? base.scrollRatio, 0, 1),
    updatedAt: patch.updatedAt ?? Date.now(),
  };
}

export function scrollTopFromSnapshot(snapshot: EditorPositionSnapshot, scrollHeight: number, clientHeight: number) {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (snapshot.scrollTop > 0) return clampNumber(snapshot.scrollTop, 0, maxScrollTop);
  return clampNumber(snapshot.scrollRatio, 0, 1) * maxScrollTop;
}

function clampNumber(value: number | undefined, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
