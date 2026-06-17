<script setup lang="ts">
import { ref, watch } from "vue";
import { appStore } from "../../stores/appStore";
import LargeMarkdownEditor from "./LargeMarkdownEditor.vue";
import SourceEditor from "./SourceEditor.vue";
import WysiwygEditor from "./WysiwygEditor.vue";

const pageTransition = ref("editor-page-flip-to-source");

watch(
  () => appStore.editorMode,
  (mode, previousMode) => {
    if (!previousMode || mode === previousMode) return;
    pageTransition.value = mode === "source" ? "editor-page-flip-to-source" : "editor-page-flip-to-wysiwyg";
  },
);
</script>

<template>
  <section class="editor-page-shell h-full min-h-0 overflow-hidden">
    <LargeMarkdownEditor v-if="appStore.documentMode === 'large'" />
    <Transition v-else :name="pageTransition">
      <div :key="appStore.editorMode" class="editor-page">
        <WysiwygEditor v-if="appStore.editorMode === 'wysiwyg'" />
        <SourceEditor v-else />
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.editor-page-shell {
  position: relative;
  background: var(--lm-editor-page-bg, #fbfaf7);
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
  --lm-editor-page-bg: #141311;
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
