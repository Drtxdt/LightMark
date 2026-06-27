<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { appStore, applyLargeFileEdits, readLargeFileChunk } from "../../stores/appStore";
import { findOptions, findReplaceStore, setFindResult } from "../../stores/findReplaceStore";
import type { DirtyState, LargeFindMatch, LargeFindResult, LargeOutlineItem, TextEdit } from "../../types";
import { renderMarkdownForEditor } from "../../utils/markdown";

type LineRecord = {
  line: number;
  text: string;
};

type MarkdownBlock = {
  key: string;
  startLine: number;
  endLine: number;
  lines: string[];
  text: string;
  html: string;
};

const lineHeight = 28;
const viewportBufferLines = 90;
const reloadMarginLines = 32;
const chunkLineCount = 420;
const maxRenderCacheEntries = 800;
const scroller = ref<HTMLElement | null>(null);
const loadedLines = shallowRef<LineRecord[]>([]);
const viewportStartLine = ref(0);
const editingKey = ref("");
const editingText = ref("");
const loading = ref(false);
const largeFindMatches = ref<LargeFindMatch[]>([]);
const largeFindTruncated = ref(false);
const loadedStartLine = ref(0);
const loadedEndLine = ref(0);
let activeRequestId = 0;
let queuedStartLine: number | null = null;
let scrollFrame = 0;
const renderCache = new Map<string, string>();
const findCommandListener = (event: Event) => {
  void handleFindCommand(event as CustomEvent<string>);
};

const largeFile = computed(() => appStore.largeFile);
const totalLines = computed(() => largeFile.value?.totalLines ?? 0);
const totalHeight = computed(() => Math.max(totalLines.value * lineHeight, 1));
const spacerTop = computed(() => Math.max(firstLoadedLine.value * lineHeight, 0));
const firstLoadedLine = computed(() => loadedLines.value[0]?.line ?? viewportStartLine.value);

const blocks = computed(() => buildBlocks(loadedLines.value));

watch(
  () => largeFile.value?.sessionId,
  () => {
    activeRequestId += 1;
    queuedStartLine = null;
    loading.value = false;
    loadedLines.value = [];
    viewportStartLine.value = 0;
    loadedStartLine.value = 0;
    loadedEndLine.value = 0;
    editingKey.value = "";
    renderCache.clear();
    void loadAround(0);
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener("lightmark:jump-line", handleJumpLine as EventListener);
  window.addEventListener("lightmark:find-command", findCommandListener);
});

onUnmounted(() => {
  window.removeEventListener("lightmark:jump-line", handleJumpLine as EventListener);
  window.removeEventListener("lightmark:find-command", findCommandListener);
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
});

function onScroll() {
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(syncViewportFromScroll);
}

function syncViewportFromScroll() {
  scrollFrame = 0;
  if (!scroller.value) return;
  const visibleLine = Math.max(0, Math.floor(scroller.value.scrollTop / lineHeight));
  const nextStart = Math.max(0, visibleLine - viewportBufferLines);
  if (Math.abs(nextStart - viewportStartLine.value) < reloadMarginLines && isLineWindowCovered(visibleLine)) return;
  viewportStartLine.value = nextStart;
  if (!isLineWindowCovered(visibleLine)) void loadAround(nextStart);
}

async function loadAround(startLine: number) {
  if (!largeFile.value) return;
  const sessionId = largeFile.value.sessionId;
  const boundedStart = Math.max(0, Math.min(startLine, Math.max(largeFile.value.totalLines - 1, 0)));
  if (loading.value) {
    queuedStartLine = boundedStart;
    return;
  }
  const requestId = ++activeRequestId;
  loading.value = true;
  try {
    const chunk = await readLargeFileChunk(boundedStart, chunkLineCount);
    if (requestId !== activeRequestId || largeFile.value?.sessionId !== sessionId) return;
    const lines = chunk.text.split(/\r?\n/).slice(0, chunk.endLine - chunk.startLine);
    loadedStartLine.value = chunk.startLine;
    loadedEndLine.value = chunk.endLine;
    loadedLines.value = lines.map((text, index) => ({ line: chunk.startLine + index, text }));
    pruneRenderCache();
  } catch (error) {
    appStore.statusMessage = String(error);
  } finally {
    if (requestId === activeRequestId) {
      loading.value = false;
      const queued = queuedStartLine;
      queuedStartLine = null;
      if (queued !== null && !isLoadedStartNear(queued)) void loadAround(queued);
    }
  }
}

function isLineWindowCovered(visibleLine: number) {
  if (loadedLines.value.length === 0) return false;
  const minLine = Math.max(0, visibleLine - reloadMarginLines);
  const maxLine = Math.min(Math.max(totalLines.value - 1, 0), visibleLine + viewportBufferLines);
  return minLine >= loadedStartLine.value && maxLine < loadedEndLine.value;
}

