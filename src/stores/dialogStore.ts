import { reactive } from "vue";

export type DialogTone = "default" | "danger";
export type DialogButtonVariant = "primary" | "secondary" | "danger";

export interface DialogButton {
  id: string;
  label: string;
  variant?: DialogButtonVariant;
}

export interface DialogRequest {
  title: string;
  message: string;
  details?: string[];
  buttons: DialogButton[];
  cancelId: string;
  defaultId?: string;
  tone?: DialogTone;
}

interface ActiveDialog extends DialogRequest {
  resolve: (value: string) => void;
}

export const dialogStore = reactive({
  active: null as ActiveDialog | null,
});

export function showDialog(request: DialogRequest) {
  return new Promise<string>((resolve) => {
    dialogStore.active = { ...request, resolve };
  });
}

export async function confirmDialog(options: {
  title: string;
  message: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
}) {
  const confirmId = "confirm";
  const cancelId = "cancel";
  const result = await showDialog({
    title: options.title,
    message: options.message,
    details: options.details,
    tone: options.tone,
    cancelId,
    defaultId: confirmId,
    buttons: [
      { id: cancelId, label: options.cancelLabel ?? "取消", variant: "secondary" },
      {
        id: confirmId,
        label: options.confirmLabel ?? "确定",
        variant: options.tone === "danger" ? "danger" : "primary",
      },
    ],
  });
  return result === confirmId;
}

export function alertDialog(options: { title: string; message: string; details?: string[]; tone?: DialogTone }) {
  return showDialog({
    title: options.title,
    message: options.message,
    details: options.details,
    tone: options.tone,
    cancelId: "ok",
    defaultId: "ok",
    buttons: [{ id: "ok", label: "知道了", variant: options.tone === "danger" ? "danger" : "primary" }],
  });
}

export function resolveDialog(resultId: string) {
  const active = dialogStore.active;
  if (!active) return;
  dialogStore.active = null;
  active.resolve(resultId);
}
