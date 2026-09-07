import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export type SourceLeafKind = "text";

export type SourceProvenanceFailureCode =
  | "unsupported-block"
  | "block-count-mismatch"
  | "block-type-mismatch"
  | "source-leaf-not-found"
  | "source-leaf-decode-mismatch"
  | "unsupported-inline"
  | "pm-leaf-count-mismatch"
  | "pm-leaf-text-mismatch"
  | "stale-baseline"
  | "structure-changed"
  | "marks-changed"
  | "deleted-source-span"
  | "syntax-sensitive-text"
  | "empty-slot-not-unique";

export type SourceProvenanceFailureDetails = {
  blockIndex?: number;
  leafIndex?: number;
  rawFrom?: number;
  rawTo?: number;
  pmFrom?: number;
  pmTo?: number;
  expected?: string;
  actual?: string;
  nodeType?: string;
};

export class SourceProvenanceMappingError extends Error {
  readonly code: SourceProvenanceFailureCode;
  readonly details: SourceProvenanceFailureDetails;

  constructor(code: SourceProvenanceFailureCode, message: string, details: SourceProvenanceFailureDetails = {}) {
    super(message);
    this.name = "SourceProvenanceMappingError";
    this.code = code;
    this.details = details;
  }
}

export type SourceProvenanceBlock = {
  index: number;
  from: number;
  to: number;
  kind: string;
};

export type SourceLeafSpan = {
  index: number;
  blockIndex: number;
  kind: SourceLeafKind;
  text: string;
  rawText: string;
  rawFrom: number;
  rawTo: number;
  pmFrom: number;
  pmTo: number;
  marks: readonly string[];
  emptySlot?: {
    /** Child indexes from the PM doc root to the owning empty paragraph. */
    pmPath: readonly number[];
    leadingPadding: string;
    trailingPadding: string;
  };
};

export type SourceLeafBaseline = {
  rawLength: number;
  bom: "" | "\uFEFF";
  /** PM nodes are immutable; identity binds a baseline to one EditorState document. */
  doc: ProseMirrorNode;
  /** The original JS string is immutable and keeps patch application versioned exactly. */
  rawSource: string;
  blocks: readonly SourceProvenanceBlock[];
  leaves: readonly SourceLeafSpan[];
  structure: string;
};

export type SourceLeafPatch = {
  leafIndex: number;
  blockIndex: number;
  rawFrom: number;
  rawTo: number;
  expected: string;
  insert: string;
  rawSource: string;
};

const parser = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false,
});

const supportedBlockKinds = new Set([
  "paragraph_open",
  "heading_open",
  "bullet_list_open",
  "ordered_list_open",
  "table_open",
]);

const supportedLeafKinds = new Set(["text"]);

