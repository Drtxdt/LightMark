export type EditorMode = "wysiwyg" | "source";
export type ThemeMode = "light" | "dark" | "system";
export type DocumentMode = "normal" | "large";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface AppConfig {
  recentFiles: string[];
  theme: ThemeMode;
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
