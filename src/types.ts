export type EditorMode = "wysiwyg" | "source";
export type EditorPaneId = "main" | "secondary";
export type ThemeMode = "light" | "dark" | "system";
export type DocumentMode = "normal" | "large";
export type DocumentTabKind = "normal" | "large" | "untitled";
export type ExternalFileState = "clean" | "modified" | "deleted";
export type ImageInsertBehavior = "reference" | "copyToAssets";
export type PastedImageNaming = "preserve" | "timestamp";
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

export interface EditorPositionSnapshot {
  editorMode: EditorMode;
  editorAnchor?: number;
  editorHead?: number;
  markdownAnchor: number;
  markdownHead: number;
  markdownLine: number;
  markdownColumn: number;
  markdownLineText: string;
  scrollTop: number;
  scrollRatio: number;
  updatedAt: number;
}

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface QuickOpenCandidate {
  name: string;
  path: string;
  source: "workspace" | "recent";
  score: number;
  matchedAlias?: string;
  matchedTag?: string;
  matchKind?: "name" | "alias" | "tag" | "path";
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
  workspacePath?: string;
  splitLayout?: SessionSplitLayoutState;
}

export interface SessionSplitLayoutState {
  enabled: boolean;
  activePaneId: EditorPaneId;
  mainTabKeys: string[];
  secondaryTabKeys: string[];
  mainActiveTabKey?: string;
  secondaryActiveTabKey?: string;
  ratio: number;
}

export interface SplitLayoutState {
  enabled: boolean;
  activePaneId: EditorPaneId;
  mainTabId: string;
  secondaryTabId: string;
  mainTabIds: string[];
  secondaryTabIds: string[];
  ratio: number;
}

export interface SessionTabState {
  path: string;
  kind: Extract<DocumentTabKind, "normal" | "large">;
  editorMode: EditorMode;
  lastActiveAt: number;
  position?: EditorPositionSnapshot;
  collapsedOutlineKeys?: string[];
  collapsedHeadingKeys?: string[];
}

export interface ClosedTabRecord {
  path: string;
  kind: Extract<DocumentTabKind, "normal" | "large">;
  editorMode: EditorMode;
  closedAt: number;
}

export interface NavigationLocation {
  path: string;
  documentMode: DocumentMode;
  editorMode: EditorMode;
  paneId?: EditorPaneId;
  line?: number;
  anchor?: number;
  position?: EditorPositionSnapshot;
  recordedAt: number;
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
  snippets: SnippetSettings;
}

export interface SnippetDefinition {
  id: string;
  name: string;
  trigger: string;
  description: string;
  markdown: string;
  enabled: boolean;
}

export interface SnippetSettings {
  items: SnippetDefinition[];
}

export interface SnippetExpansionContext {
  selection: string;
  now?: Date;
}

export interface SnippetExpansionResult {
  markdown: string;
  cursorOffset: number;
  usedSelection: boolean;
}

export interface SlashCommandDefinition {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  category: "基础" | "结构" | "插入" | "警示框" | "片段";
  kind: "builtin" | "snippet";
  action?: string;
  value?: string | number;
  snippetId?: string;
}

export interface CapturedEditorTarget {
  paneId: EditorPaneId;
  tabId: string;
  documentMode: DocumentMode;
  editorMode: EditorMode;
  anchor: number;
  head: number;
  selection: string;
  capturedAt: number;
  large?: {
    sessionId: string;
    revision: number;
    inputVersion?: number;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  };
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
  mathNumbering: "none" | "ams-block" | "all-display";
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
  pasteCompressionEnabled: boolean;
  pasteCompressionThresholdBytes: number;
  pasteCompressionMaxDimension: number;
  pasteCompressionQuality: number;
  pastedImageNaming: PastedImageNaming;
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
  sidebarPreference?: "auto" | "shown" | "hidden";
  showOutline: boolean;
}

export interface ExportSettings {
  defaultFolder: ExportDefaultFolder;
  customFolder: string;
  htmlTheme: "current" | "light" | "dark";
  htmlIncludeStyles: boolean;
  includeYamlFrontMatter: boolean;
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
  pandocMarkdown?: string;
  pandocLatexHeader?: string;
  rasterWidth?: number;
  rasterHeight?: number;
  outputPath?: string;
  overwrite?: boolean;
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
  line: number;
}

export interface FileInfo {
  path: string;
  sizeBytes: number;
  lineCount: number;
  isLarge: boolean;
  encoding: string;
}

export const LARGE_COORDINATE_SPACE = "utf16-code-units" as const;
export type LargeCoordinateSpace = typeof LARGE_COORDINATE_SPACE;

export interface LargeOutlineItem extends OutlineItem {
}

export interface LargeFileFingerprint {
  sizeBytes: number;
  modifiedMillis: number | null;
  sha256: string;
}

export type LargeFileTransactionOutcome =
  | "committed"
  | "conflict"
  | "not-committed"
  | "ambiguous";

export type LargeFileDiskWriteStatus = "yes" | "no" | "unknown";

/** Atomic text-file read returned by the Rust transaction boundary. */
export interface TextFileSnapshot {
  content: string;
  fingerprint: LargeFileFingerprint;
}

/** Structured write evidence; a receipt can still carry cleanup warnings. */
export interface TextFileWriteReceipt {
  path: string;
  outcome: LargeFileTransactionOutcome;
  diskWritten: LargeFileDiskWriteStatus;
  /** Observed target after the OS call; a committed receipt's disk baseline. */
  targetFingerprint?: LargeFileFingerprint | null;
  /** Independent recovery copy; equal bytes can have a different modification time. */
  outputFingerprint?: LargeFileFingerprint | null;
  recoveryArtifact?: string;
  cleanupWarning?: string;
}

