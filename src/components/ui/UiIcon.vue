<script setup lang="ts">
import { computed } from "vue";
import {
  BadgeAlert,
  Bold,
  ChevronDown,
  ChevronRight,
  Code2,
  CodeXml,
  Columns2,
  Command,
  FileInput,
  FileOutput,
  FilePlus2,
  Files,
  FileText,
  Folder,
  FolderOpen,
  Heading2,
  Hash,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  ListRestart,
  Minus,
  PenLine,
  Plus,
  Quote,
  Save,
  Search,
  Settings2,
  Table2,
  X,
  type LucideIcon,
} from "@lucide/vue";

const iconMap = {
  "badge-alert": BadgeAlert,
  bold: Bold,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  code: Code2,
  "code-xml": CodeXml,
  columns: Columns2,
  command: Command,
  "file-input": FileInput,
  "file-output": FileOutput,
  "file-plus": FilePlus2,
  files: Files,
  "file-text": FileText,
  folder: Folder,
  "folder-open": FolderOpen,
  heading: Heading2,
  hash: Hash,
  image: ImageIcon,
  italic: Italic,
  link: Link2,
  list: List,
  "list-checks": ListChecks,
  "list-ordered": ListOrdered,
  "list-tree": ListTree,
  format: ListRestart,
  minus: Minus,
  "pen-line": PenLine,
  plus: Plus,
  quote: Quote,
  save: Save,
  search: Search,
  settings: Settings2,
  table: Table2,
  x: X,
} satisfies Record<string, LucideIcon>;

export type UiIconName = keyof typeof iconMap;

const props = withDefaults(
  defineProps<{
    name: UiIconName;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 18,
    strokeWidth: 1.75,
  },
);

const iconComponent = computed(() => iconMap[props.name]);
</script>

<template>
  <component
    :is="iconComponent"
    class="ui-icon"
    :size="size"
    :stroke-width="strokeWidth"
    aria-hidden="true"
    focusable="false"
  />
</template>

<style scoped>
.ui-icon {
  display: block;
  flex: 0 0 auto;
  color: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
