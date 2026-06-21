import { invoke } from "@tauri-apps/api/core";

export async function syncWindowChrome(fileName: string, theme: "light" | "dark") {
  try {
    await invoke("sync_window_chrome", { fileName, theme });
  } catch (error) {
    console.warn("Failed to sync native window chrome", error);
  }
}
