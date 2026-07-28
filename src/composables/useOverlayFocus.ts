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
 * Gives command overlays deterministic desktop-style focus behavior. Vue's
 * conditional mounting and WebView focus retention make the HTML `autofocus`
 * attribute insufficient on its own.
 */
export function useOverlayFocus(options: OverlayFocusOptions) {
  let previousFocus: HTMLElement | null = null;
  let listening = false;
  let stopWatching: WatchStopHandle | null = null;

  function isTopmost() {
    return visibleBackdrops().at(-1) === options.backdrop.value;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!isTopmost()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      options.close();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = options.panel.value;
    const focusable = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
      .filter(isElementVisible);
    if (focusable.length === 0) {
      event.preventDefault();
      panel?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (!panel?.contains(activeElement)) {
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
