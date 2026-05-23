export type EditorMode = "wysiwyg" | "source";
export type ThemeMode = "light" | "dark" | "system";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface AppConfig {
  recentFiles: string[];
  lastWorkspace: string | null;
  theme: ThemeMode;
}

export interface OutlineItem {
  id: string;
  text: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
}
