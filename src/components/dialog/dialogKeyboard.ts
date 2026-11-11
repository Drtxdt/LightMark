export function handleDialogBackdropKeydown(
  event: KeyboardEvent,
  backdrop: EventTarget | null,
  panel: EventTarget | null,
  defaultId: string | undefined,
  close: (id: string) => void,
) {
  if (event.key !== "Enter" || event.isComposing) return;
  // The backdrop and panel are the only non-interactive focus targets. A
  // focused button must keep the browser's native Enter/Space activation.
  if (event.target !== backdrop && event.target !== panel) return;
  if (!defaultId) return;
  event.preventDefault();
  event.stopPropagation();
  close(defaultId);
}
