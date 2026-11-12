import { invoke } from "@tauri-apps/api/core";

export const isMacDesktop = () => typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export function documentPathKey(path: string) {
  return isMacDesktop() ? path : path.replace(/\\/g, "/").toLocaleLowerCase();
}

export async function documentOpenPath(path: string) {
  return isMacDesktop() ? invoke<string>("document_open_path", { path }) : path;
}
