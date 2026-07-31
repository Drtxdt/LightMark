<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  appStore,
  convertUnlinkedMention,
  getPaneStructuredOutline,
  getPaneTab,
  navigateToFilePath,
  navigateToKnowledgeOccurrence,
  openFile,
  openWorkspace,
  reconcilePaneCollapsedHeadings,
  recordNavigationLocation,
  refreshKnowledge,
  refreshKnowledgeIndex,
  revealHeadingAtLine,
  revealPaneOutlineKey,
  setAllPaneOutlineFolds,
  togglePaneOutlineFold,
  workspaceKnowledgeTags,
} from "../../stores/appStore";
import FileTreeNode from "./FileTreeNode.vue";
import { resolveActiveOutlineItem, visibleOutlineItems, type StructuredOutlineItem } from "../../utils/outline";
import UiIcon from "../ui/UiIcon.vue";
import ResourcesPane from "./ResourcesPane.vue";

const activePane = ref<"files" | "outline" | "knowledge" | "resources">("files");
const knowledgeTab = ref<"backlinks" | "mentions" | "tags">("backlinks");
const selectedTag = ref("");
const outlineScroll = ref<HTMLElement | null>(null);
const activeEditorPaneId = computed(() => appStore.splitLayout.activePaneId);
const outline = computed(() => getPaneStructuredOutline(activeEditorPaneId.value));
const outlineTab = computed(() => getPaneTab(activeEditorPaneId.value));
const visibleOutline = computed(() => visibleOutlineItems(outline.value, outlineTab.value?.collapsedOutlineKeys ?? []));
const activeOutlineItem = computed(() => resolveActiveOutlineItem(
  outline.value,
  appStore.paneOutlineAnchorLines[activeEditorPaneId.value],
));
const allOutlineCollapsed = computed(() => {
  const branchKeys = outline.value.filter((item) => item.hasChildren).map((item) => item.key);
  const collapsed = new Set(outlineTab.value?.collapsedOutlineKeys ?? []);
  return branchKeys.length > 0 && branchKeys.every((key) => collapsed.has(key));
});

watch(
  () => appStore.settings.appearance.showOutline,
  (showOutline) => {
    if (!showOutline && activePane.value === "outline") activePane.value = "files";
  },
);

watch(
  () => [appStore.currentFilePath, appStore.fileTree.length, activePane.value] as const,
  () => {
    appStore.wikiBacklinksOpen = activePane.value === "knowledge";
    if (appStore.wikiBacklinksOpen) void refreshKnowledge();
  },
  { immediate: true },
);

watch(
  () => appStore.currentWorkspace,
  (workspace) => {
    if (!workspace && activePane.value === "knowledge") activePane.value = "files";
  },
);

watch(
  () => [outlineTab.value?.id, outlineTab.value?.content, outline.value.length] as const,
  () => reconcilePaneCollapsedHeadings(activeEditorPaneId.value),
);

watch(
  () => activeOutlineItem.value?.key ?? "",
  async (key) => {
    if (!key) return;
    revealPaneOutlineKey(activeEditorPaneId.value, key);
    if (activePane.value !== "outline") return;
    await nextTick();
    const target = outlineScroll.value?.querySelector<HTMLElement>(`[data-outline-key="${cssEscape(key)}"]`);
    target?.scrollIntoView({ block: "nearest" });
  },
);

const selectedTagItem = computed(() => workspaceKnowledgeTags.value.find((item) => item.normalizedName === selectedTag.value) ?? null);

async function selectFile(path: string) {
  await openFile(path);
}

async function locateBacklink(item: (typeof appStore.wikiBacklinks)[number]) {
  await navigateToKnowledgeOccurrence(item);
}

async function locateMention(item: (typeof appStore.wikiUnlinkedMentions)[number]) {
  await navigateToKnowledgeOccurrence(item);
}

async function convertMention(item: (typeof appStore.wikiUnlinkedMentions)[number]) {
  await convertUnlinkedMention(item);
}

async function openTagDocument(path: string) {
  await navigateToFilePath(path);
}

function selectTag(normalizedName: string) {
  selectedTag.value = selectedTag.value === normalizedName ? "" : normalizedName;
}

function displayPath(path: string) {
  const root = appStore.currentWorkspace.replace(/\\/g, "/").replace(/\/$/, "");
  const normalized = path.replace(/\\/g, "/");
  return root && normalized.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}

