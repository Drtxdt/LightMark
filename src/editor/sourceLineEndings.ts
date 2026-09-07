import { invertedEffects } from "@codemirror/commands";
import {
  EditorState,
  StateEffect,
  StateField,
  type ChangeDesc,
  type ChangeSet,
  type Extension,
  type Text,
  type Transaction,
} from "@codemirror/state";

export type SourceLineEnding = "\n" | "\r\n" | "\r";

export interface SourceLineEndingState {
  readonly main: SourceLineEnding;
  /** One entry for each normalized LF in the CodeMirror document. */
  readonly endings: readonly SourceLineEnding[];
}

export interface SourceDocument {
  readonly text: string;
  readonly lineEndings: SourceLineEndingState;
}

interface SourceLineEndingEntry {
  readonly pos: number;
  readonly ending: SourceLineEnding;
}

interface SourceLineEndingRestore {
  readonly main?: SourceLineEnding;
  readonly entries: readonly SourceLineEndingEntry[];
}

const sourceLineEndingRestore = StateEffect.define<SourceLineEndingRestore>({
  map(value, changes) {
    return {
      main: value.main,
      entries: value.entries.map((entry) => ({
        // These positions belong to the document restored by the inverse history
        // change. The old EOL may be absent in the current document by design, so
        // TrackAfter would incorrectly drop it when an adjacent character moves.
        pos: changes.mapPos(entry.pos, 1),
        ending: entry.ending,
      })),
    };
  },
});

/** Replace metadata at a document boundary, while leaving the history effect local. */
export const resetSourceLineEndings = StateEffect.define<SourceLineEndingState>();

export const sourceLineEndingsField = StateField.define<SourceLineEndingState>({
  create(state) {
    return {
      main: "\n",
      endings: Array.from({ length: Math.max(0, state.doc.lines - 1) }, () => "\n" as SourceLineEnding),
    };
  },
  update(value, transaction) {
    let next = value;
    if (!transaction.changes.empty) {
      next = mapLineEndings(value, transaction.startState.doc, transaction.changes, transaction.newDoc);
    }
    for (const effect of transaction.effects) {
      if (effect.is(resetSourceLineEndings)) {
        next = effect.value;
      } else if (effect.is(sourceLineEndingRestore)) {
        next = applyRestoredLineEndings(next, transaction.state.doc, effect.value);
      }
    }
    return next;
  },
});

/** Add the field and its history integration for one source document. */
export function sourceLineEndingsExtension(lineEndings: SourceLineEndingState): Extension {
  return [
    sourceLineEndingsField.init(() => lineEndings),
    invertedEffects.of(invertSourceLineEndingChanges),
  ];
}

export function parseSourceDocument(source: string): SourceDocument {
  const matches = source.match(/\r\n|\r|\n/g);
  if (!matches) {
    return {
      text: source,
      lineEndings: { main: "\n", endings: [] },
    };
  }
  const endings = matches as SourceLineEnding[];
  return {
    text: source.replace(/\r\n?|\n/g, "\n"),
    lineEndings: {
      main: endings[0],
      endings,
    },
  };
}

/** Canonicalize text entering an existing source document. New EOLs use the document main EOL on snapshot. */
export function normalizeSourceLineBreaks(source: string) {
  return source.replace(/\r\n?/g, "\n");
}

export function sourceOffsetToRawOffset(source: string, normalizedOffset: number) {
  const target = Math.max(0, normalizedOffset);
  let raw = 0;
  let normalized = 0;
  while (raw < source.length && normalized < target) {
    if (source[raw] === "\r" && source[raw + 1] === "\n") raw += 2;
    else raw += 1;
    normalized += 1;
  }
  return raw;
}

export function rawOffsetToSourceOffset(source: string, rawOffset: number) {
  const target = Math.max(0, Math.min(rawOffset, source.length));
  let raw = 0;
  let normalized = 0;
  while (raw < target) {
    const width = source[raw] === "\r" && source[raw + 1] === "\n" ? 2 : 1;
    if (raw + width > target) break;
    raw += width;
    normalized += 1;
  }
  return normalized;
}

