import type { LightMarkPlugin, RegisteredCommand } from "./types";

export const pluginCommands: RegisteredCommand[] = [];
export const markdownRenderers: Record<string, (markdown: string) => string> = {};

export function activatePlugins(plugins: LightMarkPlugin[]) {
  const context = {
    registerCommand(name: string, handler: () => void | Promise<void>) {
      pluginCommands.push({ name, handler });
    },
    registerMarkdownRenderer(name: string, handler: (markdown: string) => string) {
      markdownRenderers[name] = handler;
    },
  };
  plugins.forEach((plugin) => plugin.activate(context));
}