function isLoadedStartNear(startLine: number) {
  return loadedLines.value.length > 0 && Math.abs(startLine - loadedStartLine.value) < reloadMarginLines;
}

function buildBlocks(lines: LineRecord[]) {
  const result: MarkdownBlock[] = [];
  let current: LineRecord[] = [];
  let inFence = false;
  let inTable = false;

  const flush = () => {
    if (current.length === 0) return;
    const startLine = current[0].line;
    const endLine = current[current.length - 1].line;
    const blockLines = current.map((line) => line.text);
    result.push({
      key: `${startLine}-${endLine}`,
      startLine,
      endLine,
      lines: blockLines,
      text: blockLines.join("\n"),
      html: cachedRenderBlock(startLine, endLine, blockLines.join("\n")),
    });
    current = [];
  };

  for (const line of lines) {
    const fence = line.text.trimStart().startsWith("```");
    const tableRow = isTableRow(line.text);
    if (!inFence && line.text.trim() === "") {
      flush();
      inTable = false;
      result.push({
        key: `blank-${line.line}`,
        startLine: line.line,
        endLine: line.line,
        lines: [""],
        text: "",
        html: "",
      });
      continue;
    }
    if (!inFence && tableRow) {
      current.push(line);
      inTable = true;
      continue;
    }
    if (inTable) {
      flush();
      inTable = false;
    }
    current.push(line);
    if (fence) {
      inFence = !inFence;
      if (!inFence) flush();
    } else if (!inFence && /^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s)/.test(line.text.trimStart())) {
      flush();
    }
  }
  flush();
  return result;
}

function startEditing(block: MarkdownBlock) {
  if (block.text === "") return;
  editingKey.value = block.key;
  editingText.value = block.text;
  void nextTick(() => {
    document.querySelector<HTMLTextAreaElement>("[data-large-editor-input]")?.focus();
  });
}

async function commitEditing(block: MarkdownBlock) {
  if (editingKey.value !== block.key) return;
  const nextText = editingText.value;
  editingKey.value = "";
  if (nextText === block.text) return;

  const edit = blockEdit(block, nextText);
  applyLocalEdit(edit);
  updateLargeOutline(edit, block.text);
  await applyLargeFileEdits([edit]);
}

async function toggleTask(line: number) {
  const record = loadedLines.value.find((item) => item.line === line);
  if (!record) return;
  const next = record.text.replace(/^(\s*[-*+]\s+\[)( |x|X)(\]\s*)/, (_match, prefix, checked, suffix) => {
    return `${prefix}${checked === " " ? "x" : " "}${suffix}`;
  });
  if (next === record.text) return;
  const edit: TextEdit = {
    startLine: line,
    startColumn: 0,
    endLine: line,
    endColumn: record.text.length,
    text: next,
  };
  applyLocalEdit(edit);
  await applyLargeFileEdits([edit]);
}

async function handleFindCommand(event: CustomEvent<string>) {
  if (appStore.documentMode !== "large" || !largeFile.value) return;
  const command = event.detail || "refresh";
  if (command === "next" || command === "previous") {
    await navigateLargeFind(command === "next" ? 1 : -1);
    return;
  }
  if (command === "replaceCurrent") {
    await replaceLargeFind(true);
    return;
  }
  if (command === "replaceAll") {
    await replaceLargeFind(false);
    return;
  }
  await refreshLargeFind();
}

async function refreshLargeFind() {
  if (!largeFile.value || !findReplaceStore.open || !findReplaceStore.query) {
    largeFindMatches.value = [];
    largeFindTruncated.value = false;
    setFindResult(0, -1, "");
    return;
  }
  findReplaceStore.busy = true;
  try {
    const result = await invoke<LargeFindResult>("search_large_file", {
      sessionId: largeFile.value.sessionId,
      query: findReplaceStore.query,
      options: findOptions(),
      startLine: 0,
      limit: 5000,
    });
    largeFindMatches.value = result.matches;
    largeFindTruncated.value = result.truncated;
    const current = findReplaceStore.currentIndex < 0 ? 0 : normalizeLargeFindIndex(findReplaceStore.currentIndex, result.matches.length);
    setFindResult(result.total, current, result.error);
    if (result.truncated) appStore.statusMessage = "查找结果较多，仅加载前 5000 项用于跳转。";
  } catch (error) {
    setFindResult(0, -1, String(error));
  } finally {
    findReplaceStore.busy = false;
  }
}

