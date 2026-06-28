export type EditorMode = "wysiwyg" | "source";
export type ThemeMode = "light" | "dark" | "system";
export type DocumentMode = "normal" | "large";
export type DocumentTabKind = "normal" | "large" | "untitled";
export type ImageInsertBehavior = "reference" | "copyToAssets";
export type ExportDefaultFolder = "auto" | "sameFolder" | "custom";
export type ExportTargetKind = "native-html" | "native-image" | "native-pdf" | "pandoc";
export type ExportRunStatus = "idle" | "running" | "success" | "error";
export type ExportTargetId =
  | "html"
  | "htmlPlain"
  | "png"
  | "pdf"
  | "pdfPandoc"
  | "docx"
  | "odt"
  | "rtf"
  | "epub"
  | "latex"
  | "mediawiki"
  | "rst"
  | "textile"
  | "opml"
  | "revealjs"
  | "markdownSpec"
  | "customPandoc";

export interface PendingModeCursor {
  targetMode: EditorMode;
  markdownAnchor: number;
  markdownHead: number;
  markdownLine?: number;
  markdownColumn?: number;
  markdownLineText?: string;
  reason: "mode-switch";
}

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
  session?: SessionRestoreState;
}

export interface SessionRestoreState {
  openTabs: SessionTabState[];
  activeTabKey?: string;
}

export interface SessionTabState {
  path: string;
  kind: Extract<DocumentTabKind, "normal" | "large">;
  editorMode: EditorMode;
  lastActiveAt: number;
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
  preferBundledPandoc: boolean;
  pdfEngine: string;
  pdfPaperSize: string;
  pdfMargin: string;
  docxReferenceDoc: string;
  epubCoverImage: string;
  epubCss: string;
  customPandocFormat: string;
  customPandocExtension: string;
  customPandocArgs: string;
}

export interface ExportTarget {
  id: ExportTargetId;
  label: string;
  extension: string;
  kind: ExportTargetKind;
  requiresPandoc: boolean;
  enabled: boolean;
  disabledReason?: string;
}

export interface ExportRequest {
  target: ExportTargetId;
  currentPath: string;
  title: string;
  markdown: string;
  html?: string;
  plainHtml?: string;
  settings: ExportSettings;
}

export interface ExportResult {
  path: string;
  format: ExportTargetId;
  usedPandocPath?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
}

export interface ExportStatus {
  status: ExportRunStatus;
  targetId?: ExportTargetId;
  targetLabel?: string;
  path?: string;
  message: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PandocStatus {
  available: boolean;
  path: string;
  version: string;
  source: "bundled" | "custom" | "path" | "missing";
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

export interface DraftRecord {
  id: string;
  kind: "file" | "untitled" | "large";
  path?: string;
  content?: string;
  pendingEdits?: TextEdit[];
  fileMtime?: number;
  fileSize?: number;
  updatedAt: number;
  editorMode?: EditorMode;
}

export interface FileSnapshot {
  exists: boolean;
  mtime?: number;
  size?: number;
}

export interface LargeFindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface LargeFindMatch {
  line: number;
  startColumn: number;
  endColumn: number;
  text: string;
  preview: string;
}

export interface LargeFindResult {
  matches: LargeFindMatch[];
  total: number;
  truncated: boolean;
  error: string;
}

export interface LargeFileState {
  sessionId: string;
  sizeBytes: number;
  totalLines: number;
  loadedRanges: Array<{ startLine: number; endLine: number }>;
  pendingEdits: TextEdit[];
  outline: LargeOutlineItem[];
}

export interface DocumentTab {
  id: string;
  kind: DocumentTabKind;
  path: string;
  name: string;
  content: string;
  documentMode: DocumentMode;
  largeFile: LargeFileState | null;
  isDirty: boolean;
  editorMode: EditorMode;
  pendingModeCursor: PendingModeCursor | null;
  fileSnapshot?: FileSnapshot;
  draftId?: string;
  openedAt: number;
  lastActiveAt: number;
}
