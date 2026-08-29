import type { Text } from "@codemirror/state";
import {
  createOutlineScanState,
  scanOutlineLine,
  slugify,
  structureOutline,
  type OutlineItemWithLine,
  type OutlineScanState,
  type StructuredOutlineItem,
} from "../utils/outline";

const CHECKPOINT_LINES = 256;

interface Checkpoint {
  line: number;
  state: OutlineScanState;
}

export interface SourceOutlineIndex {
  items: StructuredOutlineItem[];
  itemsByLine: Map<number, StructuredOutlineItem>;
  rawItems: OutlineItemWithLine[];
  checkpoints: Checkpoint[];
  lineCount: number;
  outlineChanged: boolean;
}

export interface SourceContext {
  fence: boolean;
  frontMatter: boolean;
  mathBlock: boolean;
  htmlBlock: boolean;
}

export function buildSourceOutlineIndex(doc: Text): SourceOutlineIndex {
  return scanDocument(doc, 1, createOutlineScanState(doc.line(1).text), [], []);
}

export function updateSourceOutlineIndex(
  previous: SourceOutlineIndex,
  oldDoc: Text,
  newDoc: Text,
  changedOldFrom: number,
  changedNewFrom: number,
  changedNewTo: number,
): SourceOutlineIndex {
  const oldStartLine = oldDoc.lineAt(changedOldFrom).number;
  const newStartLine = newDoc.lineAt(changedNewFrom).number;
  const newEndLine = newDoc.lineAt(changedNewTo).number;
  const startLine = Math.max(1, Math.floor((Math.min(oldStartLine, newStartLine) - 1) / CHECKPOINT_LINES) * CHECKPOINT_LINES + 1);
  const checkpoint = [...previous.checkpoints].reverse().find((item) => item.line <= startLine);
  const state = checkpoint ? cloneState(checkpoint.state) : createOutlineScanState(newDoc.line(1).text);
  const prefixItems = previous.rawItems.filter((item) => item.line < startLine - 1);
  const prefixCheckpoints = previous.checkpoints.filter((item) => item.line < startLine);
  const rawItems = [...prefixItems];
  const checkpoints = [...prefixCheckpoints];
  const lineDelta = newDoc.lines - oldDoc.lines;
  for (let lineNumber = startLine; lineNumber <= newDoc.lines; lineNumber += 1) {
    if ((lineNumber - 1) % CHECKPOINT_LINES === 0) {
      const oldLine = lineNumber - lineDelta;
      const oldCheckpoint = lineNumber > newEndLine
        ? previous.checkpoints.find((item) => item.line === oldLine)
        : undefined;
      if (oldCheckpoint && statesEqual(state, oldCheckpoint.state)) {
        checkpoints.push({ line: lineNumber, state: cloneState(state) });
        for (const item of previous.rawItems.filter((candidate) => candidate.line >= oldLine - 1)) {
          const shiftedLine = item.line + lineDelta;
          rawItems.push({ ...item, line: shiftedLine, id: `heading-${shiftedLine}-${slugify(item.text)}` });
        }
        for (const old of previous.checkpoints.filter((item) => item.line > oldLine)) {
          checkpoints.push({ line: old.line + lineDelta, state: cloneState(old.state) });
        }
        return finalizeIndex(rawItems, checkpoints, newDoc.lines, outlineSequenceChanged(previous, rawItems, lineDelta));
      }
      checkpoints.push({ line: lineNumber, state: cloneState(state) });
    }
    const item = scanOutlineLine(newDoc.line(lineNumber).text, lineNumber - 1, state);
    if (item) rawItems.push(item);
  }
  return finalizeIndex(rawItems, checkpoints, newDoc.lines, outlineSequenceChanged(previous, rawItems, newDoc.lines - oldDoc.lines));
}

/**
 * Resolves parser context by scanning at most one checkpoint interval instead
 * of materialising or rescanning the complete CodeMirror document.
 */
export function sourceContextAtLine(index: SourceOutlineIndex, doc: Text, rawLineNumber: number): SourceContext {
  const lineNumber = Math.max(1, Math.min(doc.lines, Math.floor(rawLineNumber)));
  const checkpoint = [...index.checkpoints].reverse().find((item) => item.line <= lineNumber);
  const startLine = checkpoint?.line ?? 1;
  const state = checkpoint ? cloneState(checkpoint.state) : createOutlineScanState(doc.line(1).text);
  for (let cursor = startLine; cursor <= lineNumber; cursor += 1) {
    scanOutlineLine(doc.line(cursor).text, cursor - 1, state);
  }
  return {
    fence: Boolean(state.fence),
    frontMatter: state.frontMatter,
    mathBlock: state.mathBlock,
    htmlBlock: state.htmlBlock,
  };
}

function scanDocument(
  doc: Text,
  startLine: number,
  state: OutlineScanState,
  prefixItems: OutlineItemWithLine[],
  prefixCheckpoints: Checkpoint[],
  _changedEndLine = doc.lines,
) {
  const rawItems = [...prefixItems];
  const checkpoints = [...prefixCheckpoints];
  for (let lineNumber = startLine; lineNumber <= doc.lines; lineNumber += 1) {
    if ((lineNumber - 1) % CHECKPOINT_LINES === 0) checkpoints.push({ line: lineNumber, state: cloneState(state) });
    const item = scanOutlineLine(doc.line(lineNumber).text, lineNumber - 1, state);
    if (item) rawItems.push(item);
  }
  return finalizeIndex(rawItems, checkpoints, doc.lines, true);
}

function finalizeIndex(rawItems: OutlineItemWithLine[], checkpoints: Checkpoint[], lineCount: number, outlineChanged: boolean): SourceOutlineIndex {
  const items = structureOutline(rawItems, lineCount);
  return { rawItems, checkpoints, lineCount, items, itemsByLine: new Map(items.map((item) => [item.line, item])), outlineChanged };
}

function outlineSequenceChanged(previous: SourceOutlineIndex, next: OutlineItemWithLine[], lineDelta: number) {
  if (lineDelta !== 0 || previous.rawItems.length !== next.length) return true;
  return next.some((item, index) => {
    const old = previous.rawItems[index];
    return !old || old.text !== item.text || old.level !== item.level || old.line !== item.line;
  });
}

function cloneState(state: OutlineScanState): OutlineScanState {
  return { ...state, fence: state.fence ? { ...state.fence } : null };
}

function statesEqual(left: OutlineScanState, right: OutlineScanState) {
  return left.frontMatter === right.frontMatter
    && left.mathBlock === right.mathBlock
    && left.htmlBlock === right.htmlBlock
    && left.fence?.marker === right.fence?.marker
    && left.fence?.length === right.fence?.length;
}
