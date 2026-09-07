export interface SourceRange {
  from: number;
  to: number;
}

export interface SourcePatch extends SourceRange {
  insert: string;
  expected?: string;
}

export interface VersionedSelectionBookmark extends SourceRange {
  documentId: string;
  version: number;
  affinity?: "before" | "after";
}

export type SourceEnvelope = {
  bom: "" | "\uFEFF";
  lineEnding: "\r\n" | "\n" | "\r";
  terminalNewlines: string;
};

export type PreservedSourceBlock = {
  source: string;
  separator: string;
  synthetic?: "trailing-paragraph";
  generated?: "footnotes";
};

export type PreservedSourceBlockAlignment = {
  blocks: readonly PreservedSourceBlock[];
  syntheticTailOmitted: boolean;
};

export function sourceBlocksForNodeCount(
  sourceBlocks: readonly PreservedSourceBlock[],
  nodeCount: number,
): PreservedSourceBlockAlignment | null {
  if (sourceBlocks.length === nodeCount) return { blocks: sourceBlocks, syntheticTailOmitted: false };
  const syntheticTailIndex = sourceBlocks.findIndex((block) => block.synthetic === "trailing-paragraph");
  if (
    sourceBlocks.length === nodeCount + 1 &&
    syntheticTailIndex === sourceBlocks.length - 1
  ) {
    return {
      blocks: sourceBlocks.slice(0, syntheticTailIndex),
      syntheticTailOmitted: true,
    };
  }
  return null;
}

export function combinePreservedSourceBlocks(
  originalNodes: readonly object[],
  originalBlocks: readonly PreservedSourceBlock[],
  currentNodes: readonly object[],
  serializedCurrent: readonly string[],
  prefix: string,
  lineEnding: string,
  syntheticTailOmitted = false,
) {
  if (currentNodes.length !== serializedCurrent.length || originalNodes.length !== originalBlocks.length) {
    throw new SourcePatchConflictError("源码块映射与文档模型不一致。");
  }
  const oldIndex = new Map(originalNodes.map((node, index) => [node, index]));
  const matches: Array<{ old: number; current: number }> = [];
  let lastOld = -1;
  currentNodes.forEach((node, current) => {
    const old = oldIndex.get(node);
    if (old == null || old <= lastOld) return;
    matches.push({ old, current });
    lastOld = old;
  });

  // markdownTopLevelSourceBlocks may include the editor's synthetic trailing
  // paragraph as a zero-width block. It is a node identity anchor, not a
  // paragraph separator. Keep an edited final block adjacent to it at EOF.
  const syntheticTailIndex =
    originalBlocks.length > 0 &&
    originalBlocks[originalBlocks.length - 1].synthetic === "trailing-paragraph"
      ? originalBlocks.length - 1
      : -1;
  const generatedFootnoteTailIndex = originalBlocks.findIndex((block, index) =>
    block.generated === "footnotes" &&
    block.source === "" &&
    block.separator === "" &&
    (syntheticTailIndex === index + 1 || (syntheticTailOmitted && index === originalBlocks.length - 1))
  );

  let result = prefix;
  let oldCursor = 0;
  let currentCursor = 0;
  const appendChangedGroup = (oldEnd: number, currentEnd: number, atEnd = false) => {
    const replacements = serializedCurrent.slice(currentCursor, currentEnd).filter(Boolean);
    if (replacements.length) {
      if (oldCursor > 0 && oldCursor === originalBlocks.length) {
        const trailingLineEndings = result.match(/(?:\r\n|\r|\n)+$/)?.[0] ?? "";
        const trailingLineEndingCount = trailingLineEndings
          ? trailingLineEndings.match(/\r\n|\r|\n/g)?.length ?? 0
          : 0;
        if (trailingLineEndingCount < 2) {
          result += lineEnding.repeat(2 - trailingLineEndingCount);
        }
      }
      result += replacements.join(`${lineEnding}${lineEnding}`);
      const lastReplaced = oldEnd > oldCursor ? originalBlocks[oldEnd - 1] : null;
      const preservedSeparator = lastReplaced
        ? `${lastReplaced.source.match(/(?:\r\n|\r|\n)+$/)?.[0] ?? ""}${lastReplaced.separator}`
        : "";
      const endsAtSyntheticTail =
        syntheticTailIndex >= 0 &&
        oldEnd === syntheticTailIndex &&
        currentEnd === currentNodes.length - 1;
      const endsAtGeneratedFootnoteTail =
        generatedFootnoteTailIndex >= 0 &&
        oldEnd === generatedFootnoteTailIndex &&
        oldIndex.get(currentNodes[currentEnd]) === oldEnd;
      result += preservedSeparator || (atEnd || endsAtSyntheticTail || endsAtGeneratedFootnoteTail ? "" : `${lineEnding}${lineEnding}`);
    }
    oldCursor = oldEnd;
    currentCursor = currentEnd;
  };

  for (const match of matches) {
    appendChangedGroup(match.old, match.current);
    result += originalBlocks[match.old].source + originalBlocks[match.old].separator;
    oldCursor = match.old + 1;
    currentCursor = match.current + 1;
  }
  appendChangedGroup(originalBlocks.length, currentNodes.length, true);
  return result;
}

