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

/** Empty PM paragraphs own blank-line gaps, which Markdown block tokens omit. */
export function sourceBlocksForNodes(sourceBlocks: readonly PreservedSourceBlock[], nodes: readonly { type: { name: string }; content: { size: number } }[], prefix: string) {
  const blocks: PreservedSourceBlock[] = [];
  const empty: number[] = [];
  let cursor = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index], source = sourceBlocks[cursor];
    // A BOM can produce a real whitespace-only paragraph token. It already
    // owns source bytes, so consume that anchor instead of inventing an empty
    // paragraph and leaving the token unmatched.
    const ownsWhitespaceSource = source && !source.synthetic && !source.generated && /^[ \t]*$/.test(source.source);
    if (node.type.name === 'paragraph' && node.content.size === 0
      && !ownsWhitespaceSource
      && !(index === nodes.length - 1 && source?.synthetic === 'trailing-paragraph')) {
      empty.push(index);
      blocks.push({ source: '', separator: '' });
    } else {
      if (!source) return null;
      blocks.push({ ...source });
      cursor++;
    }
  }
  const syntheticTailOmitted = cursor === sourceBlocks.length - 1 && sourceBlocks[cursor].synthetic === 'trailing-paragraph';
  if (cursor !== sourceBlocks.length && !syntheticTailOmitted) return null;
  for (let offset = 0; offset < empty.length;) {
    const start = empty[offset];
    let end = offset + 1;
    while (end < empty.length && empty[end] === empty[end - 1] + 1) end++;
    const gap = start === 0 ? prefix : blocks[start - 1].separator;
    // Hidden definitions or other source bytes never become whitespace anchors.
    if (/^\uFEFF?[ \t\r\n]*$/.test(gap)) {
      const endings = [...gap.matchAll(/\r\n|\r|\n/g)];
      const count = Math.min(end - offset, Math.max(0, Math.floor((endings.length - (start ? 1 : 0)) / 2)));
      if (count) {
        const first = endings.length - count * 2;
        const cut = endings[first].index!;
        if (start === 0) prefix = gap.slice(0, cut);
        else blocks[start - 1].separator = gap.slice(0, cut);
        for (let index = 0; index < count; index++) {
          const from = endings[first + index * 2].index!;
          const to = index === count - 1 ? gap.length : endings[first + index * 2 + 2].index!;
          blocks[empty[offset + index]].separator = gap.slice(from, to);
        }
      }
    }
    offset = end;
  }
  return { blocks, syntheticTailOmitted, prefix };
}

export function combinePreservedSourceBlocks(
  originalNodes: readonly object[],
  originalBlocks: readonly PreservedSourceBlock[],
  currentNodes: readonly object[],
  serializedCurrent: readonly string[],
  prefix: string,
  lineEnding: string,
  syntheticTailOmitted = false,
  preserveChangedBlock?: (source: string, before: object, after: object) => string | null,
) {
  if (currentNodes.length !== serializedCurrent.length || originalNodes.length !== originalBlocks.length) {
    throw new SourcePatchConflictError("源码块映射与文档模型不一致。");
  }
  // Tiptap can append its editable trailing paragraph on the first input.
  // The parser already proved that this zero-width source tail was omitted
  // from the original model. It must not turn a one-block edit into a 1 -> 2
  // replacement and bypass the exact local patch for that real block.
  const tail = currentNodes.at(-1) as { type?: { name?: string }; content?: { size?: number } } | undefined;
  if (syntheticTailOmitted && currentNodes.length === originalNodes.length + 1
    && tail?.type?.name === 'paragraph' && tail.content?.size === 0
    && !originalNodes.includes(tail)) {
    currentNodes = currentNodes.slice(0, -1);
    serializedCurrent = serializedCurrent.slice(0, -1);
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
    const exactReplacements = preserveChangedBlock && oldEnd - oldCursor === currentEnd - currentCursor
      ? currentNodes.slice(currentCursor, currentEnd).map((node, index) => preserveChangedBlock(originalBlocks[oldCursor + index].source, originalNodes[oldCursor + index], node))
      : null;
    if (exactReplacements?.length && exactReplacements.every((piece): piece is string => piece !== null)) {
      // Exact patches already own every byte of their original block,
      // including its terminal EOL. Only the separate separator follows it.
      exactReplacements.forEach((piece, index) => { result += piece + originalBlocks[oldCursor + index].separator; });
      oldCursor = oldEnd;
      currentCursor = currentEnd;
      return;
    }
    const replacements = serializedCurrent.slice(currentCursor, currentEnd).map((serialized, index) => {
      if (oldEnd - oldCursor !== currentEnd - currentCursor || !preserveChangedBlock) return serialized;
      // Compatibility replacements have their source envelope appended below.
      return exactReplacements?.[index]?.replace(/[\r\n]+$/, '') ?? serialized;
    }).filter((serialized, index) => Boolean(serialized)
      || (currentNodes[currentCursor + index] as { type?: { name?: string }; content?: { size?: number } })?.type?.name === 'paragraph'
        && (currentNodes[currentCursor + index] as { content?: { size?: number } }).content?.size === 0);
    if (replacements.length) {
      const firstReplacement = currentNodes[currentCursor] as { type?: { name?: string } } | undefined;
      const firstOriginal = originalNodes[oldCursor] as { type?: { name?: string } } | undefined;
      // A heading can follow an HTML atom with one EOL. A replacement
      // paragraph needs a blank line there, otherwise reparsing merges its
      // text into the preceding HTML block and loses the source/model map.
      if (oldCursor > 0 && firstReplacement?.type?.name === 'paragraph'
        && firstOriginal?.type?.name !== 'paragraph') {
        const endings = result.match(/[\r\n]+$/)?.[0].match(/\r\n|\r|\n/g)?.length ?? 0;
        if (endings < 2) result += lineEnding.repeat(2 - endings);
      }
      if (oldCursor > 0 && oldCursor === originalBlocks.length) {
        const trailingLineEndings = result.match(/[\r\n]+$/)?.[0] ?? "";
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
        ? `${lastReplaced.source.match(/[\r\n]+$/)?.[0] ?? ""}${lastReplaced.separator}`
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
    terminalNewlines: source.match(/[\r\n]+$/)?.[0] ?? "",
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
