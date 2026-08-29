import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findTextMatches, normalizeMatchIndex, type FindReplaceOptions, type TextMatch } from "../utils/findReplace";

export type WysiwygFindMatch = TextMatch & { docFrom: number; docTo: number };

export interface WysiwygFindQuery extends FindReplaceOptions {
  search: string;
}

export interface WysiwygFindState {
  query: WysiwygFindQuery | null;
  blocks: WysiwygFindBlock[];
  items: WysiwygFindMatch[];
  error: string;
}

interface WysiwygFindBlock {
  node: ProseMirrorNode;
  pos: number;
  items: WysiwygFindMatch[];
  error: string;
}

type FindMeta = { kind: "query"; query: WysiwygFindQuery | null } | { kind: "refresh" };

export const wysiwygFindKey = new PluginKey<WysiwygFindState>("lightmarkIncrementalFind");

export function createWysiwygFindPlugin(options: {
  currentIndex(): number;
  active(): boolean;
}) {
  return new Plugin<WysiwygFindState>({
    key: wysiwygFindKey,
    state: {
      init: () => emptyState(),
      apply(transaction, previous) {
        const meta = transaction.getMeta(wysiwygFindKey) as FindMeta | undefined;
        if (meta?.kind === "query") {
          if (!meta.query?.search) return emptyState();
          if (!sameQuery(previous.query, meta.query)) return scanDocument(transaction.doc, meta.query);
        }
        if (!transaction.docChanged || !previous.query) return previous;
        return updateFindState(transaction, previous);
      },
    },
    props: {
      decorations(state) {
        if (!options.active()) return null;
        const current = wysiwygFindKey.getState(state);
        if (!current || current.error || current.items.length === 0) return null;
        const selected = normalizeMatchIndex(options.currentIndex(), current.items.length);
        return DecorationSet.create(state.doc, current.items.map((match, index) =>
          Decoration.inline(match.docFrom, match.docTo, {
            class: index === selected ? "lm-find-match lm-find-match-current" : "lm-find-match",
          }),
        ));
      },
    },
  });
}

export function setWysiwygFindQuery(state: EditorState, query: WysiwygFindQuery | null) {
  return state.tr.setMeta(wysiwygFindKey, { kind: "query", query } satisfies FindMeta);
}

export function refreshWysiwygFindDecorations(state: EditorState) {
  return state.tr.setMeta(wysiwygFindKey, { kind: "refresh" } satisfies FindMeta);
}

export function getWysiwygFindState(state: EditorState): WysiwygFindState {
  return wysiwygFindKey.getState(state) ?? emptyState();
}

function emptyState(): WysiwygFindState {
  return { query: null, blocks: [], items: [], error: "" };
}

function sameQuery(left: WysiwygFindQuery | null, right: WysiwygFindQuery) {
  return Boolean(left)
    && left!.search === right.search
    && left!.caseSensitive === right.caseSensitive
    && left!.wholeWord === right.wholeWord
    && left!.regex === right.regex;
}

function scanDocument(doc: ProseMirrorNode, query: WysiwygFindQuery): WysiwygFindState {
  const blocks: WysiwygFindBlock[] = [];
  doc.forEach((node, pos) => blocks.push(scanBlock(node, pos, query)));
  return combine(query, blocks);
}

function updateFindState(transaction: Transaction, previous: WysiwygFindState): WysiwygFindState {
  const query = previous.query!;
  const { oldRanges, newRanges } = changedRanges(transaction);
  const oldAffected = topLevelPositions(transaction.before, oldRanges);
  for (const position of oldAffected) newRanges.push([transaction.mapping.map(position, 1), transaction.mapping.map(position, -1)]);

  const retained = previous.blocks
    .filter((block) => !oldAffected.has(block.pos))
    .map((block) => ({
      ...block,
      pos: transaction.mapping.map(block.pos, 1),
      items: block.items.flatMap((match) => {
        const from = transaction.mapping.mapResult(match.docFrom, 1);
        const to = transaction.mapping.mapResult(match.docTo, -1);
        return from.deletedAcross || to.deletedAcross || from.pos >= to.pos
          ? []
          : [{ ...match, docFrom: from.pos, docTo: to.pos }];
      }),
    }));
  const rescanned = topLevelNodes(transaction.doc, newRanges).map(({ node, pos }) => scanBlock(node, pos, query));
  const byPosition = new Map<number, WysiwygFindBlock>();
  for (const block of retained) byPosition.set(block.pos, block);
  for (const block of rescanned) byPosition.set(block.pos, block);
  // Step mappings can land exactly on a top-level boundary. Reconcile node
  // identity without reading block text so boundary insertions cannot retain a
  // cache entry for the adjacent block.
  const blocks: WysiwygFindBlock[] = [];
  transaction.doc.forEach((node, pos) => {
    const cached = byPosition.get(pos);
    blocks.push(cached?.node === node ? cached : scanBlock(node, pos, query));
  });
  return combine(query, blocks);
}