export class StaleSourceVersionError extends Error {
  constructor(expected: number, actual: number) {
    super(`源码版本已过期：期望 ${expected}，实际 ${actual}。`);
    this.name = "StaleSourceVersionError";
  }
}

export class SourcePatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePatchConflictError";
  }
}

export function inspectSourceEnvelope(source: string): SourceEnvelope {
  return {
    bom: source.startsWith("\uFEFF") ? "\uFEFF" : "",
    lineEnding: detectLineEnding(source),
    terminalNewlines: source.match(/(?:\r\n|\r|\n)+$/)?.[0] ?? "",
  };
}

export function applySourcePatches(
  source: string,
  patches: readonly SourcePatch[],
  expectedVersion?: number,
  actualVersion?: number,
) {
  if (expectedVersion != null && actualVersion != null && expectedVersion !== actualVersion) {
    throw new StaleSourceVersionError(expectedVersion, actualVersion);
  }
  const ordered = [...patches].sort((left, right) => left.from - right.from || left.to - right.to);
  let cursor = 0;
  let result = "";
  for (const patch of ordered) {
    assertRange(source, patch);
    if (patch.from < cursor) throw new SourcePatchConflictError("源码补丁范围重叠。");
    if (patch.expected != null && source.slice(patch.from, patch.to) !== patch.expected) {
      throw new SourcePatchConflictError("源码补丁的原文校验失败，已阻止覆盖。");
    }
    result += source.slice(cursor, patch.from);
    result += patch.insert;
    cursor = patch.to;
  }
  return result + source.slice(cursor);
}

export function sourcePatch(source: string, range: SourceRange, insert: string): SourcePatch {
  assertRange(source, range);
  return { ...range, insert, expected: source.slice(range.from, range.to) };
}

export function mapBookmarkThroughPatches(
  bookmark: VersionedSelectionBookmark,
  patches: readonly SourcePatch[],
  nextVersion: number,
): VersionedSelectionBookmark {
  let from = bookmark.from;
  let to = bookmark.to;
  for (const patch of [...patches].sort((left, right) => left.from - right.from)) {
    const delta = patch.insert.length - (patch.to - patch.from);
    if (patch.to <= from) {
      from += delta;
      to += delta;
    } else if (patch.from < to) {
      const edge = patch.from + patch.insert.length;
      from = Math.min(from, edge);
      to = Math.max(from, edge);
    }
  }
  return { ...bookmark, from, to, version: nextVersion };
}

function assertRange(source: string, range: SourceRange) {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.to < range.from || range.to > source.length) {
    throw new SourcePatchConflictError(`无效源码范围：${range.from}..${range.to}。`);
  }
}

function detectLineEnding(source: string): SourceEnvelope["lineEnding"] {
  const match = source.match(/\r\n|\r|\n/);
  return match?.[0] === "\r\n" ? "\r\n" : match?.[0] === "\r" ? "\r" : "\n";
}
