export function bindShortcut(key: string, handler: (event: KeyboardEvent) => void | boolean) {
  const normalized = key.toLowerCase();
  const listener = (event: KeyboardEvent) => {
    const parts = normalized.split("+");
    const targetKey = parts[parts.length - 1];
    const ctrl = parts.includes("ctrl");
    const shift = parts.includes("shift");
    const alt = parts.includes("alt");
    if (
      event.key.toLowerCase() === targetKey &&
      event.ctrlKey === ctrl &&
      event.shiftKey === shift &&
      event.altKey === alt
    ) {
      if (handler(event) === false) return;
      event.preventDefault();
    }
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}
