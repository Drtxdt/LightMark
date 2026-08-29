import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { structureOutline, type StructuredOutlineItem } from "../utils/outline";

export interface WysiwygBlockStats {
  words: number;
  chars: number;
  lines: number;
}

export interface WysiwygDerivedBlock {
  node: ProseMirrorNode;
  pos: number;
  stats: WysiwygBlockStats;
}

export interface WysiwygDerivedHeading {
  node: ProseMirrorNode;
  pos: number;
  blockIndex: number;
  text: string;
  level: number;
}

export interface WysiwygDerivedState {
  blocks: WysiwygDerivedBlock[];
  headings: WysiwygDerivedHeading[];
  words: number;
  chars: number;
  lines: number;
  outline: Array<StructuredOutlineItem & { position: number }>;
  recomputedBlocks: number;
  outlineChanged: boolean;
}

export const wysiwygDerivedKey = new PluginKey<WysiwygDerivedState>("lightmarkWysiwygDerived");
const statsByNode = new WeakMap<ProseMirrorNode, WysiwygBlockStats>();

export function createWysiwygDerivedPlugin() {
  return new Plugin<WysiwygDerivedState>({
    key: wysiwygDerivedKey,
    state: {
      init: (_, state) => buildInitialState(state.doc),
      apply: (transaction, previous) => transaction.docChanged
        ? updateDerivedState(transaction, previous)
        : previous,
    },
  });
}

export function getWysiwygDerivedState(state: EditorState) {
  return wysiwygDerivedKey.getState(state) ?? buildInitialState(state.doc);
}

function buildInitialState(doc: ProseMirrorNode): WysiwygDerivedState {
  const blocks: WysiwygDerivedBlock[] = [];
  doc.forEach((node, pos) => blocks.push(createBlock(node, pos)));
  return summarizeInitial(blocks);
}

function updateDerivedState(transaction: Transaction, previous: WysiwygDerivedState) {
  const oldRanges: Array<[number, number]> = [];
  const newRanges: Array<[number, number]> = [];
  transaction.mapping.maps.forEach((stepMap, index) => {
    stepMap.forEach((oldFrom, oldTo, newFrom, newTo) => {
      const before = transaction.mapping.slice(0, index).invert();
      const after = transaction.mapping.slice(index + 1);
      oldRanges.push([before.map(oldFrom, -1), before.map(oldTo, 1)]);
      newRanges.push([after.map(newFrom, -1), after.map(newTo, 1)]);
    });
  });
  const oldAffected = collectTopLevelPositions(transaction.before, oldRanges);
  for (const position of oldAffected) {
    const mapped = transaction.mapping.map(position, 1);
    newRanges.push([mapped, mapped]);
  }
  const retained = previous.blocks
    .filter((block) => !oldAffected.has(block.pos))
    .map((block) => ({ ...block, pos: transaction.mapping.map(block.pos, 1) }));
  const newBlocks = collectTopLevelBlocks(transaction.doc, newRanges);
  const byPosition = new Map<number, WysiwygDerivedBlock>();
  for (const block of retained) byPosition.set(block.pos, block);
  for (const block of newBlocks) byPosition.set(block.pos, block);
  const blocks = [...byPosition.values()].sort((left, right) => left.pos - right.pos);
  const previousHeadingByNode = new Map(previous.headings.map((heading) => [heading.node, heading]));
  const headings: WysiwygDerivedHeading[] = [];
  blocks.forEach((block, blockIndex) => {
    if (!isHeadingBlock(block)) return;
    const cached = previousHeadingByNode.get(block.node);
    headings.push(cached
      ? { ...cached, pos: block.pos, blockIndex }
      : headingFromBlock(block, blockIndex));
  });

  const previousNodes = new Set(previous.blocks.map((block) => block.node));
  const nextNodes = new Set(blocks.map((block) => block.node));
  const removed = previous.blocks.filter((block) => !nextNodes.has(block.node));
  const added = blocks.filter((block) => !previousNodes.has(block.node));
  const words = Math.max(0, previous.words - sumStat(removed, "words") + sumStat(added, "words"));
  const chars = Math.max(0, previous.chars - sumStat(removed, "chars") + sumStat(added, "chars"));
  const lines = Math.max(1, previous.lines - sumStat(removed, "lines") + sumStat(added, "lines"));
  const headingStructureChanged = removed.some(isHeadingBlock)
    || added.some(isHeadingBlock)
    || blocks.length !== previous.blocks.length;
  const outline = headingStructureChanged
    ? buildOutline(headings, lines)
    : previous.outline.map((item, index) => ({
      ...item,
      position: headings[index]?.pos ?? item.position,
      line: headings[index]?.blockIndex ?? item.line,
    }));
  return { blocks, headings, words, chars, lines, outline, recomputedBlocks: newBlocks.length, outlineChanged: headingStructureChanged };
}