export function mapSourceTextLeaves(markdown: string, doc: ProseMirrorNode): SourceLeafBaseline {
  const bom = markdown.startsWith("\uFEFF") ? "\uFEFF" : "";
  const parseSource = bom ? markdown.slice(1) : markdown;
  const lineStarts = sourceLineStarts(parseSource);
  const tokens = parser.parse(parseSource, {});
  const tokenBlocks = topLevelTokenBlocks(tokens, lineStarts, parseSource.length);
  const pmBlocks = topLevelNodes(doc);

  if (tokenBlocks.length !== pmBlocks.length) {
    throw new SourceProvenanceMappingError(
      "block-count-mismatch",
      `Markdown block count ${tokenBlocks.length} does not match ProseMirror block count ${pmBlocks.length}.`,
      { expected: String(tokenBlocks.length), actual: String(pmBlocks.length) },
    );
  }

  tokenBlocks.forEach((block, index) => {
    if (!supportedBlockKinds.has(block.token.type)) {
      throw new SourceProvenanceMappingError(
        "unsupported-block",
        `Block ${index} uses unsupported Markdown token ${block.token.type}.`,
        { blockIndex: index, nodeType: pmBlocks[index].type.name },
      );
    }
    if (!blockTypeMatches(block.token.type, pmBlocks[index].type.name)) {
      throw new SourceProvenanceMappingError(
        "block-type-mismatch",
        `Markdown block ${block.token.type} does not match ProseMirror node ${pmBlocks[index].type.name}.`,
        { blockIndex: index, nodeType: pmBlocks[index].type.name },
      );
    }
  });

  const rawLeaves = tokenBlocks.flatMap((block, blockIndex) =>
    inlineTokenLeaves(tokens, block, parseSource, lineStarts, bom.length, blockIndex),
  );
  const pmLeaves = collectPmLeaves(doc);
  if (rawLeaves.length !== pmLeaves.length) {
    throw new SourceProvenanceMappingError(
      "pm-leaf-count-mismatch",
      `Markdown leaf count ${rawLeaves.length} does not match ProseMirror leaf count ${pmLeaves.length}.`,
      { expected: String(rawLeaves.length), actual: String(pmLeaves.length) },
    );
  }

  const leaves = rawLeaves.map((rawLeaf, index) => {
    const pmLeaf = pmLeaves[index];
    const rawIsEmptySlot = Boolean(rawLeaf.emptyPadding);
    const pmIsEmptySlot = Boolean(pmLeaf.emptySlot);
    if (rawIsEmptySlot !== pmIsEmptySlot) {
      throw new SourceProvenanceMappingError(
        "empty-slot-not-unique",
        `Markdown and ProseMirror empty text slots do not align at leaf ${index}.`,
        {
          leafIndex: index,
          rawFrom: rawLeaf.rawFrom,
          rawTo: rawLeaf.rawTo,
          pmFrom: pmLeaf.pmFrom,
          pmTo: pmLeaf.pmTo,
          expected: rawIsEmptySlot ? "empty-slot" : "text-leaf",
          actual: pmIsEmptySlot ? "empty-slot" : "text-leaf",
        },
      );
    }
    if (rawLeaf.text !== pmLeaf.text) {
      throw new SourceProvenanceMappingError(
        "pm-leaf-text-mismatch",
        `Markdown leaf ${index} does not match the ProseMirror text leaf.`,
        {
          leafIndex: index,
          rawFrom: rawLeaf.rawFrom,
          rawTo: rawLeaf.rawTo,
          pmFrom: pmLeaf.pmFrom,
          pmTo: pmLeaf.pmTo,
          expected: rawLeaf.text,
          actual: pmLeaf.text,
        },
      );
    }
    return {
      ...rawLeaf,
      index,
      pmFrom: pmLeaf.pmFrom,
      pmTo: pmLeaf.pmTo,
      marks: pmLeaf.marks,
      ...(rawLeaf.emptyPadding && pmLeaf.emptySlot
        ? { emptySlot: { ...rawLeaf.emptyPadding, pmPath: pmLeaf.emptySlot.pmPath } }
        : {}),
    };
  });

  return {
    rawLength: markdown.length,
    bom,
    doc,
    rawSource: markdown,
    blocks: tokenBlocks.map((block, index) => ({
      index,
      from: block.from + bom.length,
      to: block.to + bom.length,
      kind: block.token.type,
    })),
    leaves,
    structure: documentStructure(doc),
  };
}

