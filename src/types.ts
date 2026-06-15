export type EditorMode = "wysiwyg" | "source";
export type ThemeMode = "light" | "dark" | "system";
export type DocumentMode = "normal" | "large";
export type ImageInsertBehavior = "reference" | "copyToAssets";
export type ExportDefaultFolder = "auto" | "sameFolder" | "custom";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface AppConfig {
  recentFiles: string[];
  theme?: ThemeMode;
  settings?: AppSettings;
}

export interface AppSettings {
  general: GeneralSettings;
  editor: EditorSettings;
  markdown: MarkdownSettings;
  image: ImageSettings;
  appearance: AppearanceSettings;
  export: ExportSettings;
  shortcuts: ShortcutSettings;
  advanced: AdvancedSettings;
}

export interface GeneralSettings {
  launchBehavior: "blank" | "restoreLastSession" | "openWorkspace";
  restoreLastFile: boolean;
  recentFilesLimit: number;
  autoSave: boolean;
  autoSaveIntervalMinutes: number;
  language: "system" | "zh-CN" | "en-US";
  spellcheck: boolean;
  spellcheckLanguage: string;
}

export interface EditorSettings {
  defaultMode: EditorMode;
  autoPairBrackets: boolean;
  autoPairMarkdownSyntax: boolean;
  pasteMarkdownAsPlainText: boolean;
  focusMode: boolean;
  typewriterMode: boolean;
  showWordCount: boolean;
}

export interface MarkdownSettings {
  strictMode: boolean;
  inlineHtml: boolean;
  blockHtml: boolean;
  math: boolean;
  mermaid: boolean;
  footnotes: boolean;
  toc: boolean;
  taskList: boolean;
  githubAlerts: boolean;
  yamlFrontMatter: boolean;
  smartPunctuation: boolean;
  subscript: boolean;
  superscript: boolean;
  highlight: boolean;
}

export interface ImageSettings {
  insertBehavior: ImageInsertBehavior;
  useRelativePath: boolean;
  ensureDotSlash: boolean;
  escapePath: boolean;
  assetFolder: string;
  rootUrl: string;
}

export interface AppearanceSettings {
  theme: ThemeMode;
  editorWidth: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  codeFontFamily: string;
  showSidebar: boolean;
  showOutline: boolean;
}

export interface ExportSettings {
  defaultFolder: ExportDefaultFolder;
  customFolder: string;
  htmlTheme: "current" | "light" | "dark";
  htmlIncludeStyles: boolean;
  allowYamlOverride: boolean;
  openFileAfterExport: boolean;
  openFolderAfterExport: boolean;
  pandocPath: string;
}

export interface ShortcutSettings {
  customKeybindings: boolean;
}

export interface AdvancedSettings {
  debugMode: boolean;
  experimentalFeatures: boolean;
}

export interface OutlineItem {
  id: string;
  text: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface FileInfo {
  path: string;
  sizeBytes: number;
  lineCount: number;
  isLarge: boolean;
  encoding: string;
}

export interface LargeOutlineItem extends OutlineItem {
  line: number;
}

export interface LargeFileSession {
  sessionId: string;
  path: string;
  sizeBytes: number;
  totalLines: number;
  outline: LargeOutlineItem[];
}

export interface FileChunk {
  sessionId: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
}

export interface TextEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export interface DirtyState {
  isDirty: boolean;
  pendingEditCount: number;
}

export interface LargeFileState {
  sessionId: string;
  sizeBytes: number;
  totalLines: number;
  loadedRanges: Array<{ startLine: number; endLine: number }>;
  pendingEdits: TextEdit[];
  outline: LargeOutlineItem[];
}
