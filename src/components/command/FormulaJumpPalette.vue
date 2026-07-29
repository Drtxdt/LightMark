<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  appStore,
  closeFormulaJump,
  recordNavigationLocation,
} from "../../stores/appStore";
import {
  evaluateMarkdownMath,
  type MathEquationTarget,
} from "../../utils/mathMarkdown";
import { useOverlayFocus } from "../../composables/useOverlayFocus";

const backdrop = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
useOverlayFocus({ backdrop, panel, initialFocus: input, close: closeFormulaJump });

const evaluation = computed(() => evaluateMarkdownMath(appStore.currentContent, {
  numberingMode: appStore.settings.markdown.mathNumbering,
}));

type FormulaJumpCandidate = MathEquationTarget & {
  diagnostic: string;
};

const equations = computed<FormulaJumpCandidate[]>(() => evaluation.value.entries
  .filter((entry) => entry.token.displayMode && !entry.definitionOnly && entry.equationTarget)
  .map((entry) => ({
    ...entry.equationTarget!,
    diagnostic: entry.diagnostic?.message
      ?? evaluation.value.diagnostics.find(
        (diagnostic) => diagnostic.token?.from === entry.token.from,
      )?.message
      ?? "",
  })));

const candidates = computed(() => {
  const query = normalize(appStore.formulaJumpQuery);
  return equations.value.filter((equation) => {
    if (!query) return true;
    return normalize([
      equation.display,
      ...equation.labels,
      equation.tex,
      equation.diagnostic,
    ].join(" ")).includes(query);
  });
});

watch(
  () => [appStore.formulaJumpQuery, candidates.value.length] as const,
  () => {
    appStore.formulaJumpActiveIndex = Math.max(
      0,
      Math.min(appStore.formulaJumpActiveIndex, candidates.value.length - 1),
    );
  },
  { immediate: true },
);

function moveSelection(delta: 1 | -1) {
  if (candidates.value.length === 0) return;
  const next = appStore.formulaJumpActiveIndex + delta;
  appStore.formulaJumpActiveIndex = (next + candidates.value.length) % candidates.value.length;
}

function jumpSelected() {
  const equation = candidates.value[appStore.formulaJumpActiveIndex];
  if (equation) jumpToEquation(equation);
}

function jumpToEquation(equation: FormulaJumpCandidate) {
  recordNavigationLocation();
  closeFormulaJump();
  const detail = {
    targetId: equation.id,
    line: equation.line,
    paneId: appStore.splitLayout.activePaneId,
  };
  if (appStore.editorMode === "source") {
    window.dispatchEvent(new CustomEvent("lightmark:jump-line", { detail }));
  } else {
    window.dispatchEvent(new CustomEvent("lightmark:jump-math", { detail }));
  }
}

function normalize(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function summary(equation: MathEquationTarget) {
  return equation.tex
    .replace(/\\(?:label|tag)\s*\{[^{}]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}
</script>

<template>
  <div ref="backdrop" class="lm-modal-backdrop fixed inset-0 z-50 p-20" @click.self="closeFormulaJump">
    <div ref="panel" tabindex="-1" class="lm-palette-panel mx-auto max-w-xl overflow-hidden" role="dialog" aria-modal="true" aria-label="前往公式">
      <input
        ref="input"
        v-model="appStore.formulaJumpQuery"
        class="w-full border-b border-paper-200 bg-transparent px-4 py-3 text-base text-ink-900 outline-none placeholder:text-ink-500 dark:border-paper-800 dark:text-ink-100 dark:placeholder:text-ink-300"
        placeholder="按编号、标签或公式内容查找"
        @keydown.down.prevent="moveSelection(1)"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.enter.prevent="jumpSelected"
      />
      <div class="max-h-96 overflow-auto p-2">
        <button
          v-for="(equation, index) in candidates"
          :key="equation.id"
          class="formula-jump-item"
          :class="{ active: index === appStore.formulaJumpActiveIndex }"
          @mouseenter="appStore.formulaJumpActiveIndex = index"
          @click="jumpToEquation(equation)"
        >
          <span class="formula-jump-number">
            {{ equation.display ? `(${equation.display})` : "未编号" }}
          </span>
          <span class="formula-jump-copy">
            <b>{{ equation.labels.length ? equation.labels.join(" · ") : "未命名公式" }}</b>
            <small>{{ summary(equation) }}</small>
            <small v-if="equation.diagnostic" class="formula-jump-error">
              {{ equation.diagnostic }}
            </small>
          </span>
          <span class="formula-jump-line">L{{ equation.line + 1 }}</span>
        </button>
        <p v-if="candidates.length === 0" class="px-3 py-6 text-center text-sm text-ink-500 dark:text-ink-400">
          当前文档没有匹配的已编号公式
        </p>
      </div>
    </div>
  </div>
</template>
