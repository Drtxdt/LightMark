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
  headingContentRevision: object;
  headingBefore(position: number): { heading: WysiwygDerivedHeading; index: number } | null;
  readonly indexVisits: number;
  readonly blockVisits: number;
  readonly materializedBlocks: number;
  readonly materializedHeadings: number;
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

type BlockValue = Readonly<{ node: ProseMirrorNode; stats: WysiwygBlockStats }>;
type IndexNode = Readonly<{
  value: BlockValue; left: IndexNode | null; right: IndexNode | null; priority: number;
  count: number; extent: number; words: number; chars: number; lines: number; headingCount: number;
}>;
type Diagnostics = { indexVisits: number; blockVisits: number; materializedBlocks: number; materializedHeadings: number };
const roots = new WeakMap<WysiwygDerivedState, IndexNode | null>();
let randomState = 0x6d2b79f5;
function nextPriority() { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; }
const count = (node: IndexNode | null) => node?.count ?? 0;
const extent = (node: IndexNode | null) => node?.extent ?? 0;
const headingCount = (node: IndexNode | null) => node?.headingCount ?? 0;
function indexNode(value: BlockValue, left: IndexNode | null = null, right: IndexNode | null = null, priority = nextPriority()): IndexNode {
  return { value, left, right, priority, count: count(left) + 1 + count(right), extent: extent(left) + value.node.nodeSize + extent(right),
    words: (left?.words ?? 0) + value.stats.words + (right?.words ?? 0),
    chars: (left?.chars ?? 0) + value.stats.chars + (right?.chars ?? 0),
    lines: (left?.lines ?? 0) + value.stats.lines + (right?.lines ?? 0),
    headingCount: headingCount(left) + Number(value.node.type.name === "heading") + headingCount(right) };
}
function merge(left: IndexNode | null, right: IndexNode | null, diagnostics: Diagnostics): IndexNode | null {
  diagnostics.indexVisits++;
  if (!left || !right) return left ?? right;
  return left.priority <= right.priority
    ? indexNode(left.value, left.left, merge(left.right, right, diagnostics), left.priority)
    : indexNode(right.value, merge(left, right.left, diagnostics), right.right, right.priority);
}
function split(root: IndexNode | null, at: number, diagnostics: Diagnostics): [IndexNode | null, IndexNode | null] {
  diagnostics.indexVisits++;
  if (!root) return [null, null];
  const leftCount = count(root.left);
  if (at <= leftCount) {
    const [left, middle] = split(root.left, at, diagnostics);
    return [left, indexNode(root.value, middle, root.right, root.priority)];
  }
  const [middle, right] = split(root.right, at - leftCount - 1, diagnostics);
  return [indexNode(root.value, root.left, middle, root.priority), right];
}
function blockIndexAt(root: IndexNode | null, position: number, diagnostics: Diagnostics): number {
  let index = 0;
  while (root) {
    diagnostics.indexVisits++;
    const leftExtent = extent(root.left);
    if (position < leftExtent) { root = root.left; continue; }
    if (position < leftExtent + root.value.node.nodeSize) return index + count(root.left);
    index += count(root.left) + 1;
    position -= leftExtent + root.value.node.nodeSize;
    root = root.right;
  }
  return Math.max(0, index - 1);
}
function visit(root: IndexNode | null, callback: (value: BlockValue, pos: number, index: number) => void, diagnostics: Diagnostics, onlyHeadings = false, pos = 0, index = 0) {
  if (!root || onlyHeadings && !root.headingCount) return;
  diagnostics.indexVisits++;
  visit(root.left, callback, diagnostics, onlyHeadings, pos, index);
  const nodePos = pos + extent(root.left), nodeIndex = index + count(root.left);
  if (!onlyHeadings || root.value.node.type.name === "heading") callback(root.value, nodePos, nodeIndex);
  visit(root.right, callback, diagnostics, onlyHeadings, nodePos + root.value.node.nodeSize, nodeIndex + 1);
}
function headingBefore(root: IndexNode | null, position: number, diagnostics: Diagnostics) {
  let pos = 0, blockIndex = 0, headingIndex = 0;
  let result: { heading: WysiwygDerivedHeading; index: number } | null = null;
  while (root && root.headingCount) {
    diagnostics.indexVisits++;
    const nodePos = pos + extent(root.left), nodeIndex = blockIndex + count(root.left);
    if (nodePos > position) { root = root.left; continue; }
    const preceding = headingIndex + headingCount(root.left);
    if (root.value.node.type.name === "heading") result = { heading: headingFromBlock({ ...root.value, pos: nodePos }, nodeIndex), index: preceding };
    else if (root.left?.headingCount) {
      let last = root.left, lastPos = pos, lastIndex = blockIndex;
      while (last) {
        diagnostics.indexVisits++;
        if (last.right?.headingCount) { lastPos += extent(last.left) + last.value.node.nodeSize; lastIndex += count(last.left) + 1; last = last.right; }
        else if (last.value.node.type.name === "heading") { result = { heading: headingFromBlock({ ...last.value, pos: lastPos + extent(last.left) }, lastIndex + count(last.left)), index: preceding - 1 }; break; }
        else if (last.left) last = last.left;
        else break;
      }
    }
    pos = nodePos + root.value.node.nodeSize;
    blockIndex = nodeIndex + 1;
    headingIndex = preceding + Number(root.value.node.type.name === "heading");
    root = root.right;
  }
  return result;
}
function initialDiagnostics(): Diagnostics { return { indexVisits: 0, blockVisits: 0, materializedBlocks: 0, materializedHeadings: 0 }; }
function stateFromRoot(root: IndexNode | null, diagnostics: Diagnostics, recomputedBlocks: number, outlineChanged: boolean, headingContentRevision: object): WysiwygDerivedState {
  let blocks: WysiwygDerivedBlock[] | undefined, headings: WysiwygDerivedHeading[] | undefined, outline: WysiwygDerivedState['outline'] | undefined;
  const state: WysiwygDerivedState = {
    get blocks() {
      if (!blocks) { blocks = []; visit(root, (value, pos) => { diagnostics.materializedBlocks++; blocks!.push({ ...value, pos }); }, diagnostics); }
      return blocks;
    },
    get headings() {
      if (!headings) { headings = []; visit(root, (value, pos, index) => { diagnostics.materializedHeadings++; headings!.push(headingFromBlock({ ...value, pos }, index)); }, diagnostics, true); }
      return headings;
    },
    get outline() { return outline ??= buildOutline(state.headings, state.lines); },
    words: root?.words ?? 0, chars: root?.chars ?? 0, lines: Math.max(1, root?.lines ?? 0),
    recomputedBlocks, outlineChanged, headingContentRevision,
    headingBefore: position => headingBefore(root, position, diagnostics),
    get indexVisits() { return diagnostics.indexVisits; },
    get blockVisits() { return diagnostics.blockVisits; },
    get materializedBlocks() { return diagnostics.materializedBlocks; },
    get materializedHeadings() { return diagnostics.materializedHeadings; },
  };
  roots.set(state, root);
  return state;
}
function buildInitialState(doc: ProseMirrorNode): WysiwygDerivedState {
  const diagnostics = initialDiagnostics();
  let root: IndexNode | null = null;
  doc.forEach(node => { diagnostics.blockVisits++; const { stats } = createBlock(node, 0); root = merge(root, indexNode({ node, stats }), diagnostics); });
  return stateFromRoot(root, diagnostics, doc.childCount, true, {});
}
function updateDerivedState(transaction: Transaction, previous: WysiwygDerivedState): WysiwygDerivedState {
  let root = roots.get(previous) ?? null;
  const diagnostics = initialDiagnostics();
  let recomputedBlocks = 0, outlineChanged = false, headingChanged = false;
  transaction.steps.forEach((step, stepIndex) => {
    const beforeDoc = transaction.docs[stepIndex];
    const nextDoc = transaction.docs[stepIndex + 1] ?? transaction.doc;
    let from = Infinity, to = -Infinity;
    step.getMap().forEach((oldFrom, oldTo) => { from = Math.min(from, oldFrom); to = Math.max(to, oldTo); });
    if (!Number.isFinite(from)) {
      const range = step as unknown as { from?: number; to?: number; pos?: number };
      from = range.from ?? range.pos ?? 0;
      to = range.to ?? range.pos ?? beforeDoc.content.size;
    }
    const start = blockIndexAt(root, Math.max(0, from - 1), diagnostics);
    const end = Math.min(beforeDoc.childCount, blockIndexAt(root, Math.min(Math.max(0, beforeDoc.content.size - 1), to + 1), diagnostics) + 1);
    const newCount = end - start + nextDoc.childCount - beforeDoc.childCount;
    const [left, rest] = split(root, start, diagnostics);
    const [removed, right] = split(rest, end - start, diagnostics);
    const oldHeadings: ProseMirrorNode[] = [];
    visit(removed, value => oldHeadings.push(value.node), diagnostics, true);
    const nextHeadings: ProseMirrorNode[] = [];
    let replacement: IndexNode | null = null;
    for (let index = start; index < start + newCount; index++) {
      diagnostics.blockVisits++;
      const node = nextDoc.child(index), { stats } = createBlock(node, 0);
      if (node.type.name === "heading") nextHeadings.push(node);
      replacement = merge(replacement, indexNode({ node, stats }), diagnostics);
      recomputedBlocks++;
    }
    headingChanged ||= oldHeadings.length !== nextHeadings.length || oldHeadings.some((node, index) => node !== nextHeadings[index]);
    outlineChanged ||= headingChanged || beforeDoc.childCount !== nextDoc.childCount;
    root = merge(merge(left, replacement, diagnostics), right, diagnostics);
    if (count(root) !== nextDoc.childCount || extent(root) !== nextDoc.content.size) throw new Error("派生索引与编辑器结构不一致，已阻止发布错误统计。");
  });
  return stateFromRoot(root, diagnostics, recomputedBlocks, outlineChanged, headingChanged ? {} : previous.headingContentRevision);
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

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
}
