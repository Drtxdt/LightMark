<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { appStore, setPaneContent } from "../../stores/appStore";
import { extractAssetReferences, replaceAssetReference, type AssetReference } from "../../utils/documentAssets";
import type { MarkdownFormatResult } from "../../utils/markdownFormat";

interface AssetFileInfo {
  source: string;
  path: string;
  name: string;
  exists: boolean;
  size?: number;
  kind: string;
}
interface AssetInspection {
  assetFolder: string;
  references: AssetFileInfo[];
  folderFiles: AssetFileInfo[];
}
interface ReferenceRow extends AssetReference {
  info: AssetFileInfo | null;
}

const tab = ref<"references" | "missing" | "unreferenced">("references");
const busy = ref(false);
const error = ref("");
const inspection = ref<AssetInspection | null>(null);
const references = ref<ReferenceRow[]>([]);
let refreshTimer = 0;
let generation = 0;
let unlisten: UnlistenFn | null = null;

const missing = computed(() => references.value.filter((item) => !item.external && item.info && !item.info.exists));
const referencedPaths = computed(() => new Set(references.value.filter((item) => item.info?.exists).map((item) => normalizePath(item.info!.path))));
const unreferenced = computed(() => (inspection.value?.folderFiles || []).filter((item) => !referencedPaths.value.has(normalizePath(item.path))));
const visibleReferences = computed(() => tab.value === "missing" ? missing.value : references.value);
const unavailableMessage = computed(() => {
  if (!appStore.currentFilePath) return "请先保存或打开一个 Markdown 文档。";
  if (appStore.documentMode === "large") return "大文件模式暂不支持附件索引。";
  return "";
});

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 220);
}

async function refresh() {
  const path = appStore.currentFilePath;
  if (!path || appStore.documentMode === "large") {
    inspection.value = null;
    references.value = [];
    return;
  }
  const currentGeneration = ++generation;
  busy.value = true;
  error.value = "";
  const parsed = extractAssetReferences(appStore.currentContent);
  try {
    const local = parsed.filter((item) => !item.external);
    const result = await invoke<AssetInspection>("inspect_document_assets", {
      markdownPath: path,
      assetFolder: appStore.settings.image.assetFolder || "assets",
      sources: local.map((item) => item.source),
    });
    if (currentGeneration !== generation) return;
    let localIndex = 0;
    references.value = parsed.map((item) => ({
      ...item,
      info: item.external ? null : result.references[localIndex++] || null,
    }));
    inspection.value = result;
    await invoke("watch_asset_folder", {
      markdownPath: path,
      assetFolder: appStore.settings.image.assetFolder || "assets",
    }).catch(() => {});
  } catch (cause) {
    if (currentGeneration === generation) error.value = String(cause);
  } finally {
    if (currentGeneration === generation) busy.value = false;
  }
}

function locate(item: AssetReference) {
  window.dispatchEvent(new CustomEvent("lightmark:jump-knowledge-occurrence", {
    detail: {
      path: appStore.currentFilePath,
      paneId: appStore.splitLayout.activePaneId,
      line: item.line,
      from: item.from,
      to: item.to,
    },
  }));
}

async function relink(item: ReferenceRow) {
  const selected = await invoke<string | null>("open_asset_file_dialog");
  if (!selected) return;
  const nextSource = await invoke<string>("asset_path_to_reference", {
    markdownPath: appStore.currentFilePath,
    path: selected,
    useRelativePath: appStore.settings.image.useRelativePath,
    ensureDotSlash: appStore.settings.image.ensureDotSlash,
    escapePath: appStore.settings.image.escapePath,
  });
  const source = appStore.currentContent;
  const next = replaceAssetReference(source, item, nextSource);
  if (next == null) {
    appStore.statusMessage = "该资源引用位置已经变化，资源索引已刷新，请重新选择。";
    await refresh();
    return;
  }
  const lineMap = source.split(/\r?\n/).map((_, index) => index);
  const result: MarkdownFormatResult = {
    text: next,
    changed: true,
    stats: { changedLines: 1, tablesFormatted: 0, listIndentationFixed: 0, trailingWhitespaceRemoved: 0, blankLinesRemoved: 0 },
    lineMap,
  };
  const detail = { paneId: appStore.splitLayout.activePaneId, source, result, handled: false };
  window.dispatchEvent(new CustomEvent("lightmark:apply-markdown-format", { detail }));
  if (!detail.handled) setPaneContent(appStore.splitLayout.activePaneId, next, true);
  appStore.statusMessage = `已重新链接 ${item.source}，尚未保存。`;
  scheduleRefresh();
}

async function copyPath(path: string) {
  await navigator.clipboard.writeText(path);
  appStore.statusMessage = "资源路径已复制。";
}

function formatSize(value?: number) {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").toLocaleLowerCase();
}

watch(
  () => [appStore.currentFilePath, appStore.currentContent, appStore.documentMode, appStore.settings.image.assetFolder] as const,
  scheduleRefresh,
  { immediate: true },
);