async function jumpToHeading(item: StructuredOutlineItem) {
  recordNavigationLocation();
  const paneId = activeEditorPaneId.value;
  if (outlineTab.value?.documentMode === "large") {
    window.dispatchEvent(new CustomEvent("lightmark:jump-line", { detail: { line: item.line, paneId } }));
    return;
  }
  revealHeadingAtLine(paneId, item.line);
  await nextTick();
  window.dispatchEvent(new CustomEvent("lightmark:jump-heading", {
    detail: { id: item.id, text: item.text, line: item.line, paneId },
  }));
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function outlineIndent(level: number) {
  return `${Math.min(Math.max(level - 1, 0), 5) * 0.8 + 0.25}rem`;
}

function toggleOutlineBranch(item: StructuredOutlineItem) {
  togglePaneOutlineFold(activeEditorPaneId.value, item.key);
}

function toggleAllOutlineBranches() {
  setAllPaneOutlineFolds(activeEditorPaneId.value, !allOutlineCollapsed.value);
}
</script>

<template>
  <aside class="lm-sidebar flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
    <div class="sidebar-header flex-none p-3 pb-2">
      <div class="sidebar-kicker">LIGHTMARK</div>
      <div class="sidebar-switcher flex items-center gap-1 p-1">
        <button
          class="sidebar-switch flex-1 px-2 py-1 text-sm"
          :class="{ active: activePane === 'files' }"
          @click="activePane = 'files'"
        >
          <UiIcon name="files" :size="15" />
          <span>文件</span>
        </button>
        <button
          v-if="appStore.settings.appearance.showOutline"
          class="sidebar-switch flex-1 px-2 py-1 text-sm"
          :class="{ active: activePane === 'outline' }"
          @click="activePane = 'outline'"
        >
          <UiIcon name="list-tree" :size="15" />
          <span>大纲</span>
        </button>
        <button
          v-if="appStore.currentWorkspace"
          class="sidebar-switch flex-1 px-2 py-1 text-sm"
          :class="{ active: activePane === 'knowledge' }"
          @click="activePane = 'knowledge'"
        >
          <UiIcon name="hash" :size="15" />
          <span>知识</span>
        </button>
        <button
          class="sidebar-switch flex-1 px-2 py-1 text-sm"
          :class="{ active: activePane === 'resources' }"
          @click="activePane = 'resources'"
        >
          <UiIcon name="image" :size="15" />
          <span>资源</span>
        </button>
      </div>
    </div>

    <section v-if="activePane === 'files'" class="min-h-0 flex-1 overflow-auto px-3 pb-3">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">工作区</h2>
        <button class="btn-small" @click="openWorkspace()">打开</button>
      </div>
      <p v-if="!appStore.currentWorkspace" class="sidebar-empty text-sm">尚未打开文件夹。<br><span>打开一个写作目录开始整理文稿。</span></p>
      <p v-else class="mb-3 truncate text-xs text-ink-500 dark:text-ink-300">{{ appStore.currentWorkspace }}</p>
      <FileTreeNode v-for="node in appStore.fileTree" :key="node.path" :node="node" @select="selectFile" />
    </section>

    <section v-else-if="activePane === 'outline'" ref="outlineScroll" class="min-h-0 flex-1 overflow-auto px-3 pb-3">
      <div class="outline-header">
        <h2 class="text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">当前文档</h2>
        <button
          v-if="outline.some((item) => item.hasChildren)"
          class="outline-toggle-all"
          :title="allOutlineCollapsed ? '全部展开' : '全部折叠'"
          @click="toggleAllOutlineBranches"
        >
          {{ allOutlineCollapsed ? "全部展开" : "全部折叠" }}
        </button>
      </div>
      <p v-if="outline.length === 0" class="text-sm text-ink-500 dark:text-ink-300">暂无标题。</p>
      <div
        v-for="item in visibleOutline"
        :key="item.key"
        class="outline-row"
        :class="{ active: activeOutlineItem?.key === item.key }"
        :data-outline-key="item.key"
        :style="{ paddingLeft: outlineIndent(item.level) }"
      >
        <button
          v-if="item.hasChildren"
          class="outline-disclosure"
          :aria-label="(outlineTab?.collapsedOutlineKeys ?? []).includes(item.key) ? `展开 ${item.text}` : `折叠 ${item.text}`"
          @click.stop="toggleOutlineBranch(item)"
        >
          <UiIcon
            :name="(outlineTab?.collapsedOutlineKeys ?? []).includes(item.key) ? 'chevron-right' : 'chevron-down'"
            :size="14"
          />
        </button>
        <span v-else class="outline-disclosure-spacer" />
        <button class="outline-item min-w-0 flex-1 truncate py-1.5 text-left text-sm" @click="jumpToHeading(item)">
          {{ item.text }}
        </button>
      </div>
    </section>

    <section v-else-if="activePane === 'knowledge'" class="min-h-0 flex-1 overflow-auto px-3 pb-3">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="text-xs font-medium tracking-wide text-ink-500 dark:text-ink-300">知识</h2>
        <button class="btn-small" :disabled="appStore.wikiIndexBusy" @click="refreshKnowledgeIndex()">刷新</button>
      </div>
      <div class="knowledge-tabs mb-3 grid grid-cols-3 gap-1 p-1">
        <button :class="{ active: knowledgeTab === 'backlinks' }" :disabled="!appStore.currentFilePath" @click="knowledgeTab = 'backlinks'">
          反链 <span>{{ appStore.wikiBacklinks.length }}</span>
        </button>
        <button :class="{ active: knowledgeTab === 'mentions' }" :disabled="!appStore.currentFilePath" @click="knowledgeTab = 'mentions'">
          未链接 <span>{{ appStore.wikiUnlinkedMentions.length }}</span>
        </button>
        <button :class="{ active: knowledgeTab === 'tags' }" @click="knowledgeTab = 'tags'">
          标签 <span>{{ workspaceKnowledgeTags.length }}</span>
        </button>
      </div>

      <p v-if="appStore.wikiIndexBusy" class="knowledge-state">正在更新知识索引...</p>
      <p v-else-if="appStore.wikiIndexError || appStore.wikiBacklinksError" class="knowledge-state text-red-600 dark:text-red-300">
        {{ appStore.wikiIndexError || appStore.wikiBacklinksError }}
      </p>

      <template v-else-if="knowledgeTab === 'backlinks'">
        <p v-if="!appStore.currentFilePath" class="knowledge-state">请先打开一个文档。</p>
        <p v-else-if="appStore.wikiBacklinks.length === 0" class="knowledge-state">暂无反链。</p>
        <button
          v-for="item in appStore.wikiBacklinks"
          :key="`${item.sourcePath}:${item.line}:${item.preview}`"
          class="backlink-card mb-2 block w-full px-2.5 py-2 text-left"
          @click="locateBacklink(item)"
        >
          <span class="block truncate text-sm font-medium text-ink-800 dark:text-ink-100">{{ item.sourceName }}</span>
          <span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">L{{ item.line + 1 }}</span>
          <span class="mt-1 line-clamp-2 block text-xs text-ink-600 dark:text-ink-300">{{ item.preview }}</span>
        </button>
      </template>

      <template v-else-if="knowledgeTab === 'mentions'">
        <p v-if="!appStore.currentFilePath" class="knowledge-state">请先打开一个文档。</p>
        <p v-else-if="appStore.wikiUnlinkedMentions.length === 0" class="knowledge-state">暂无未链接提及。</p>
        <article
          v-for="item in appStore.wikiUnlinkedMentions"
          :key="`${item.sourcePath}:${item.from}:${item.to}`"
          class="backlink-card mention-card mb-2 px-2.5 py-2"
        >
          <button class="block w-full border-0 bg-transparent p-0 text-left" @click="locateMention(item)">
            <span class="block truncate text-sm font-medium text-ink-800 dark:text-ink-100">{{ item.sourceName }}</span>
            <span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">L{{ item.line + 1 }} · “{{ item.text }}”</span>
            <span class="mt-1 line-clamp-2 block text-xs text-ink-600 dark:text-ink-300">{{ item.preview }}</span>
          </button>
          <button class="mention-convert mt-2" @click="convertMention(item)">转为链接</button>
        </article>
      </template>

      <template v-else>
        <p v-if="workspaceKnowledgeTags.length === 0" class="knowledge-state">工作区暂无标签。</p>
        <div v-for="tag in workspaceKnowledgeTags" :key="tag.normalizedName" class="mb-1.5">
          <button class="tag-row" :class="{ active: selectedTag === tag.normalizedName }" @click="selectTag(tag.normalizedName)">
            <span class="truncate">#{{ tag.name }}</span>
            <span>{{ tag.paths.length }}</span>
          </button>
          <div v-if="selectedTagItem?.normalizedName === tag.normalizedName" class="tag-documents">
            <button v-for="path in tag.paths" :key="path" @click="openTagDocument(path)">
              {{ displayPath(path) }}
            </button>
          </div>
        </div>
      </template>
    </section>
    <section v-else class="min-h-0 flex-1 overflow-auto px-3 pb-3">
      <ResourcesPane />
    </section>
  </aside>
</template>

<style scoped>
.lm-sidebar { background: var(--lm-sidebar); color: var(--lm-ink); }
.sidebar-header { border-bottom: 1px solid var(--lm-border); }
.sidebar-kicker { margin: 1px 4px 9px; color: var(--lm-ink-muted); font: 700 9px/1 var(--lm-editor-code-font-family); letter-spacing: .18em; }
.sidebar-switcher { border: 1px solid var(--lm-border); border-radius: 10px; background: color-mix(in srgb, var(--lm-surface) 36%, transparent); }
.sidebar-switch { display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 0; border-radius: 7px; background: transparent; color: var(--lm-ink-muted); transition: all var(--lm-transition); }
.sidebar-switch:hover { color: var(--lm-ink); }
.sidebar-switch.active { background: var(--lm-surface-raised); color: var(--lm-ink); box-shadow: var(--lm-shadow-sm); }
.sidebar-empty { margin-top: 14px; border: 1px dashed var(--lm-border-strong); border-radius: var(--lm-radius-md); padding: 16px 14px; color: var(--lm-ink-soft); line-height: 1.5; text-align: center; }
.sidebar-empty span { color: var(--lm-ink-muted); font-size: 12px; }
.outline-header { display: flex; min-height: 36px; align-items: center; justify-content: space-between; gap: 8px; position: sticky; top: 0; z-index: 2; background: var(--lm-sidebar); }
.outline-toggle-all { border: 0; border-radius: 6px; background: transparent; padding: 4px 6px; color: var(--lm-ink-muted); font-size: 10px; }
.outline-toggle-all:hover { background: var(--lm-accent-soft); color: var(--lm-ink); }
.outline-row { display: flex; min-width: 0; align-items: center; border-radius: var(--lm-radius-sm); color: var(--lm-ink-soft); transition: background var(--lm-transition), color var(--lm-transition); }
.outline-row:hover { background: color-mix(in srgb, var(--lm-accent-soft) 72%, transparent); color: var(--lm-ink); }
.outline-row.active { background: var(--lm-accent-soft); color: var(--lm-ink); box-shadow: inset 2px 0 0 var(--lm-accent); }
.outline-item { border: 0; background: transparent; color: inherit; }
.outline-disclosure { display: inline-flex; width: 22px; height: 28px; flex: 0 0 22px; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: var(--lm-ink-muted); }
.outline-disclosure:hover { background: var(--lm-surface-raised); color: var(--lm-ink); }
.outline-disclosure-spacer { width: 22px; flex: 0 0 22px; }
.backlink-card { border: 1px solid var(--lm-border); border-radius: var(--lm-radius-md); background: color-mix(in srgb, var(--lm-surface-raised) 74%, transparent); box-shadow: var(--lm-shadow-sm); transition: border-color var(--lm-transition), background var(--lm-transition), transform var(--lm-transition); }
.backlink-card:hover { border-color: var(--lm-border-strong); background: var(--lm-surface-raised); transform: translateY(-1px); }
.knowledge-tabs { border: 1px solid var(--lm-border); border-radius: var(--lm-radius-md); background: color-mix(in srgb, var(--lm-surface) 46%, transparent); }
.knowledge-tabs button { display: inline-flex; min-width: 0; align-items: center; justify-content: center; gap: 4px; border: 0; border-radius: 6px; background: transparent; padding: 5px 3px; color: var(--lm-ink-muted); font: 600 11px/1.2 var(--lm-ui-font-family); }
.knowledge-tabs button span { color: var(--lm-ink-faint); font-size: 10px; }
.knowledge-tabs button.active { background: var(--lm-surface-raised); color: var(--lm-ink); box-shadow: var(--lm-shadow-sm); }
.knowledge-tabs button:disabled { cursor: not-allowed; opacity: .45; }
.knowledge-state { padding: 12px 4px; color: var(--lm-ink-muted); font-size: 12px; line-height: 1.5; text-align: center; }
.mention-card:hover { transform: none; }
.mention-convert { border: 1px solid var(--lm-border-strong); border-radius: 6px; background: transparent; padding: 4px 7px; color: var(--lm-ink-soft); font: 600 11px/1.2 var(--lm-ui-font-family); }
.mention-convert:hover { background: var(--lm-accent-soft); color: var(--lm-ink); }
.tag-row { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; border: 0; border-radius: 7px; background: transparent; padding: 7px 8px; color: var(--lm-ink-soft); font-size: 12px; text-align: left; }
.tag-row:hover, .tag-row.active { background: var(--lm-accent-soft); color: var(--lm-ink); }
.tag-row > span:last-child { min-width: 1.5rem; color: var(--lm-ink-muted); font-size: 10px; text-align: right; }
.tag-documents { margin: 2px 0 6px 10px; border-left: 1px solid var(--lm-border); padding-left: 7px; }
.tag-documents button { display: block; width: 100%; overflow: hidden; border: 0; border-radius: 5px; background: transparent; padding: 5px 6px; color: var(--lm-ink-muted); font-size: 11px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.tag-documents button:hover { background: var(--lm-surface-raised); color: var(--lm-ink); }
</style>