async function navigateLargeFind(delta: 1 | -1) {
  if (!largeFile.value) return;
  if (largeFindMatches.value.length === 0 || findReplaceStore.error) await refreshLargeFind();
  if (largeFindMatches.value.length === 0 || findReplaceStore.error) return;
  const current = normalizeLargeFindIndex(findReplaceStore.currentIndex + delta, largeFindMatches.value.length);
  const match = largeFindMatches.value[current];
  setFindResult(findReplaceStore.total, current, "");
  viewportStartLine.value = Math.max(0, match.line - 20);
  if (scroller.value) scroller.value.scrollTop = Math.max(0, match.line - 6) * lineHeight;
  await loadAround(viewportStartLine.value);
}

async function replaceLargeFind(currentOnly: boolean) {
  if (!largeFile.value) return;
  if (currentOnly && largeFindMatches.value.length === 0) await refreshLargeFind();
  const current = normalizeLargeFindIndex(findReplaceStore.currentIndex, largeFindMatches.value.length);
  const match = currentOnly ? largeFindMatches.value[current] : null;
  if (currentOnly && !match) return;
  findReplaceStore.busy = true;
  try {
    const state = await invoke<DirtyState>("replace_large_file_matches", {
      sessionId: largeFile.value.sessionId,
      query: findReplaceStore.query,
      replacement: findReplaceStore.replaceText,
      options: findOptions(),
      currentMatch: match,
    });
    appStore.isDirty = state.isDirty;
    appStore.statusMessage = currentOnly ? "已替换当前匹配" : `已登记全部替换，待保存编辑：${state.pendingEditCount}`;
    renderCache.clear();
    await refreshLargeFind();
    await loadAround(viewportStartLine.value);
  } catch (error) {
    setFindResult(findReplaceStore.total, findReplaceStore.currentIndex, String(error));
  } finally {
    findReplaceStore.busy = false;
  }
}

function normalizeLargeFindIndex(index: number, total: number) {
  if (total <= 0) return -1;
  return ((index % total) + total) % total;
}

function blockFindClass(block: MarkdownBlock) {
  if (!findReplaceStore.open || largeFindMatches.value.length === 0) return "";
  const current = largeFindMatches.value[normalizeLargeFindIndex(findReplaceStore.currentIndex, largeFindMatches.value.length)];
  if (current && current.line >= block.startLine && current.line <= block.endLine) return "large-doc-block-current-find";
  return largeFindMatches.value.some((item) => item.line >= block.startLine && item.line <= block.endLine)
    ? "large-doc-block-find"
    : "";
}

function blockEdit(block: MarkdownBlock, text: string): TextEdit {
  return {
    startLine: block.startLine,
    startColumn: 0,
    endLine: block.endLine,
    endColumn: block.lines[block.lines.length - 1]?.length ?? 0,
    text,
  };
}

function applyLocalEdit(edit: TextEdit) {
  const oldLineCount = edit.endLine - edit.startLine + 1;
  const rawNextLines = edit.text.split(/\r?\n/);
  const lineDelta = rawNextLines.length - oldLineCount;
  const nextLines = edit.text.split(/\r?\n/).map((text, index) => ({
    line: edit.startLine + index,
    text,
  }));
  loadedLines.value = [
    ...loadedLines.value.filter((line) => line.line < edit.startLine),
    ...nextLines,
    ...loadedLines.value
      .filter((line) => line.line > edit.endLine)
      .map((line) => ({ ...line, line: line.line + lineDelta })),
  ];
  loadedEndLine.value = Math.max(loadedStartLine.value, loadedEndLine.value + lineDelta);
  renderCache.clear();
}

function updateLargeOutline(edit: TextEdit, previousText: string) {
  if (!appStore.largeFile) return;
  const lineDelta = edit.text.split(/\r?\n/).length - previousText.split(/\r?\n/).length;
  const replacementItems = parseOutlineItems(edit.text, edit.startLine);
  const nextOutline = appStore.largeFile.outline
    .filter((item) => item.line < edit.startLine || item.line > edit.endLine)
    .map((item) => {
      if (item.line <= edit.endLine || lineDelta === 0) return item;
      return { ...item, line: item.line + lineDelta, id: `large-heading-${item.line + lineDelta}` };
    });
  nextOutline.push(...replacementItems);
  nextOutline.sort((a, b) => a.line - b.line);
  appStore.largeFile.outline = nextOutline;
  appStore.largeFile.totalLines = Math.max(0, appStore.largeFile.totalLines + lineDelta);
}

function cachedRenderBlock(startLine: number, endLine: number, text: string) {
  if (!text) return "";
  const key = `${startLine}-${endLine}:${text}`;
  const cached = renderCache.get(key);
  if (cached !== undefined) return cached;
  const html = renderMarkdownForEditor(text);
  renderCache.set(key, html);
  return html;
}

