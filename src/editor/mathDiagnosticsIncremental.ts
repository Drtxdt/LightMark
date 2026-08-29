import {
  evaluateMarkdownMath,
  type MathDocumentEvaluation,
  type MathNumberingMode,
  type MarkdownMathToken,
} from "../utils/mathMarkdown";

export type MathDiagnosticEdit = { from: number; to: number; insert: string };

export type MathDiagnosticsPayload = {
  strategy: "full" | "mapped" | "formula";
  diagnostics: Array<{ from: number; to: number; message: string }>;
  references: Array<{ from: number; to: number; key: string; targetId?: string }>;
  equations: Array<{ id: string; tokenIndex: number; line: number; display: string }>;
};

type CachedResult = Omit<MathDiagnosticsPayload, "strategy"> & {
  tokens: MarkdownMathToken[];
  semantic: boolean;
};

type PreparedEdit = MathDiagnosticEdit & { removed: string };
type PendingBatch = { edits: PreparedEdit[] };

const STRUCTURAL_OUTSIDE_MATH = /[$`\\<>]/;

export class IncrementalMathDiagnostics {
  private markdown = "";
  private numberingMode: MathNumberingMode = "none";
  private cached: CachedResult | null = null;
  private pending: PendingBatch[] = [];
  private forceFull = true;

  reset(markdown: string, numberingMode: MathNumberingMode) {
    this.markdown = markdown;
    this.numberingMode = numberingMode;
    this.pending = [];
    this.forceFull = true;
  }

  applyChanges(edits: MathDiagnosticEdit[], numberingMode: MathNumberingMode) {
    if (numberingMode !== this.numberingMode) this.forceFull = true;
    this.numberingMode = numberingMode;
    const normalized: PreparedEdit[] = [...edits]
      .sort((left, right) => left.from - right.from)
      .map((edit) => ({ ...edit, removed: this.markdown.slice(edit.from, edit.to) }));
    this.pending.push({ edits: normalized });
    for (const edit of [...normalized].sort((left, right) => right.from - left.from)) {
      this.markdown = `${this.markdown.slice(0, edit.from)}${edit.insert}${this.markdown.slice(edit.to)}`;
    }
  }

  evaluate(): MathDiagnosticsPayload {
    const incremental = !this.forceFull && this.cached
      ? updateCachedResult(this.cached, this.pending, this.markdown, this.numberingMode)
      : null;
    if (incremental) {
      this.cached = incremental.cache;
      this.pending = [];
      return { strategy: incremental.strategy, ...publicResult(incremental.cache) };
    }

    const evaluation = evaluateMarkdownMath(this.markdown, { numberingMode: this.numberingMode });
    this.cached = cacheEvaluation(evaluation);
    this.pending = [];
    this.forceFull = false;
    return { strategy: "full", ...publicResult(this.cached) };
  }
}

function updateCachedResult(
  source: CachedResult,
  batches: PendingBatch[],
  markdown: string,
  numberingMode: MathNumberingMode,
) {
  if (numberingMode !== "none" || source.semantic || batches.length === 0) return null;
  const cache = cloneCache(source);
  let affectedToken = -1;

  for (const batch of batches) {
    for (const edit of batch.edits) {
      const touched = cache.tokens
        .map((token, index) => ({ token, index }))
        .filter(({ token }) => editTouchesToken(edit, token));
      if (touched.length > 1) return null;
      if (touched.length === 1) {
        if (affectedToken !== -1 && affectedToken !== touched[0].index) return null;
        affectedToken = touched[0].index;
      } else {
        if (STRUCTURAL_OUTSIDE_MATH.test(edit.insert) || STRUCTURAL_OUTSIDE_MATH.test(edit.removed)) {
          // A delimiter or Markdown protection boundary outside a known token
          // can create/remove formulas, so it must use the full compatibility path.
          return null;
        }
      }
    }
    mapCacheThroughEdits(cache, batch.edits);
  }

  refreshLines(cache, markdown);
  if (affectedToken === -1) return { strategy: "mapped" as const, cache };

  const token = cache.tokens[affectedToken];
  const fragment = markdown.slice(token.from, token.to);
  const local = evaluateMarkdownMath(fragment, { numberingMode: "none" });
  if (
    local.entries.length !== 1
    || local.entries[0].token.from !== 0
    || local.entries[0].token.to !== fragment.length
    || hasSemanticMath(local)
  ) return null;

  const nextToken = offsetToken(local.entries[0].token, token.from, lineAt(markdown, token.from));
  cache.tokens[affectedToken] = nextToken;
  cache.diagnostics = cache.diagnostics
    .filter((diagnostic) => diagnostic.to <= token.from || diagnostic.from >= token.to)
    .concat(local.diagnostics.map((diagnostic) => ({
      from: diagnostic.from + token.from,
      to: diagnostic.to + token.from,
      message: diagnostic.message,
    })))
    .sort((left, right) => left.from - right.from);

  const existingEquation = cache.equations.find((equation) => equation.tokenIndex === affectedToken);
  cache.equations = cache.equations.filter((equation) => equation.tokenIndex !== affectedToken);
  const localEquation = local.equations[0];
  if (localEquation) {
    cache.equations.push({
      id: existingEquation?.id ?? `lm-equation-${affectedToken + 1}`,
      tokenIndex: affectedToken,
      line: nextToken.line,
      display: localEquation.display,
    });
    cache.equations.sort((left, right) => left.tokenIndex - right.tokenIndex);
  }
  return { strategy: "formula" as const, cache };
}

function cacheEvaluation(evaluation: MathDocumentEvaluation): CachedResult {
  return {
    tokens: evaluation.entries.map((entry) => ({ ...entry.token })),
    diagnostics: evaluation.diagnostics.map((item) => ({ from: item.from, to: item.to, message: item.message })),
    references: evaluation.references.map((item) => ({
      from: item.from,
      to: item.to,
      key: item.key,
      targetId: item.targetId,
    })),
    equations: evaluation.equations.map((item) => ({
      id: item.id,
      tokenIndex: item.tokenIndex,
      line: item.line,
      display: item.display,
    })),
    semantic: hasSemanticMath(evaluation),
  };
}

function hasSemanticMath(evaluation: MathDocumentEvaluation) {
  return evaluation.macroNames.length > 0
    || evaluation.labels.length > 0
    || evaluation.references.length > 0
    || evaluation.entries.some((entry) => entry.definedMacroNames.length > 0);
}

function publicResult(cache: CachedResult): Omit<MathDiagnosticsPayload, "strategy"> {
  return {
    diagnostics: cache.diagnostics,
    references: cache.references,
    equations: cache.equations,
  };
}

function cloneCache(cache: CachedResult): CachedResult {
  return {
    tokens: cache.tokens.map((token) => ({ ...token })),
    diagnostics: cache.diagnostics.map((item) => ({ ...item })),
    references: cache.references.map((item) => ({ ...item })),
    equations: cache.equations.map((item) => ({ ...item })),
    semantic: cache.semantic,
  };
}

function editTouchesToken(edit: MathDiagnosticEdit, token: MarkdownMathToken) {
  if (edit.from === edit.to) return edit.from > token.from && edit.from < token.to;
  return edit.from < token.to && edit.to > token.from;
}

function mapCacheThroughEdits(cache: CachedResult, edits: MathDiagnosticEdit[]) {
  for (const token of cache.tokens) {
    token.from = mapPosition(token.from, edits, -1);
    token.to = mapPosition(token.to, edits, 1);
    token.contentFrom = mapPosition(token.contentFrom, edits, -1);
    token.contentTo = mapPosition(token.contentTo, edits, 1);
  }
  for (const diagnostic of cache.diagnostics) {
    diagnostic.from = mapPosition(diagnostic.from, edits, -1);
    diagnostic.to = mapPosition(diagnostic.to, edits, 1);
  }
  for (const reference of cache.references) {
    reference.from = mapPosition(reference.from, edits, -1);
    reference.to = mapPosition(reference.to, edits, 1);
  }
}

function mapPosition(position: number, edits: MathDiagnosticEdit[], association: -1 | 1) {
  let delta = 0;
  for (const edit of edits) {
    if (position < edit.from || (position === edit.from && association < 0)) break;
    if (position > edit.to || (position === edit.to && association > 0)) {
      delta += edit.insert.length - (edit.to - edit.from);
      continue;
    }
    return edit.from + delta + (association > 0 ? edit.insert.length : 0);
  }
  return position + delta;
}

function refreshLines(cache: CachedResult, markdown: string) {
  cache.tokens.forEach((token) => {
    token.line = lineAt(markdown, token.from);
    token.column = columnAt(markdown, token.from);
  });
  cache.equations.forEach((equation) => {
    equation.line = cache.tokens[equation.tokenIndex]?.line ?? equation.line;
  });
}

function offsetToken(token: MarkdownMathToken, offset: number, lineOffset: number): MarkdownMathToken {
  return {
    ...token,
    from: token.from + offset,
    to: token.to + offset,
    contentFrom: token.contentFrom + offset,
    contentTo: token.contentTo + offset,
    line: token.line + lineOffset,
  };
}

function lineAt(markdown: string, offset: number) {
  let line = 0;
  for (let index = 0; index < offset; index += 1) if (markdown.charCodeAt(index) === 10) line += 1;
  return line;
}

function columnAt(markdown: string, offset: number) {
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, offset - 1));
  return offset - lineStart - 1;
}