export interface LargeFileSession {
  sessionId: string;
  path: string;
  sizeBytes: number;
  totalLines: number;
  outline: LargeOutlineItem[];
  revision: number;
  savedRevision: number;
  pendingEditCount: number;
  baseFingerprint: LargeFileFingerprint;
  /** Null while a recovered untitled session has no writable target. */
  diskFingerprint: LargeFileFingerprint | null;
  coordinateSpace: LargeCoordinateSpace;
  /** Empty for a recovered untitled view; provenance is retained separately. */
  targetPath?: string | null;
  originPath?: string;
  recoveryDraftId?: string;
}

export interface FileChunk {
  sessionId: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  revision: number;
  coordinateSpace: LargeCoordinateSpace;
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
  revision: number;
  savedRevision: number;
  coordinateSpace: LargeCoordinateSpace;
}

export interface LargeSaveReceipt {
  sessionId: string;
  requestedRevision: number;
  savedRevision: number;
  currentRevision: number;
  saved: boolean;
  isDirty: boolean;
  pendingEditCount: number;
  path: string;
  baseFingerprint: LargeFileFingerprint;
  diskFingerprint: LargeFileFingerprint;
  coordinateSpace: LargeCoordinateSpace;
  outcome: LargeFileTransactionOutcome;
  diskWritten: LargeFileDiskWriteStatus;
  targetFingerprint?: LargeFileFingerprint | null;
  outputFingerprint?: LargeFileFingerprint | null;
  recoveryArtifact?: string;
  cleanupWarning?: string;
}

export interface LargeCloseReceipt {
  sessionId: string;
  closed: boolean;
  cleanupCompleted: boolean;
  recoveryArtifact?: string;
  cleanupWarning?: string;
}

export interface LargeDraftSnapshotRef {
  schemaVersion: number;
  snapshotId: string;
  draftId: string;
  originPath: string;
  originFingerprint: LargeFileFingerprint;
  capturedRevision: number;
  coordinateSpace: LargeCoordinateSpace;
  byteLength: number;
  totalLines: number;
  sha256: string;
}

export interface LargeDraftCaptureReceipt {
  sessionId: string;
  requestedRevision: number;
  currentRevision: number;
  snapshot: LargeDraftSnapshotRef;
}

export interface LargeDraftOpenReceipt {
  snapshot: LargeDraftSnapshotRef;
  session: LargeFileSession;
  originPath: string;
  targetPath: null;
  recoveryDraftId: string;
}

export interface LargeDraftDeleteReceipt {
  snapshotId: string;
  deleted: boolean;
  cleanupWarning?: string;
}

export interface DraftRecord {
  id: string;
  kind: "file" | "untitled" | "large";
  schemaVersion?: number;
  path?: string;
  content?: string;
  pendingEdits?: TextEdit[];
  largeSnapshot?: LargeDraftSnapshotRef;
  fileMtime?: number;
  fileSize?: number;
  updatedAt: number;
  editorMode?: EditorMode;
}

export interface DraftListIssue {
  path: string;
  code: string;
  message: string;
}

export interface DraftListReceipt {
  records: DraftRecord[];
  issues: DraftListIssue[];
}

export interface FileSnapshot {
  exists: boolean;
  mtime?: number;
  size?: number;
  fingerprint?: LargeFileFingerprint;
}

export interface SimilarFileCandidate {
  path: string;
  name: string;
  mtime?: number;
  size: number;
}

export interface LargeFindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface LargeFindMatch {
  line: number;
  /** Present for a regular expression match crossing logical line boundaries. */
  endLine?: number;
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
  revision: number;
  coordinateSpace: LargeCoordinateSpace;
}

export interface LargeFileState {
  sessionId: string;
  sizeBytes: number;
  totalLines: number;
  loadedRanges: Array<{ startLine: number; endLine: number }>;
  pendingEdits: TextEdit[];
  outline: LargeOutlineItem[];
  revision: number;
  savedRevision: number;
  pendingEditCount: number;
  baseFingerprint: LargeFileFingerprint;
  /** Null while a recovered untitled session has no writable target. */
  diskFingerprint: LargeFileFingerprint | null;
  coordinateSpace: LargeCoordinateSpace;
  targetPath?: string | null;
  originPath?: string;
  recoveryDraftId?: string;
}

export interface WysiwygFormatHistoryEntry {
  before: string;
  after: string;
  beforeAnchor: number;
  beforeHead: number;
  afterAnchor: number;
  afterHead: number;
}

export interface WysiwygFormatHistory {
  undo: WysiwygFormatHistoryEntry[];
  redo: WysiwygFormatHistoryEntry[];
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
  collapsedOutlineKeys: string[];
  collapsedHeadingKeys: string[];
  /**
   * Runtime-only exact Markdown snapshots for formatter undo/redo.
   * ProseMirror cannot represent trailing spaces and excess blank lines, so
   * those source details must not be delegated to its semantic history.
   */
  wysiwygFormatHistory: WysiwygFormatHistory;
  position?: EditorPositionSnapshot;
  fileSnapshot?: FileSnapshot;
  externalState: ExternalFileState;
  externalSnapshot?: FileSnapshot;
  relocationCandidates?: SimilarFileCandidate[];
  externalDetectedAt?: number;
  externalDismissedKey?: string;
  draftId?: string;
  openedAt: number;
  lastActiveAt: number;
}
