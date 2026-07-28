<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { dialogStore, resolveDialog } from "../../stores/dialogStore";
import { useOverlayFocus } from "../../composables/useOverlayFocus";

const backdrop = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const primaryButton = ref<HTMLButtonElement | null>(null);
const active = computed(() => dialogStore.active);
const isOpen = computed(() => Boolean(dialogStore.active));
useOverlayFocus({ backdrop, panel, initialFocus: primaryButton, close: () => closeWith(), active: isOpen });

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
        ref="backdrop"
        class="dialog-backdrop"
        @click.self="closeWith()"
        @keydown.enter.prevent.stop="active.defaultId && closeWith(active.defaultId)"
      >
        <section ref="panel" class="dialog-panel" role="dialog" aria-modal="true" :aria-label="active.title" tabindex="-1">
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
  background: rgb(54 42 29 / 22%);
  padding: 24px;
  backdrop-filter: blur(3px) saturate(88%);
}

.dialog-panel {
  width: min(520px, 100%);
  overflow: hidden;
  border: 1px solid var(--lm-border-strong);
  border-radius: var(--lm-radius-lg);
  background: var(--lm-surface-raised);
  box-shadow: var(--lm-shadow-md);
  color: var(--lm-ink);
  outline: none;
}

.dialog-header {
  padding: 20px 20px 14px;
}

.dialog-header h2 {
  margin: 0;
  color: var(--lm-ink);
  font-family: Georgia, "Noto Serif SC", serif;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.35;
}

.dialog-header p {
  margin: 6px 0 0;
  color: var(--lm-ink-soft);
  font-size: 13px;
  line-height: 1.55;
}

.dialog-details {
  max-height: 180px;
  overflow: auto;
  margin: 0 20px 4px;
  padding: 8px 10px;
  border: 1px solid var(--lm-border);
  border-radius: 8px;
  background: var(--lm-surface-soft);
  color: var(--lm-ink-soft);
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
  border-top: 1px solid var(--lm-border);
  background: var(--lm-surface-soft);
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
  box-shadow: 0 0 0 3px var(--lm-focus);
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
  border-color: var(--lm-accent);
  background: var(--lm-accent);
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
  border-color: var(--lm-border-strong);
  background: var(--lm-surface-raised);
  box-shadow: var(--lm-shadow-md);
  color: var(--lm-ink);
}

:global(.dark) .dialog-header h2 {
  color: var(--lm-ink);
}

:global(.dark) .dialog-header p {
  color: var(--lm-ink-soft);
}

:global(.dark) .dialog-details {
  border-color: var(--lm-border);
  background: var(--lm-surface-soft);
  color: var(--lm-ink-soft);
}

:global(.dark) .dialog-actions {
  border-color: var(--lm-border);
  background: var(--lm-surface-soft);
}

:global(.dark) .dialog-button-secondary {
  border-color: var(--lm-border-strong);
  background: var(--lm-surface-raised);
  color: var(--lm-ink);
}

:global(.dark) .dialog-button-secondary:hover {
  background: var(--lm-accent-soft);
}

@media (prefers-reduced-motion: reduce) {
  .dialog-fade-enter-active,
  .dialog-fade-leave-active,
  .dialog-fade-enter-active .dialog-panel,
  .dialog-fade-leave-active .dialog-panel { transition-duration: 0ms; }
}
</style>
