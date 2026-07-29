import { createApp } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import "./styles/index.css";

async function bootstrap() {
  await invoke("trace_headless_frontend", { stage: "bootstrap" }).catch(() => {});
  let headless: import("./headlessExport").HeadlessExportPayload | null = null;
  try {
    headless = await invoke("get_headless_export_request");
  } catch (error) {
    await invoke("trace_headless_frontend", { stage: `payload error: ${String(error)}` }).catch(() => {});
  }
  if (headless) {
    document.documentElement.dataset.headlessExport = "true";
    await getCurrentWindow().hide().catch(() => {});
    const { runHeadlessExport } = await import("./headlessExport");
    await runHeadlessExport(headless);
    return;
  }
  createApp(App).mount("#app");
}

void bootstrap();
