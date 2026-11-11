export function matchesShortcut(key: string, event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing">, platform = typeof navigator === "undefined" ? "" : navigator.platform) {
  if (event.isComposing) return false;
  const parts = key.toLowerCase().split("+");
  const mod = parts.includes("mod") || parts.includes("ctrl");
  const mac = /mac|iphone|ipad/i.test(platform);
  return event.key.toLowerCase() === parts[parts.length - 1]
    && event.ctrlKey === (mod && !mac)
    && event.metaKey === (mod && mac || parts.includes("meta"))
    && event.shiftKey === parts.includes("shift")
    && event.altKey === parts.includes("alt");
}

export function bindShortcut(key: string, handler: (event: KeyboardEvent) => void | boolean, options: { allowDuringComposition?: boolean } = {}) {
  const normalized = key.toLowerCase();
  const listener = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as Element | null;
    if (target && typeof target.closest === "function"
      && target.closest(".lm-settings-panel")
      && target.closest("input, textarea, select, [contenteditable='true']")) return;
    const keyEvent = options.allowDuringComposition && event.isComposing
      ? { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, isComposing: false }
      : event;
    if (matchesShortcut(normalized, keyEvent)) {
      if (handler(event) === false) return;
      event.preventDefault();
    }
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}
