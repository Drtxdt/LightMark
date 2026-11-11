import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  optimizeDeps: { include: ["highlight.js/lib/core", "@tiptap/pm/transform"] },
  build: { manifest: true },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/.cache/**", "**/dist/**"],
    },
  },
});
