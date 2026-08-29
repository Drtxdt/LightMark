type LowlightInstance = {
  registered(language: string): boolean;
  register(name: string, grammar: unknown): void;
  highlight(language: string, value: string, options?: unknown): unknown;
};

type LanguageModule = { default: unknown };

const languageModules = import.meta.glob<LanguageModule>(
  ["../../node_modules/highlight.js/es/languages/*.js", "!../../node_modules/highlight.js/es/languages/*.js.js"],
  { query: "?lightmark-language" },
);

const aliases: Record<string, string> = {
  "c++": "cpp", "c#": "csharp", "f#": "fsharp",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  html: "xml", xhtml: "xml", rss: "xml", atom: "xml", svg: "xml",
  md: "markdown", mkdown: "markdown", mkd: "markdown",
  py: "python", gyp: "python", ipython: "python",
  rb: "ruby", gemspec: "ruby", podspec: "ruby", thor: "ruby",
  rs: "rust", golang: "go", kt: "kotlin", kts: "kotlin",
  sh: "bash", shell: "bash", zsh: "bash", console: "shell",
  yml: "yaml", docker: "dockerfile", jsp: "java",
  tex: "latex", objc: "objectivec", mm: "objectivec",
  ps: "powershell", ps1: "powershell", plaintext: "plaintext", text: "plaintext", txt: "plaintext",
  vue: "xml", svelte: "xml", astro: "xml",
};

const pending = new Map<string, Promise<boolean>>();

export function installLowlightPlainTextFallback(lowlight: LowlightInstance) {
  const highlight = lowlight.highlight.bind(lowlight);
  lowlight.highlight = (language: string, value: string, options?: unknown) => {
    if (lowlight.registered(String(language || "").toLowerCase())) {
      return highlight(language, value, options);
    }
    return {
      type: "root",
      children: [{ type: "text", value }],
      data: { language: null, relevance: 0 },
    };
  };
  return lowlight;
}

export async function ensureLowlightLanguage(lowlight: LowlightInstance, rawLanguage: string | null | undefined) {
  const requested = String(rawLanguage || "").trim().toLowerCase();
  if (!requested || lowlight.registered(requested)) return false;
  const canonical = aliases[requested] || requested;
  if (lowlight.registered(canonical)) return false;
  const existing = pending.get(canonical);
  if (existing) return existing;
  const suffix = `/highlight.js/es/languages/${canonical}.js`;
  const loaderEntry = Object.entries(languageModules).find(([path]) => path.endsWith(suffix) && !path.endsWith(".js.js"));
  if (!loaderEntry) return false;
  const task = loaderEntry[1]().then((module) => {
    lowlight.register(canonical, module.default);
    return true;
  }).finally(() => pending.delete(canonical));
  pending.set(canonical, task);
  return task;
}
