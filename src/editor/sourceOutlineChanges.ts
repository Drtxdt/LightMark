import type { ChangeSet, Text } from '@codemirror/state';
import { updateSourceOutlineIndex, type SourceOutlineIndex } from './sourceOutlineIndex';

export interface SourceOutlineChangeDiagnostics { lineReads: number; changedRanges: number }
const diagnosticsByDoc = new WeakMap<Text, SourceOutlineChangeDiagnostics>();
export function sourceOutlineChangeDiagnostics(doc: Text) { return diagnosticsByDoc.get(doc); }

/** Persistent Text slices keep distant edits from forcing a scan between them. */
export function updateSourceOutlineChanges(previous: SourceOutlineIndex, startDoc: Text, changes: ChangeSet, publishedDoc?: Text) {
  const ranges: Array<{ from: number; to: number; insert: Text }> = [];
  changes.iterChanges((from, to, _newFrom, _newTo, insert) => ranges.push({ from, to, insert }));
  let index = previous, doc = startDoc, lineReads = 0;
  // Right-to-left keeps each remaining range in its original coordinate space.
  for (let cursor = ranges.length - 1; cursor >= 0; cursor--) {
    const { from, to, insert } = ranges[cursor];
    const next = doc.replace(from, to, insert);
    const observed = new Proxy(next, { get(target, key) {
      if (key === 'line') return (number: number) => { lineReads++; return target.line(number); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    index = updateSourceOutlineIndex(index, doc, observed, from, from, from + insert.length);
    doc = next;
  }
  const diagnostics = { lineReads, changedRanges: ranges.length };
  diagnosticsByDoc.set(publishedDoc ?? doc, diagnostics);
  return { index, ...diagnostics };
}
