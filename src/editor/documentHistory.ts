import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Text } from '@codemirror/state';
import type { SourceLineEndingState } from './sourceLineEndings';
import type { WysiwygSourceBaseline } from './wysiwygCodec';

export type HistoryBookmark = Readonly<{ anchor: number; head: number }>;
export type DocumentHistoryRoot =
  | Readonly<{ mode: 'source'; doc: Text; lineEndings: SourceLineEndingState }>
  | Readonly<{ mode: 'wysiwyg'; doc: ProseMirrorNode; baseline: WysiwygSourceBaseline }>;
export type HistoryInputKind = 'typing' | 'delete-backward' | 'delete-forward' | 'composition' | 'command';
export type HistoryInput = Readonly<{
  kind: HistoryInputKind;
  before: HistoryBookmark;
  after: HistoryBookmark;
  time: number;
  composition?: string | number;
}>;
export type HistoryProjection = Readonly<{ root: DocumentHistoryRoot; bookmark: HistoryBookmark }>;
export type HistoryVersion = Readonly<{ id: number; primary: HistoryProjection }>;
type HistoryEntry = { before: HistoryVersion; after: HistoryVersion; input: HistoryInput };
export type PreparedHistoryMove = Readonly<{
  generation: number;
  cursor: number;
  direction: -1 | 1;
  version: HistoryVersion;
}>;

/** Document-owned immutable roots. No views, dispatchers or NodeViews enter this log. */
export class DocumentHistory {
  private entries: HistoryEntry[] = [];
  private cursor = 0;
  private sequence = 0;
  private generation = 0;
  private grouped = false;
  private currentValue: HistoryVersion | null = null;
  private latestSelections = new WeakMap<HistoryVersion, HistoryProjection>();
  private exactSources = new WeakMap<HistoryVersion, string>();
  private replaying = false;
  private savedVersion: HistoryVersion | null = null;
  private savedSource: string | null = null;

  get current() { return this.currentValue; }
  get isReplaying() { return this.replaying; }
  get canUndo() { return this.cursor > 0; }
  get canRedo() { return this.cursor < this.entries.length; }
  get version() { return this.generation; }

  mount(root: DocumentHistoryRoot, bookmark: HistoryBookmark, exactSource: string, initiallySaved = true) {
    let created = false;
    if (!this.currentValue || this.exactSource() !== exactSource) {
      // External replacement is a new content generation. The caller retains
      // recovery material before replacing the live document.
      this.entries = [];
      this.cursor = 0;
      this.currentValue = this.makeVersion(root, bookmark);
      this.savedVersion = initiallySaved ? this.currentValue : null;
      this.savedSource = initiallySaved ? exactSource : null;
      created = true;
    }
    // A newly mounted view starts with a default selection. Preserve the
    // document bookmark until the new mode has restored its actual position.
    if (created) this.project(root, bookmark);
    this.checkpoint(exactSource);
    this.closeGroup();
  }

  record(root: DocumentHistoryRoot, input: HistoryInput) {
    if (this.replaying) return;
    if (!this.currentValue) throw new Error('Document history must be mounted before input.');
    const before = this.currentValue;
    const previousProjection = this.projection(before, root.mode);
    if (previousProjection.root.mode === root.mode) this.project(previousProjection.root, input.before);
    const after = this.makeVersion(root, input.after);
    const previous = this.entries[this.cursor - 1];
    const contiguous = previous && previous.after === before
      && previous.input.after.anchor === input.before.anchor && previous.input.after.head === input.before.head;
    const composing = input.kind === 'composition' && input.composition != null
      && previous?.input.kind === 'composition' && previous.input.composition === input.composition;
    const merge = this.grouped && this.cursor === this.entries.length && contiguous
      && input.kind !== 'command' && previous.input.kind === input.kind
      && (composing || input.time - previous.input.time <= 500 && input.time >= previous.input.time);
    this.entries.splice(this.cursor);
    if (merge) {
      previous.after = after;
      previous.input = input;
    } else {
      this.entries.push({ before, after, input });
      this.cursor++;
    }
    this.currentValue = after;
    this.grouped = input.kind !== 'command';
    this.generation++;
  }

  project(root: DocumentHistoryRoot, bookmark: HistoryBookmark) {
    if (!this.currentValue) throw new Error('Document history has no content.');
    const projection = Object.freeze({ root, bookmark: Object.freeze({ anchor: bookmark.anchor, head: bookmark.head }) });
    this.latestSelections.set(this.currentValue, projection);
  }

  projection(version: HistoryVersion, mode: DocumentHistoryRoot['mode']) {
    const latest = this.latestSelections.get(version) ?? version.primary;
    // A cached content root in another mode does not imply its old selection
    // is current. Replay converts the latest bookmark together with its root.
    return latest;
  }

  checkpoint(source: string) {
    if (this.currentValue) this.exactSources.set(this.currentValue, source);
  }

  exactSource(version = this.currentValue) {
    return version ? this.exactSources.get(version) : undefined;
  }

  closeGroup() { this.grouped = false; }

  markSaved(source: string) {
    this.savedSource = source;
    this.savedVersion = this.exactSource() === source ? this.currentValue : null;
  }

  isSaved(version: HistoryVersion) {
    return version === this.savedVersion || this.exactSource(version) === this.savedSource;
  }

  prepare(direction: -1 | 1): PreparedHistoryMove | null {
    const entry = this.entries[direction === -1 ? this.cursor - 1 : this.cursor];
    return entry ? Object.freeze({ generation: this.generation, cursor: this.cursor, direction, version: direction === -1 ? entry.before : entry.after }) : null;
  }

  commit(move: PreparedHistoryMove, publish: () => void) {
    if (move.generation !== this.generation || move.cursor !== this.cursor || this.prepare(move.direction)?.version !== move.version) {
      throw new Error('撤销目标已过期，当前输入已保留。');
    }
    this.replaying = true;
    try { publish(); }
    finally { this.replaying = false; }
    this.cursor += move.direction;
    this.currentValue = move.version;
    this.generation++;
    this.closeGroup();
  }

  private makeVersion(root: DocumentHistoryRoot, bookmark: HistoryBookmark): HistoryVersion {
    return Object.freeze({ id: ++this.sequence, primary: Object.freeze({ root, bookmark: Object.freeze({ anchor: bookmark.anchor, head: bookmark.head }) }) });
  }
}