export function mapSourceLeafTransaction(
  baseline: SourceLeafBaseline,
  oldDoc: ProseMirrorNode,
  transaction: Transaction,
): SourceLeafPatch[] {
  const oldStructure = documentStructure(oldDoc);
  if (oldDoc !== baseline.doc || transaction.before !== baseline.doc || oldStructure !== baseline.structure) {
    throw new SourceProvenanceMappingError(
      "stale-baseline",
      "The transaction does not start from the captured immutable ProseMirror document.",
      { expected: baseline.structure, actual: oldStructure },
    );
  }
  if (!transaction.docChanged) return [];
  const transactionStructure = documentStructure(transaction.doc);
  if (transactionStructure !== baseline.structure) {
    throw new SourceProvenanceMappingError(
      "structure-changed",
      "The transaction changed the block or node structure.",
      { expected: baseline.structure, actual: transactionStructure },
    );
  }
  assertTransactionChangesCovered(baseline, transaction);

  const patches: SourceLeafPatch[] = [];
  baseline.leaves.forEach((leaf, leafIndex) => {
    const fromResult = transaction.mapping.mapResult(leaf.pmFrom, -1);
    const toResult = transaction.mapping.mapResult(leaf.pmTo, 1);
    if (fromResult.deletedAcross || toResult.deletedAcross) {
      throw new SourceProvenanceMappingError(
        "deleted-source-span",
        `Transaction deleted the mapped PM span for leaf ${leafIndex}.`,
        { leafIndex, pmFrom: leaf.pmFrom, pmTo: leaf.pmTo },
      );
    }
    const pmFrom = fromResult.pos;
    const pmTo = Math.max(pmFrom, toResult.pos);
    const text = transaction.doc.textBetween(pmFrom, pmTo, "\n", "\uFFFC");
    if (text.includes("\n") || text.includes("\uFFFC")) {
      throw new SourceProvenanceMappingError(
        "structure-changed",
        `Transaction range for leaf ${leafIndex} crosses a block boundary.`,
        { leafIndex, pmFrom, pmTo },
      );
    }
    const marks = collectMarks(transaction.doc, pmFrom, pmTo);
    if (text.length > 0 && !sameMarks(leaf.marks, marks)) {
      throw new SourceProvenanceMappingError(
        "marks-changed",
        `Transaction changed marks for leaf ${leafIndex}; a text-only patch is unsafe.`,
        { leafIndex, pmFrom, pmTo, expected: leaf.marks.join("|"), actual: marks.join("|") },
      );
    }
    if (text === leaf.text) return;
    if (leaf.emptySlot) {
      assertPlainLeafReplacement(text, baseline.blocks[leaf.blockIndex].kind, leafIndex, leaf.text);
      patches.push({
        leafIndex,
        blockIndex: leaf.blockIndex,
        rawFrom: leaf.rawFrom,
        rawTo: leaf.rawTo,
        expected: leaf.rawText,
        insert: `${leaf.emptySlot.leadingPadding}${text}${leaf.emptySlot.trailingPadding}`,
        rawSource: baseline.rawSource,
      });
      return;
    }
    if (leaf.rawText !== leaf.text) {
      throw new SourceProvenanceMappingError(
        "syntax-sensitive-text",
        `Leaf ${leafIndex} requires Markdown escaping or syntax-aware encoding.`,
        { leafIndex, expected: leaf.text, actual: text, rawFrom: leaf.rawFrom, rawTo: leaf.rawTo },
      );
    }
    assertPlainLeafReplacement(text, baseline.blocks[leaf.blockIndex].kind, leafIndex, leaf.text);
    patches.push({
      leafIndex,
      blockIndex: leaf.blockIndex,
      rawFrom: leaf.rawFrom,
      rawTo: leaf.rawTo,
      expected: leaf.rawText,
      insert: text,
      rawSource: baseline.rawSource,
    });
  });

  for (let index = 1; index < patches.length; index += 1) {
    if (patches[index - 1].rawTo > patches[index].rawFrom) {
      throw new SourceProvenanceMappingError("structure-changed", "Mapped raw leaf patches overlap.");
    }
  }
  return patches;
}