function collectTopLevelPositions(doc: ProseMirrorNode, ranges: Array<[number, number]>) {
  return new Set(collectTopLevelBlocks(doc, ranges).map((block) => block.pos));
}

function collectTopLevelBlocks(doc: ProseMirrorNode, ranges: Array<[number, number]>) {
  const positions = new Map<number, ProseMirrorNode>();
  for (const [rawFrom, rawTo] of ranges) {
    const from = Math.max(0, Math.min(doc.content.size, rawFrom));
    const to = Math.max(from, Math.min(doc.content.size, rawTo));
    addTopLevelAt(doc, from, positions);
    addTopLevelAt(doc, to, positions);
    doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos, parent) => {
      if (parent === doc) positions.set(pos, node);
      return parent === doc;
    });
  }
  return [...positions].map(([pos, node]) => createBlock(node, pos));
}

function addTopLevelAt(doc: ProseMirrorNode, rawPosition: number, output: Map<number, ProseMirrorNode>) {
  if (doc.childCount === 0) return;
  const position = Math.max(0, Math.min(doc.content.size, rawPosition));
  const resolved = doc.resolve(position);
  if (resolved.depth > 0) {
    const pos = resolved.before(1);
    output.set(pos, resolved.node(1));
    return;
  }
  const index = Math.min(doc.childCount - 1, resolved.index(0));
  let pos = 0;
  for (let cursor = 0; cursor < index; cursor += 1) pos += doc.child(cursor).nodeSize;
  output.set(pos, doc.child(index));
}

function createBlock(node: ProseMirrorNode, pos: number): WysiwygDerivedBlock {
  let stats = statsByNode.get(node);
  if (!stats) {
    const text = node.textContent;
    const trimmed = text.trim();
    stats = {
      words: trimmed ? trimmed.split(/\s+/).length : 0,
      chars: text.length,
      lines: Math.max(1, text.split(/\r?\n/).length),
    };
    statsByNode.set(node, stats);
  }
  return { node, pos, stats };
}

function summarizeInitial(blocks: WysiwygDerivedBlock[]): WysiwygDerivedState {
  let words = 0;
  let chars = 0;
  let lines = 0;
  const headings: WysiwygDerivedHeading[] = [];
  blocks.forEach((block, blockIndex) => {
    words += block.stats.words;
    chars += block.stats.chars;
    lines += block.stats.lines;
    if (block.node.type.name === "heading") {
      headings.push({
        node: block.node,
        pos: block.pos,
        blockIndex,
        text: block.node.textContent,
        level: Number(block.node.attrs.level) || 1,
      });
    }
  });
  const normalizedLines = Math.max(1, lines);
  return {
    blocks,
    headings,
    words,
    chars,
    lines: normalizedLines,
    outline: buildOutline(headings, normalizedLines),
    recomputedBlocks: blocks.length,
    outlineChanged: true,
  };
}

function headingFromBlock(block: WysiwygDerivedBlock, blockIndex: number): WysiwygDerivedHeading {
  return {
    node: block.node,
    pos: block.pos,
    blockIndex,
    text: block.node.textContent,
    level: Number(block.node.attrs.level) || 1,
  };
}

function buildOutline(headings: WysiwygDerivedHeading[], totalLines: number) {
  return structureOutline(headings.map((heading, index) => ({
    id: `heading-${index}-${slugify(heading.text)}`,
    text: heading.text,
    level: heading.level as 1 | 2 | 3 | 4 | 5 | 6,
    line: heading.blockIndex,
    position: heading.pos,
  })), totalLines) as Array<StructuredOutlineItem & { position: number }>;
}

function sumStat(blocks: WysiwygDerivedBlock[], key: keyof WysiwygBlockStats) {
  return blocks.reduce((sum, block) => sum + block.stats[key], 0);
}

function isHeadingBlock(block: WysiwygDerivedBlock) {
  return block.node.type.name === "heading";
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
}