onMounted(async () => {
  unlisten = await listen("lightmark-asset-watch-event", scheduleRefresh);
});

onBeforeUnmount(() => {
  window.clearTimeout(refreshTimer);
  unlisten?.();
  void invoke("unwatch_asset_folder").catch(() => {});
});
</script>

<template>
  <div class="resources-pane">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 class="text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">当前文档资源</h2>
      <button class="btn-small" :disabled="busy || !!unavailableMessage" @click="refresh()">刷新</button>
    </div>
    <p v-if="unavailableMessage" class="resource-state">{{ unavailableMessage }}</p>
    <template v-else>
      <div class="resource-tabs mb-3 grid grid-cols-3 gap-1 p-1">
        <button :class="{ active: tab === 'references' }" @click="tab = 'references'">引用 <span>{{ references.length }}</span></button>
        <button :class="{ active: tab === 'missing' }" @click="tab = 'missing'">缺失 <span>{{ missing.length }}</span></button>
        <button :class="{ active: tab === 'unreferenced' }" @click="tab = 'unreferenced'">未引用 <span>{{ unreferenced.length }}</span></button>
      </div>
      <p v-if="busy" class="resource-state">正在检查附件...</p>
      <p v-else-if="error" class="resource-state text-red-600 dark:text-red-300">{{ error }}</p>
      <template v-else-if="tab !== 'unreferenced'">
        <p v-if="visibleReferences.length === 0" class="resource-state">{{ tab === "missing" ? "没有缺失资源。" : "当前文档没有附件引用。" }}</p>
        <article v-for="item in visibleReferences" :key="`${item.from}:${item.source}`" class="resource-card">
          <button class="resource-main" @click="locate(item)">
            <span class="resource-name">{{ item.info?.name || item.source }}</span>
            <span class="resource-meta">L{{ item.line + 1 }} · {{ item.kind }} · {{ item.external ? "外部" : item.info?.exists ? formatSize(item.info.size) : "缺失" }}</span>
            <span class="resource-path">{{ item.source }}</span>
          </button>
          <div class="resource-actions">
            <button v-if="item.info?.exists" @click="openPath(item.info.path)">打开</button>
            <button v-if="item.info?.path" @click="copyPath(item.info.path)">复制</button>
            <button v-if="!item.external" @click="relink(item)">重链</button>
          </div>
        </article>
      </template>
      <template v-else>
        <p class="resource-hint">以下文件仅表示“当前文档未引用”，可能仍被其他文档使用。</p>
        <p v-if="unreferenced.length === 0" class="resource-state">附件目录中没有当前文档未引用的资源。</p>
        <article v-for="item in unreferenced" :key="item.path" class="resource-card">
          <div class="resource-main">
            <span class="resource-name">{{ item.name }}</span>
            <span class="resource-meta">{{ item.kind }} · {{ formatSize(item.size) }}</span>
            <span class="resource-path">{{ item.path }}</span>
          </div>
          <div class="resource-actions">
            <button @click="openPath(item.path)">打开</button>
            <button @click="revealItemInDir(item.path)">文件夹</button>
            <button @click="copyPath(item.path)">复制</button>
          </div>
        </article>
      </template>
    </template>
  </div>
</template>

<style scoped>
.resource-tabs { border-radius: 7px; background: rgba(120, 113, 108, .08); }
.resource-tabs button { min-width: 0; border: 0; border-radius: 5px; background: transparent; padding: 6px 3px; color: #777066; font-size: 11px; }
.resource-tabs button.active { background: rgba(255,255,255,.85); color: #2f2b26; box-shadow: 0 1px 4px rgba(40,35,30,.08); }
.resource-state,.resource-hint { padding: 8px 4px; color: #888076; font-size: 12px; line-height: 1.5; }
.resource-hint { margin-bottom: 8px; border-left: 2px solid rgba(154,106,53,.45); padding-left: 8px; }
.resource-card { margin-bottom: 8px; overflow: hidden; border: 1px solid rgba(120,113,108,.16); border-radius: 7px; background: rgba(255,255,255,.34); }
.resource-main { display: block; width: 100%; min-width: 0; border: 0; background: transparent; padding: 8px; text-align: left; }
button.resource-main { cursor: pointer; }
.resource-name,.resource-meta,.resource-path { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-name { color: #3d3832; font-size: 13px; font-weight: 600; }
.resource-meta,.resource-path { margin-top: 3px; color: #8a8278; font-size: 11px; }
.resource-actions { display: flex; gap: 5px; padding: 0 8px 8px; }
.resource-actions button { border: 0; border-radius: 4px; background: rgba(120,113,108,.09); padding: 3px 7px; color: #6f675d; font-size: 11px; }
:global(.dark) .resource-tabs button.active,:global(.dark) .resource-card { background: rgba(50,47,43,.78); color: #ddd6cc; }
:global(.dark) .resource-name { color: #e4ddd3; }
</style>
