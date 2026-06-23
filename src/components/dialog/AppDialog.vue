<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { dialogStore, resolveDialog } from "../../stores/dialogStore";

const primaryButton = ref<HTMLButtonElement | null>(null);
const active = computed(() => dialogStore.active);

watch(
  () => dialogStore.active,
  (dialog) => {
    if (!dialog) return;
    void nextTick(() => primaryButton.value?.focus());
  },
);

function closeWith(id?: string) {
  const dialog = dialogStore.active;
  if (!dialog) return;
  resolveDialog(id ?? dialog.cancelId);
}

function buttonClass(variant = "secondary") {
  return {
    "dialog-button-primary": variant === "primary",
    "dialog-button-secondary": variant === "secondary",
    "dialog-button-danger": variant === "danger",
  };
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div
        v-if="active"
        class="dialog-backdrop"
        @click.self="closeWith()"
        @keydown.esc.prevent.stop="closeWith()"
        @keydown.enter.prevent.stop="active.defaultId && closeWith(active.defaultId)"
      >
        <section class="dialog-panel" role="dialog" aria-modal="true" :aria-label="active.title" tabindex="-1">
          <header class="dialog-header">
            <div class="min-w-0">
              <h2>{{ active.title }}</h2>
              <p>{{ active.message }}</p>
            </div>
          </header>

          <ul v-if="active.details?.length" class="dialog-details">
            <li v-for="item in active.details" :key="item">{{ item }}</li>
          </ul>

          <footer class="dialog-actions">
            <button
              v-for="button in active.buttons"
              :key="button.id"
              :ref="button.id === active.defaultId ? (element) => (primaryButton = element as HTMLButtonElement | null) : undefined"
              class="dialog-button"
              :class="buttonClass(button.variant)"
              @click="closeWith(button.id)"
            >
              {{ button.label }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: rgb(31 30 27 / 22%);
  padding: 24px;
  backdrop-filter: blur(2px);
}

.dialog-panel {
  width: min(520px, 100%);
  overflow: hidden;
  border: 1px solid rgb(224 220 212);
  border-radius: 10px;
  background: rgb(255 254 251);
  box-shadow: 0 24px 72px rgb(31 30 27 / 22%);
  color: rgb(43 39 34);
  outline: none;
}

.dialog-header {
  padding: 20px 20px 14px;
}

.dialog-header h2 {
  margin: 0;
  color: rgb(31 30 27);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.35;
}

.dialog-header p {
  margin: 6px 0 0;
  color: rgb(95 88 78);
  font-size: 13px;
  line-height: 1.55;
}

.dialog-details {
  max-height: 180px;
  overflow: auto;
  margin: 0 20px 4px;
  padding: 8px 10px;
  border: 1px solid rgb(237 234 228);
  border-radius: 8px;
  background: rgb(247 244 238 / 68%);
  color: rgb(83 77 68);
  font: 12px/1.55 var(--lm-editor-code-font-family, "JetBrains Mono", ui-monospace, monospace);
  list-style: none;
}

.dialog-details li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid rgb(237 234 228);
  background: rgb(247 244 238 / 52%);
  padding: 12px 14px;
}

.dialog-button {
  min-width: 82px;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 7px 13px;
  font-size: 13px;
  font-weight: 600;
  outline: none;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease,
    box-shadow 140ms ease;
}

.dialog-button:focus-visible {
  box-shadow: 0 0 0 3px rgb(134 128 116 / 22%);
}

.dialog-button-secondary {
  border-color: rgb(219 213 202);
  background: rgb(255 254 251);
  color: rgb(74 68 59);
}

.dialog-button-secondary:hover {
  background: rgb(239 235 228);
}

.dialog-button-primary {
  border-color: rgb(120 87 48);
  background: rgb(120 87 48);
  color: rgb(255 254 251);
}

.dialog-button-primary:hover {
  background: rgb(99 71 39);
}

.dialog-button-danger {
  border-color: rgb(156 61 45);
  background: rgb(156 61 45);
  color: rgb(255 254 251);
}

.dialog-button-danger:hover {
  background: rgb(131 49 36);
}

.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 140ms ease;
}

.dialog-fade-enter-active .dialog-panel,
.dialog-fade-leave-active .dialog-panel {
  transition: transform 140ms ease;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

.dialog-fade-enter-from .dialog-panel,
.dialog-fade-leave-to .dialog-panel {
  transform: translateY(6px) scale(0.985);
}

:global(.dark) .dialog-backdrop {
  background: rgb(0 0 0 / 38%);
}

:global(.dark) .dialog-panel {
  border-color: rgb(52 49 45);
  background: rgb(23 22 20);
  box-shadow: 0 24px 72px rgb(0 0 0 / 46%);
  color: rgb(229 222 210);
}

:global(.dark) .dialog-header h2 {
  color: rgb(246 241 233);
}

:global(.dark) .dialog-header p {
  color: rgb(185 179 168);
}

:global(.dark) .dialog-details {
  border-color: rgb(52 49 45);
  background: rgb(31 29 26);
  color: rgb(209 201 188);
}

:global(.dark) .dialog-actions {
  border-color: rgb(52 49 45);
  background: rgb(31 29 26 / 70%);
}

:global(.dark) .dialog-button-secondary {
  border-color: rgb(76 70 62);
  background: rgb(31 29 26);
  color: rgb(229 222 210);
}

:global(.dark) .dialog-button-secondary:hover {
  background: rgb(45 41 36);
}
</style>
