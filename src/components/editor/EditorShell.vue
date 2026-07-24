<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getPaneDocumentMode, getPaneEditorMode, getPaneTab } from "../../stores/appStore";
import LargeMarkdownEditor from "./LargeMarkdownEditor.vue";
import SourceEditor from "./SourceEditor.vue";
import WysiwygEditor from "./WysiwygEditor.vue";
import type { EditorPaneId } from "../../types";

const props = withDefaults(defineProps<{ paneId?: EditorPaneId }>(), {
  paneId: "main",
});

const pageTransition = ref("editor-page-flip-to-source");
const paneTab = computed(() => getPaneTab(props.paneId));
const paneDocumentMode = computed(() => getPaneDocumentMode(props.paneId));
const paneEditorMode = computed(() => getPaneEditorMode(props.paneId));

watch(
  () => paneEditorMode.value,
  (mode, previousMode) => {
    if (!previousMode || mode === previousMode) return;
    pageTransition.value = mode === "source" ? "editor-page-flip-to-source" : "editor-page-flip-to-wysiwyg";
  },
);
</script>

<template>
  <section class="editor-page-shell h-full min-h-0 overflow-hidden">
    <LargeMarkdownEditor v-if="paneDocumentMode === 'large'" :key="paneTab?.id" :pane-id="paneId" />
    <Transition v-else :name="pageTransition">
      <div :key="`${paneTab?.id || 'empty'}:${paneEditorMode}`" class="editor-page">
        <WysiwygEditor v-if="paneEditorMode === 'wysiwyg'" :pane-id="paneId" />
        <SourceEditor v-else :pane-id="paneId" />
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.editor-page-shell {
  position: relative;
  background: var(--lm-editor-page-bg, var(--lm-surface));
}

.editor-page {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: visible;
  backface-visibility: hidden;
}

.editor-page-flip-to-source-enter-active,
.editor-page-flip-to-source-leave-active,
.editor-page-flip-to-wysiwyg-enter-active,
.editor-page-flip-to-wysiwyg-leave-active {
  transition: opacity 160ms ease;
}

.editor-page-flip-to-source-enter-active,
.editor-page-flip-to-wysiwyg-enter-active {
  z-index: 1;
}

.editor-page-flip-to-source-leave-active,
.editor-page-flip-to-wysiwyg-leave-active {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: visible;
  will-change: opacity;
}

.editor-page-flip-to-source-leave-from,
.editor-page-flip-to-source-enter-to,
.editor-page-flip-to-wysiwyg-leave-from,
.editor-page-flip-to-wysiwyg-enter-to {
  opacity: 1;
}

.editor-page-flip-to-source-leave-to {
  opacity: 0;
}

.editor-page-flip-to-source-enter-from {
  opacity: 0;
}

.editor-page-flip-to-wysiwyg-leave-to {
  opacity: 0;
}

.editor-page-flip-to-wysiwyg-enter-from {
  opacity: 0;
}

:global(.dark) .editor-page-shell {
  --lm-editor-page-bg: var(--lm-surface);
}

@media (prefers-reduced-motion: reduce) {
  .editor-page-flip-to-source-enter-active,
  .editor-page-flip-to-source-leave-active,
  .editor-page-flip-to-wysiwyg-enter-active,
  .editor-page-flip-to-wysiwyg-leave-active {
    transition-duration: 0ms;
  }
}
</style>
