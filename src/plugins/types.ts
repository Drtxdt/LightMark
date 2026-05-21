export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
}

export interface RegisteredCommand {
  name: string;
  handler: () => void | Promise<void>;
}

export interface PluginContext {
  registerCommand(name: string, handler: () => void | Promise<void>): void;
  registerMarkdownRenderer(name: string, handler: (markdown: string) => string): void;
}

export interface LightMarkPlugin {
  manifest: PluginManifest;
  activate(context: PluginContext): void;
}