function assertTransactionChangesCovered(baseline: SourceLeafBaseline, transaction: Transaction) {
  for (let stepIndex = 0; stepIndex < transaction.steps.length; stepIndex += 1) {
    const step = transaction.steps[stepIndex];
    step.getMap().forEach((oldFrom, oldTo) => {
      const pmFrom = mapStepPositionToBaseline(transaction, stepIndex, oldFrom, -1);
      const pmTo = mapStepPositionToBaseline(transaction, stepIndex, oldTo, 1);
      const covered = baseline.leaves.some((leaf) => oldFrom === oldTo
        ? leaf.pmFrom <= pmFrom && pmFrom <= leaf.pmTo
        : leaf.pmFrom <= pmFrom && pmTo <= leaf.pmTo);
      if (!covered) {
        throw new SourceProvenanceMappingError(
          "unsupported-inline",
          "A document-changing step is outside every captured text leaf.",
          { pmFrom, pmTo },
        );
      }
    });
  }
}

function mapStepPositionToBaseline(transaction: Transaction, stepIndex: number, position: number, assoc: -1 | 1) {
  let mapped = position;
  for (let index = stepIndex - 1; index >= 0; index -= 1) {
    mapped = transaction.mapping.maps[index].invert().mapResult(mapped, assoc).pos;
  }
  return mapped;
}

export function applySourceLeafPatches(markdown: string, patches: readonly SourceLeafPatch[]) {
  const ordered = [...patches].sort((left, right) => left.rawFrom - right.rawFrom || left.rawTo - right.rawTo);
  if (ordered.length > 0) {
    const expectedSource = ordered[0].rawSource;
    if (ordered.some((patch) => patch.rawSource !== expectedSource) || markdown !== expectedSource) {
      throw new SourceProvenanceMappingError("stale-baseline", "Raw source does not match the captured source version.", {
        expected: expectedSource,
        actual: markdown,
      });
    }
  }
  let cursor = 0;
  let result = "";
  for (const patch of ordered) {
    if (patch.rawFrom < cursor || markdown.slice(patch.rawFrom, patch.rawTo) !== patch.expected) {
      throw new SourceProvenanceMappingError("stale-baseline", "Raw source no longer matches the captured leaf span.", {
        rawFrom: patch.rawFrom,
        rawTo: patch.rawTo,
        expected: patch.expected,
        actual: markdown.slice(patch.rawFrom, patch.rawTo),
      });
    }
    result += markdown.slice(cursor, patch.rawFrom) + patch.insert;
    cursor = patch.rawTo;
  }
  return result + markdown.slice(cursor);
}

function topLevelTokenBlocks(tokens: Token[], lineStarts: number[], sourceLength: number) {
  const entries = tokens
    .map((token, tokenIndex) => ({ token, tokenIndex }))
    .filter(({ token }) => token.level === 0 && token.nesting === 1 && token.map);
  return entries.map(({ token, tokenIndex }, index) => {
    const fromLine = token.map![0];
    const toLine = token.map![1];
    return {
      token,
      tokenIndex,
      nextTokenIndex: entries[index + 1]?.tokenIndex ?? tokens.length,
      from: lineStarts[fromLine] ?? sourceLength,
      to: lineStarts[toLine] ?? sourceLength,
    };
  });
}

