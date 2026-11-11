import { nextTick, onBeforeUnmount, onMounted, watch, type Ref, type WatchStopHandle } from "vue";

type OverlayFocusOptions = {
  backdrop: Ref<HTMLElement | null>;
  panel: Ref<HTMLElement | null>;
  initialFocus: Ref<HTMLElement | null>;
  close: () => void;
  active?: Ref<boolean>;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isElementVisible(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  return style.display !== "none"
    && style.visibility !== "hidden"
    && style.visibility !== "collapse"
    && element.getClientRects().length > 0;
}

function overlayZIndex(element: HTMLElement) {
  const value = Number.parseInt(window.getComputedStyle(element).zIndex, 10);
  return Number.isFinite(value) ? value : 0;
}

function visibleBackdrops() {
  return Array.from(document.querySelectorAll<HTMLElement>(".lm-modal-backdrop, .dialog-backdrop"))
    .filter(isElementVisible)
    .sort((left, right) => {
      const zIndexDelta = overlayZIndex(left) - overlayZIndex(right);
      if (zIndexDelta !== 0) return zIndexDelta;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
}

/**
 * Apply the focus trap's Tab boundary to one already-selected overlay.  This
 * small pure boundary keeps panel focus (the initial fallback when no
 * autofocus target is available) inside the dialog on the very first Tab.
 */
export function handleOverlayTabKeydown(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  panel: HTMLElement,
  focusable: HTMLElement[],
  activeElement: Element | null,
) {
  if (event.key !== "Tab") return;
  if (focusable.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  // A panel with tabindex=-1 is the intentional initial focus fallback. It
  // is a trap boundary just like focus outside the panel.
  if (!panel.contains(activeElement) || activeElement === panel) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function isTopmostOverlay(backdrop: HTMLElement, orderedBackdrops: HTMLElement[]) {
  return orderedBackdrops.at(-1) === backdrop;
}

/**
 * Gives command overlays deterministic desktop-style focus behavior. Vue's
 * conditional mounting and WebView focus retention make the HTML `autofocus`
 * attribute insufficient on its own.
 */
export function useOverlayFocus(options: OverlayFocusOptions) {
  let previousFocus: HTMLElement | null = null;
  let listening = false;
  let stopWatching: WatchStopHandle | null = null;

  function isTopmost() {
    return isTopmostOverlay(options.backdrop.value as HTMLElement, visibleBackdrops());
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!isTopmost()) return;
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      options.close();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = options.panel.value;
    const focusable = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
      .filter(isElementVisible);
    if (!panel) return;
    handleOverlayTabKeydown(event, panel, focusable, document.activeElement);
  }

  function activate() {
    if (listening) return;
    listening = true;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.addEventListener("keydown", handleKeydown, true);
    void nextTick(() => {
      requestAnimationFrame(() => (options.initialFocus.value ?? options.panel.value)?.focus());
    });
  }

  function deactivate(restoreFocus = true) {
    if (!listening) return;
    listening = false;
    window.removeEventListener("keydown", handleKeydown, true);
    if (!restoreFocus) return;
    const target = previousFocus;
    const closingBackdrop = options.backdrop.value;
    void nextTick(() => {
      if (!target?.isConnected) return;
      const topmost = visibleBackdrops()
        .filter((backdrop) => backdrop !== closingBackdrop)
        .at(-1);
      if (!topmost || topmost.contains(target)) target.focus();
    });
  }

  onMounted(() => {
    if (!options.active) {
      activate();
      return;
    }
    stopWatching = watch(
      options.active,
      (active) => {
        if (active) activate();
        else deactivate();
      },
      { immediate: true },
    );
  });

  onBeforeUnmount(() => {
    stopWatching?.();
    deactivate();
  });
}
