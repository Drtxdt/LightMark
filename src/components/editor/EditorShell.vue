<script setup lang="ts">
import { appStore } from "../../stores/appStore";
import LargeMarkdownEditor from "./LargeMarkdownEditor.vue";
import SourceEditor from "./SourceEditor.vue";
import WysiwygEditor from "./WysiwygEditor.vue";
</script>

<template>
  <section class="h-full overflow-hidden">
    <LargeMarkdownEditor v-if="appStore.documentMode === 'large'" />
    <WysiwygEditor v-else-if="appStore.editorMode === 'wysiwyg'" />
    <SourceEditor v-else />
  </section>
</template>