function inlineTokenLeaves(
  tokens: Token[],
  block: ReturnType<typeof topLevelTokenBlocks>[number],
  source: string,
  lineStarts: number[],
  rawOffset: number,
  blockIndex: number,
) {
  const inlineRegions = inlineTokenRegions(tokens, block, source, lineStarts);
  const leaves: Array<RawSourceLeaf> = [];
  for (const [tokenIndex, region] of inlineRegions) {
    const token = tokens[tokenIndex];
    if (!token.children || token.map && token.map[1] !== token.map[0] + 1) {
      throw new SourceProvenanceMappingError(
        "unsupported-inline",
        `Inline token ${tokenIndex} spans multiple lines or has no concrete text leaf.`,
        { blockIndex, rawFrom: region.from + rawOffset, rawTo: region.to + rawOffset },
      );
    }
    const children = token.children;
    const regionSource = source.slice(region.from, region.to);
    if (children.length === 0) {
      if (token.content !== "" || !region.emptySlot) {
        throw new SourceProvenanceMappingError(
          "empty-slot-not-unique",
          `Inline token ${tokenIndex} has no text leaf and no unique raw empty slot.`,
          { blockIndex, rawFrom: region.from + rawOffset, rawTo: region.to + rawOffset },
        );
      }
      const slotFrom = region.emptySlot.from;
      const slotTo = region.emptySlot.to;
      const slotText = source.slice(slotFrom, slotTo);
      if (slotText !== `${region.emptySlot.leadingPadding}${region.emptySlot.trailingPadding}`) {
        throw new SourceProvenanceMappingError(
          "empty-slot-not-unique",
          `Inline token ${tokenIndex} empty slot padding does not match the parsed source.`,
          { blockIndex, rawFrom: slotFrom + rawOffset, rawTo: slotTo + rawOffset },
        );
      }
      leaves.push({
        index: leaves.length,
        blockIndex,
        kind: "text",
        text: "",
        rawText: slotText,
        rawFrom: slotFrom + rawOffset,
        rawTo: slotTo + rawOffset,
        emptyPadding: {
          leadingPadding: region.emptySlot.leadingPadding,
          trailingPadding: region.emptySlot.trailingPadding,
        },
      });
      continue;
    }
    if (children.length !== 1 || !supportedLeafKinds.has(children[0].type) || children[0].content.length === 0) {
      throw new SourceProvenanceMappingError(
        "unsupported-inline",
        `Inline token ${tokenIndex} contains Markdown syntax or multiple text leaves.`,
        { blockIndex, rawFrom: region.from + rawOffset, rawTo: region.to + rawOffset },
      );
    }
    const child = children[0];
    if (regionSource !== token.content || child.content !== token.content) {
      throw new SourceProvenanceMappingError(
        "unsupported-inline",
        `Inline token ${tokenIndex} is encoded or has syntax outside one raw text leaf.`,
        {
          blockIndex,
          rawFrom: region.from + rawOffset,
          rawTo: region.to + rawOffset,
          expected: token.content,
          actual: regionSource,
        },
      );
    }
    leaves.push({
      index: leaves.length,
      blockIndex,
      kind: "text",
      text: child.content,
      rawText: regionSource,
      rawFrom: region.from + rawOffset,
      rawTo: region.to + rawOffset,
    });
  }
  return leaves;
}

type RawRange = {
  from: number;
  to: number;
  emptySlot?: {
    from: number;
    to: number;
    leadingPadding: string;
    trailingPadding: string;
  };
};

type RawSourceLeaf = Pick<SourceLeafSpan, "index" | "blockIndex" | "kind" | "text" | "rawText" | "rawFrom" | "rawTo"> & {
  emptyPadding?: {
    leadingPadding: string;
    trailingPadding: string;
  };
};

function inlineTokenRegions(
  tokens: Token[],
  block: ReturnType<typeof topLevelTokenBlocks>[number],
  source: string,
  lineStarts: number[],
) {
  if (block.token.type === "table_open") return tableInlineTokenRegions(tokens, block, source, lineStarts);
  const regions = new Map<number, RawRange>();
  for (let tokenIndex = block.tokenIndex; tokenIndex < block.nextTokenIndex; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token.type !== "inline") continue;
    const fromLine = token.map?.[0] ?? block.token.map?.[0] ?? 0;
    const toLine = token.map?.[1] ?? Math.min(fromLine + 1, lineStarts.length - 1);
    const lineStart = lineStarts[fromLine] ?? source.length;
    const lineEnd = lineContentEnd(source, lineStarts, fromLine);
    const regionStart = lineStart + inlinePrefixLength(block.token.type, source.slice(lineStart, lineEnd));
    const regionEnd = lineContentEnd(source, lineStarts, fromLine);
    regions.set(tokenIndex, { from: Math.min(regionStart, regionEnd), to: regionEnd });
  }
  return regions;
}