function combine(query: WysiwygFindQuery, blocks: WysiwygFindBlock[]): WysiwygFindState {
  const error = blocks.find((block) => block.error)?.error ?? "";
  return { query, blocks, error, items: error ? [] : blocks.flatMap((block) => block.items) };
}

function scanBlock(node: ProseMirrorNode, pos: number, query: WysiwygFindQuery): WysiwygFindBlock {
  const items: WysiwygFindMatch[] = [];
  let error = "";
  const visit = (textblock: ProseMirrorNode, textblockPos: number) => {
    const flattened = flattenTextblock(textblock, textblockPos);
    if (!flattened.text) return;
    const result = findTextMatches(flattened.text, query.search, query);
    if (result.error) {
      error = result.error;
      return;
    }
    for (const match of result.matches) {
      const docFrom = textOffsetToDocPos(flattened.segments, match.from);
      const docTo = textOffsetToDocPos(flattened.segments, match.to);
      if (docFrom !== null && docTo !== null && docFrom < docTo) items.push({ ...match, docFrom, docTo });
    }
  };
  if (node.isTextblock) visit(node, pos);
  else node.descendants((child, childPos) => {
    if (!child.isTextblock) return true;
    visit(child, pos + 1 + childPos);
    return false;
  });
  return { node, pos, items, error };
}

function flattenTextblock(node: ProseMirrorNode, pos: number) {
  const segments: Array<{ from: number; text: string; start: number; end: number }> = [];
  let text = "";
  node.descendants((child, childPos) => {
    if (!child.isText || !child.text) return true;
    const start = text.length;
    text += child.text;
    segments.push({ from: pos + 1 + childPos, text: child.text, start, end: text.length });
    return false;
  });
  return { text, segments };
}

function textOffsetToDocPos(segments: Array<{ from: number; text: string; start: number; end: number }>, offset: number) {
  for (const segment of segments) {
    if (offset >= segment.start && offset <= segment.end) return segment.from + offset - segment.start;
  }
  const last = segments.at(-1);
  return last && offset === last.end ? last.from + last.text.length : null;
}

function changedRanges(transaction: Transaction) {
  const oldRanges: Array<[number, number]> = [];
  const newRanges: Array<[number, number]> = [];
  transaction.mapping.maps.forEach((stepMap, index) => {
    stepMap.forEach((oldFrom, oldTo, newFrom, newTo) => {
      oldRanges.push([
        transaction.mapping.slice(0, index).invert().map(oldFrom, -1),
        transaction.mapping.slice(0, index).invert().map(oldTo, 1),
      ]);
      newRanges.push([
        transaction.mapping.slice(index + 1).map(newFrom, -1),
        transaction.mapping.slice(index + 1).map(newTo, 1),
      ]);
    });
  });
  return { oldRanges, newRanges };
}

function topLevelPositions(doc: ProseMirrorNode, ranges: Array<[number, number]>) {
  return new Set(topLevelNodes(doc, ranges).map((item) => item.pos));
}

function topLevelNodes(doc: ProseMirrorNode, ranges: Array<[number, number]>) {
  const output = new Map<number, ProseMirrorNode>();
  for (const [rawFrom, rawTo] of ranges) {
    const from = Math.max(0, Math.min(doc.content.size, rawFrom));
    const to = Math.max(from, Math.min(doc.content.size, rawTo));
    addTopLevelAt(doc, from, output);
    addTopLevelAt(doc, to, output);
    doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos, parent) => {
      if (parent === doc) output.set(pos, node);
      return parent === doc;
    });
  }
  return [...output].map(([pos, node]) => ({ pos, node }));
}

function addTopLevelAt(doc: ProseMirrorNode, rawPosition: number, output: Map<number, ProseMirrorNode>) {
  if (doc.childCount === 0) return;
  const resolved = doc.resolve(Math.max(0, Math.min(doc.content.size, rawPosition)));
  if (resolved.depth > 0) {
    output.set(resolved.before(1), resolved.node(1));
    return;
  }
  const index = Math.min(doc.childCount - 1, resolved.index(0));
  let pos = 0;
  for (let cursor = 0; cursor < index; cursor += 1) pos += doc.child(cursor).nodeSize;
  output.set(pos, doc.child(index));
}
