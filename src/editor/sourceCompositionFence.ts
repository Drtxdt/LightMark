/**
 * Tracks the browser composition lifecycle for a CodeMirror view as a
 * supplemental signal.  SourceEditor combines this DOM lifecycle with
 * CodeMirror's public EditorView composition getters, including its
 * EditContext path. A pending edit version changes at each lifecycle
 * transition so a caller that captured a clean boundary cannot silently use
 * it after an IME session starts or ends.
 */
export interface SourceCompositionFence {
  isComposing(): boolean;
  pendingEditVersion(): number;
  attach(target: EventTarget): () => void;
}

/**
 * CodeMirror exposes composition state on EditorView.  Those getters also
 * cover Chromium's EditContext path, where the browser may not dispatch the
 * composition events on view.dom.  The DOM fence remains a supplemental
 * signal for platforms that do dispatch those events.
 */
export interface SourceEditorCompositionState {
  readonly compositionStarted?: boolean;
  readonly composing?: boolean;
}

export function isSourceEditorComposing(
  editor: SourceEditorCompositionState | null | undefined,
  fence: Pick<SourceCompositionFence, "isComposing">,
) {
  return Boolean(editor?.compositionStarted || editor?.composing || fence.isComposing());
}

export function createSourceCompositionFence(): SourceCompositionFence {
  let depth = 0;
  let version = 0;

  const onCompositionStart = () => {
    depth += 1;
    version += 1;
  };
  const onCompositionEnd = () => {
    if (depth === 0) return;
    depth -= 1;
    version += 1;
  };

  return {
    isComposing: () => depth > 0,
    pendingEditVersion: () => version,
    attach(target) {
      target.addEventListener("compositionstart", onCompositionStart);
      target.addEventListener("compositionend", onCompositionEnd);
      return () => {
        target.removeEventListener("compositionstart", onCompositionStart);
        target.removeEventListener("compositionend", onCompositionEnd);
      };
    },
  };
}
