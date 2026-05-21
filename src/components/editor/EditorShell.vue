<script setup lang="ts">
import { appStore } from "../../stores/appStore";
import SourceEditor from "./SourceEditor.vue";
import WysiwygEditor from "./WysiwygEditor.vue";
</script>

<template>
  <section class="h-full overflow-hidden">
    <WysiwygEditor v-if="appStore.editorMode === 'wysiwyg'" />
    <SourceEditor v-else />
  </section>
</template>