function pruneRenderCache() {
  if (renderCache.size <= maxRenderCacheEntries) return;
  const overflow = renderCache.size - maxRenderCacheEntries;
  let removed = 0;
  for (const key of renderCache.keys()) {
    renderCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function taskLine(block: MarkdownBlock) {
  if (block.startLine !== block.endLine) return null;
  return /^\s*[-*+]\s+\[[ xX]\]\s+/.test(block.text) ? block.startLine : null;
}

function isTableRow(text: string) {
  const trimmed = text.trim();
  return trimmed.includes("|") && /^:?-{3,}:?$/.test(trimmed.replace(/\|/g, "").replace(/\s+/g, "")) || /^\|.*\|$/.test(trimmed);
}

function parseOutlineItems(markdown: string, startLine: number): LargeOutlineItem[] {
  return markdown
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.trimStart().match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (!match) return null;
      const text = match[2].trim();
      if (!text) return null;
      const lineNumber = startLine + index;
      return {
        id: `large-heading-${lineNumber}`,
        text,
        level: match[1].length as LargeOutlineItem["level"],
        line: lineNumber,
      };
    })
    .filter((item): item is LargeOutlineItem => Boolean(item));
}

function handleJumpLine(event: CustomEvent<number>) {
  const line = Math.max(0, Math.min(event.detail, Math.max(totalLines.value - 1, 0)));
  if (scroller.value) {
    scroller.value.scrollTop = line * lineHeight;
  }
  viewportStartLine.value = Math.max(0, line - 20);
  void loadAround(viewportStartLine.value);
}
</script>

<template>
  <section class="flex h-full flex-col bg-paper-50 dark:bg-paper-950">
    <div class="flex h-10 items-center gap-3 border-b border-paper-200 px-4 text-xs text-ink-500 dark:border-paper-800 dark:text-ink-300">
      <span>Large Document Mode</span>
      <span>{{ totalLines }} 行</span>
      <span v-if="loading">加载中...</span>
    </div>
    <div ref="scroller" class="large-doc-scroll min-h-0 flex-1 overflow-auto" @scroll="onScroll">
      <div class="relative mx-auto max-w-4xl px-8 py-6" :style="{ height: `${totalHeight}px` }">
        <div class="absolute left-8 right-8" :style="{ transform: `translateY(${spacerTop}px)` }">
          <article
            v-for="block in blocks"
            :key="block.key"
            class="large-doc-block group"
            :class="blockFindClass(block)"
            :data-line-start="block.startLine"
            @dblclick="startEditing(block)"
          >
            <textarea
              v-if="editingKey === block.key"
              v-model="editingText"
              data-large-editor-input
              class="large-doc-input"
              spellcheck="false"
              @blur="commitEditing(block)"
              @keydown.ctrl.enter.prevent="commitEditing(block)"
            />
            <div v-else class="large-doc-render prose prose-stone max-w-none dark:prose-invert" @click="taskLine(block) !== null && toggleTask(taskLine(block)!)" v-html="block.html || '&nbsp;'" />
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.large-doc-scroll {
  scrollbar-gutter: stable;
  overflow-anchor: none;
}

.large-doc-block {
  min-height: 28px;
  border-radius: 6px;
  padding: 2px 8px;
  contain: layout paint;
}

.large-doc-block:hover {
  background: rgba(214, 211, 205, 0.24);
}

.large-doc-block-find {
  background: rgba(80, 120, 180, 0.09);
}

.large-doc-block-current-find {
  background: rgba(70, 116, 190, 0.17);
  box-shadow: inset 3px 0 0 rgba(70, 116, 190, 0.72);
}

.large-doc-render :deep(*) {
  margin-top: 0.35em;
  margin-bottom: 0.35em;
}

.large-doc-render {
  min-height: 24px;
  overflow-wrap: anywhere;
  word-break: normal;
}

.large-doc-render :deep(pre) {
  overflow-x: hidden;
  border-radius: 6px;
  padding: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.large-doc-render :deep(pre code) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.large-doc-render :deep(table) {
  display: table;
  width: 100%;
  max-width: 100%;
  table-layout: auto;
  overflow-x: hidden;
}

.large-doc-render :deep(th),
.large-doc-render :deep(td) {
  max-width: min(52rem, 100%);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.large-doc-render :deep(input[type="checkbox"]) {
  margin-right: 0.5rem;
}

.large-doc-input {
  min-height: 7rem;
  width: 100%;
  resize: vertical;
  border-radius: 6px;
  border: 1px solid rgb(168 162 158);
  background: rgb(255 255 255);
  padding: 0.75rem;
  font: 14px/1.6 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  color: rgb(41 37 36);
  outline: none;
}

:global(.dark) .large-doc-input {
  border-color: rgb(68 64 60);
  background: rgb(28 25 23);
  color: rgb(245 245 244);
}
</style>