function inlinePrefixLength(blockType: string, line: string) {
  if (blockType === "heading_open") return line.match(/^ {0,3}#{1,6}(?:[ \t]+|$)/)?.[0].length ?? 0;
  if (blockType === "bullet_list_open") return line.match(/^\s*[*+-][ \t]+/)?.[0].length ?? 0;
  if (blockType === "ordered_list_open") return line.match(/^\s*\d{1,9}[.)][ \t]+/)?.[0].length ?? 0;
  return 0;
}

function tableInlineTokenRegions(
  tokens: Token[],
  block: ReturnType<typeof topLevelTokenBlocks>[number],
  source: string,
  lineStarts: number[],
) {
  const regions = new Map<number, RawRange>();
  let rowLine: number | null = null;
  let cellIndex = 0;
  for (let tokenIndex = block.tokenIndex + 1; tokenIndex < block.nextTokenIndex; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token.type === "tr_open") {
      rowLine = token.map?.[0] ?? null;
      cellIndex = 0;
      continue;
    }
    if (token.type === "tr_close") {
      rowLine = null;
      continue;
    }
    if (token.type !== "inline" || rowLine === null) continue;
    const cells = splitTableRow(source, lineStarts, rowLine);
    const region = cells[cellIndex];
    if (region) regions.set(tokenIndex, region);
    cellIndex += 1;
  }
  return regions;
}

function splitTableRow(source: string, lineStarts: number[], line: number): RawRange[] {
  const start = lineStarts[line] ?? source.length;
  const end = lineContentEnd(source, lineStarts, line);
  const row = source.slice(start, end);
  const pipes: number[] = [];
  let codeFence = 0;
  let escaped = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (row[index + run] === "`") run += 1;
      codeFence = codeFence === 0 ? run : (codeFence === run ? 0 : codeFence);
      index += run - 1;
      continue;
    }
    if (character === "|" && codeFence === 0) pipes.push(index);
  }
  const boundaries = [0, ...pipes, row.length];
  let first = 0;
  let last = boundaries.length - 1;
  if (pipes.length > 0 && /^\s*$/.test(row.slice(0, pipes[0]))) first = 1;
  if (pipes.length > 0 && /^\s*$/.test(row.slice(pipes[pipes.length - 1] + 1))) last -= 1;
  const cells: RawRange[] = [];
  for (let index = first; index < last; index += 1) {
    const cellStart = boundaries[index] + (index > 0 ? 1 : 0);
    const cellEnd = boundaries[index + 1];
    const value = row.slice(cellStart, cellEnd);
    if (/^[ \t]*$/.test(value)) {
      const leadingLength = Math.floor(value.length / 2);
      cells.push({
        from: start + cellStart + leadingLength,
        to: start + cellStart + leadingLength,
        emptySlot: {
          from: start + cellStart,
          to: start + cellEnd,
          leadingPadding: value.slice(0, leadingLength),
          trailingPadding: value.slice(leadingLength),
        },
      });
      continue;
    }
    const leading = value.match(/^[ \t]*/)?.[0].length ?? 0;
    const trailing = value.match(/[ \t]*$/)?.[0].length ?? 0;
    cells.push({
      from: start + cellStart + leading,
      to: Math.max(start + cellStart + leading, start + cellEnd - trailing),
    });
  }
  return cells;
}

function lineContentEnd(source: string, lineStarts: number[], line: number) {
  const next = lineStarts[line + 1] ?? source.length;
  if (source.startsWith("\r\n", next - 2)) return Math.max(lineStarts[line], next - 2);
  if (source[next - 1] === "\r" || source[next - 1] === "\n") return Math.max(lineStarts[line], next - 1);
  return next;
}