export function serializeSourceDocument(
  doc: Pick<Text, "toString" | "lines">,
  lineEndings: SourceLineEndingState,
) {
  const normalized = doc.toString();
  const expectedEndings = Math.max(0, doc.lines - 1);
  if (lineEndings.endings.length !== expectedEndings) {
    throw new Error(
      `Source line-ending metadata is out of sync (expected ${expectedEndings}, got ${lineEndings.endings.length}).`,
    );
  }
  let endingIndex = 0;
  const result = normalized.replace(/\n/g, () => {
    const ending = lineEndings.endings[endingIndex];
    if (!ending) throw new Error(`Source line-ending metadata is missing entry ${endingIndex}.`);
    endingIndex += 1;
    return ending;
  });
  if (endingIndex !== expectedEndings) {
    throw new Error(
      `Source line-ending metadata is out of sync (serialized ${endingIndex} of ${expectedEndings} entries).`,
    );
  }
  return result;
}

function invertSourceLineEndingChanges(transaction: Transaction) {
  if (transaction.changes.empty) return [];
  const lineEndings = transaction.startState.field(sourceLineEndingsField, false);
  if (!lineEndings) return [];
  const nextLineEndings = transaction.state.field(sourceLineEndingsField, false);
  const entries: SourceLineEndingEntry[] = [];
  transaction.changes.iterChangedRanges((fromA, toA) => {
    const fromEnding = newlineIndexAt(transaction.startState.doc, fromA);
    const toEnding = newlineIndexAt(transaction.startState.doc, toA);
    for (let index = fromEnding; index < toEnding; index += 1) {
      const ending = lineEndings.endings[index];
      if (!ending) continue;
      entries.push({
        pos: transaction.startState.doc.line(index + 1).to,
        ending,
      });
    }
  });
  const main = nextLineEndings && nextLineEndings.main !== lineEndings.main ? lineEndings.main : undefined;
  return entries.length > 0 || main
    ? [sourceLineEndingRestore.of({ main, entries })]
    : [];
}

function mapLineEndings(
  value: SourceLineEndingState,
  oldDoc: EditorState["doc"],
  changes: ChangeSet,
  newDoc: EditorState["doc"],
) {
  const expectedOld = Math.max(0, oldDoc.lines - 1);
  if (value.endings.length !== expectedOld) {
    throw new Error(
      `Source line-ending metadata before update is out of sync (expected ${expectedOld}, got ${value.endings.length}).`,
    );
  }
  let changed = false;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const fromEnding = newlineIndexAt(oldDoc, fromA);
    const toEnding = newlineIndexAt(oldDoc, toA);
    if (fromEnding !== toEnding || inserted.lines > 1) changed = true;
  });
  if (!changed) return value;
  const endings: SourceLineEnding[] = [];
  let oldEndingCursor = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const fromEnding = newlineIndexAt(oldDoc, fromA);
    const toEnding = newlineIndexAt(oldDoc, toA);
    appendEndings(endings, value.endings, oldEndingCursor, fromEnding);
    for (let index = 1; index < inserted.lines; index += 1) endings.push(value.main);
    oldEndingCursor = toEnding;
  });
  appendEndings(endings, value.endings, oldEndingCursor, value.endings.length);
  const expected = Math.max(0, newDoc.lines - 1);
  if (endings.length !== expected) {
    throw new Error(
      `Source line-ending metadata update is out of sync (expected ${expected}, got ${endings.length}).`,
    );
  }
  return { main: value.main, endings } satisfies SourceLineEndingState;
}

function appendEndings(
  target: SourceLineEnding[],
  source: readonly SourceLineEnding[],
  from: number,
  to: number,
) {
  for (let index = from; index < to; index += 1) target.push(source[index]);
}

function applyRestoredLineEndings(
  value: SourceLineEndingState,
  doc: EditorState["doc"],
  restore: SourceLineEndingRestore,
) {
  if (restore.entries.length === 0) {
    return restore.main === undefined || restore.main === value.main
      ? value
      : { main: restore.main, endings: value.endings };
  }
  let endings: SourceLineEnding[] | null = null;
  for (const entry of restore.entries) {
    if (entry.pos < 0 || entry.pos >= doc.length || doc.sliceString(entry.pos, entry.pos + 1) !== "\n") continue;
    const index = newlineIndexAt(doc, entry.pos);
    if (index < 0 || index >= value.endings.length) continue;
    if (!endings) endings = [...value.endings];
    endings[index] = entry.ending;
  }
  const main = restore.main ?? value.main;
  return endings ? { main, endings } : { main, endings: value.endings };
}

function newlineIndexAt(doc: EditorState["doc"], position: number) {
  const clamped = Math.max(0, Math.min(position, doc.length));
  return doc.lineAt(clamped).number - 1;
}
