import { nextTick, onBeforeUnmount, onMounted, type Ref } from "vue";

type OverlayFocusOptions = {
  backdrop: Ref<HTMLElement | null>;
  panel: Ref<HTMLElement | null>;
  initialFocus: Ref<HTMLElement | null>;
  close: () => void;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Gives command overlays deterministic desktop-style focus behavior. Vue's
 * conditional mounting and WebView focus retention make the HTML `autofocus`
 * attribute insufficient on its own.
 */
export function useOverlayFocus(options: OverlayFocusOptions) {
  let previousFocus: HTMLElement | null = null;

  function isTopmost() {
    const backdrops = Array.from(document.querySelectorAll<HTMLElement>(".lm-modal-backdrop"))
      .filter((element) => element.offsetParent !== null);
    return backdrops.at(-1) === options.backdrop.value;
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
    const focusable = Array.from(options.panel.value?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
      .filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      options.panel.value?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMounted(() => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.addEventListener("keydown", handleKeydown, true);
    void nextTick(() => {
      requestAnimationFrame(() => (options.initialFocus.value ?? options.panel.value)?.focus());
    });
  });

  onBeforeUnmount(() => {
    window.removeEventListener("keydown", handleKeydown, true);
    const target = previousFocus;
    void nextTick(() => target?.isConnected && target.focus());
  });
}