function assertPlainLeafReplacement(value: string, blockKind: string, leafIndex: number, expected: string) {
  if (value.length === 0) return;
  const details = { leafIndex, expected, actual: value };
  if (blockKind === "table_open" && value.includes("|")) {
    throw new SourceProvenanceMappingError(
      "syntax-sensitive-text",
      `Leaf ${leafIndex} would change a table cell boundary.`,
      details,
    );
  }
  // These markers are handled by LightMark extensions which are deliberately
  // outside this parser-backed plain-text slice.
  if (/[$~^]|==/.test(value)) {
    throw new SourceProvenanceMappingError(
      "syntax-sensitive-text",
      `Leaf ${leafIndex} contains syntax outside the plain-text mapping slice.`,
      details,
    );
  }
  const tokens = parser.parse(value, {});
  const blocks = tokens.filter((token) => token.level === 0 && token.nesting === 1 && token.map);
  const inline = tokens.find((token) => token.type === "inline");
  const child = inline?.children;
  if (blocks.length !== 1
    || blocks[0].type !== "paragraph_open"
    || !inline
    || inline.content !== value
    || !child
    || child.length !== 1
    || child[0].type !== "text"
    || child[0].content !== value) {
    throw new SourceProvenanceMappingError(
      "syntax-sensitive-text",
      `Leaf ${leafIndex} would change Markdown token structure or decoding.`,
      details,
    );
  }
}

function sourceLineStarts(source: string) {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) starts.push((match.index ?? 0) + match[0].length);
  return starts;
}

function blockTypeMatches(tokenType: string, nodeType: string) {
  return tokenType === "paragraph_open" && nodeType === "paragraph"
    || tokenType === "heading_open" && nodeType === "heading"
    || tokenType === "bullet_list_open" && nodeType === "bulletList"
    || tokenType === "ordered_list_open" && nodeType === "orderedList"
    || tokenType === "table_open" && nodeType === "table";
}

function topLevelNodes(doc: ProseMirrorNode) {
  const nodes: ProseMirrorNode[] = [];
  doc.forEach((node) => nodes.push(node));
  return nodes;
}

function collectPmLeaves(doc: ProseMirrorNode) {
  const leaves: PmLeaf[] = [];
  doc.forEach((node, offset, index) => collectNodeLeaves(node, offset, leaves, [index], []));
  return leaves;
}

type PmLeaf = {
  text: string;
  pmFrom: number;
  pmTo: number;
  marks: readonly string[];
  emptySlot?: { pmPath: readonly number[] };
};

function collectNodeLeaves(
  node: ProseMirrorNode,
  position: number,
  leaves: PmLeaf[],
  path: readonly number[],
  ancestors: readonly string[],
) {
  if (node.isText) {
    leaves.push({
      text: node.text || "",
      pmFrom: position,
      pmTo: position + node.nodeSize,
      marks: node.marks.map(markFingerprint),
    });
    return;
  }
  if (node.type.name === "paragraph" && node.content.size === 0 && ancestors.some((ancestor) => ancestor === "tableCell" || ancestor === "tableHeader")) {
    leaves.push({
      text: "",
      pmFrom: position + 1,
      pmTo: position + 1,
      marks: [],
      emptySlot: { pmPath: path },
    });
  }
  node.forEach((child, offset, index) => collectNodeLeaves(
    child,
    position + 1 + offset,
    leaves,
    [...path, index],
    [...ancestors, node.type.name],
  ));
}

function collectMarks(doc: ProseMirrorNode, from: number, to: number) {
  const marks: string[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      const fingerprint = markFingerprint(mark);
      if (!marks.includes(fingerprint)) marks.push(fingerprint);
    }
  });
  return marks.sort();
}

function sameMarks(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((mark, index) => mark === right[index]);
}

function markFingerprint(mark: { type: { name: string }; attrs: Record<string, unknown> | null }) {
  return `${mark.type.name}:${JSON.stringify(mark.attrs || {})}`;
}

function documentStructure(node: ProseMirrorNode): string {
  const children: string[] = [];
  node.forEach((child) => {
    if (!child.isText) children.push(documentStructure(child));
  });
  return `${node.type.name}[${JSON.stringify(node.attrs || {})}](${children.join(",")})`;
}
