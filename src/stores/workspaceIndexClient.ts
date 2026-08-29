import { invoke } from "@tauri-apps/api/core";
import type { BacklinkItem, KnowledgeTagItem, UnlinkedMentionItem } from "../utils/wikiLinks";

export interface WorkspaceIndexStatus {
  root: string;
  generation: number;
  busy: boolean;
  error?: string | null;
  documentCount: number;
  candidates: Array<{ path: string; name: string; aliases: string[] }>;
}

export interface WorkspaceQueryResponse<T> {
  generation: number;
  documentRevision?: number;
  data: T;
}

export const workspaceIndexClient = {
  open: (root: string) => invoke<WorkspaceIndexStatus>("workspace_index_open", { root }),
  status: () => invoke<WorkspaceIndexStatus>("workspace_index_status"),
  updateOpenDocument: (path: string, revision: number, markdown: string) =>
    invoke<WorkspaceIndexStatus>("workspace_index_update_open_document", { path, revision, markdown }),
  releaseOpenDocument: (path: string) => invoke<void>("workspace_index_release_open_document", { path }),
  tags: () => invoke<WorkspaceQueryResponse<KnowledgeTagItem[]>>("workspace_query_tags"),
  backlinks: (path: string) => invoke<WorkspaceQueryResponse<BacklinkItem[]>>("workspace_query_backlinks", { path }),
  mentions: (path: string) => invoke<WorkspaceQueryResponse<UnlinkedMentionItem[]>>("workspace_query_mentions", { path }),
};
