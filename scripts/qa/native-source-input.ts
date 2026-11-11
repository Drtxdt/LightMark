import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';

/** Use the mounted production CM view; do not emulate input by mutating store text. */
export function insertNativeSourceHistoryText(session: any, from: number, text: string) {
  const expectedDoc = session.captureHistoryRoot().doc;
  const views = [...document.querySelectorAll<HTMLElement>('.cm-editor')]
    .map(element => EditorView.findFromDOM(element)).filter((view): view is EditorView => Boolean(view && view.state.doc === expectedDoc));
  if (views.length !== 1) throw new Error(`Expected exactly one owned CodeMirror view, found ${views.length}.`);
  const view = views[0];
  view.focus();
  view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length }, annotations: Transaction.userEvent.of('input.type') });
  return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
}
