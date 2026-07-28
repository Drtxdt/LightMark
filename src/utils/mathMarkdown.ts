import katex from "katex";
import "katex/contrib/mhchem";

export type MathDelimiter =
  | "inline-dollar"
  | "inline-double-dollar"
  | "inline-paren"
  | "display-dollar"
  | "display-bracket"
  | "environment";

export type MarkdownMathToken = {
  kind: "inline" | "display";
  delimiter: MathDelimiter;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  raw: string;
  tex: string;
  line: number;
  column: number;
  displayMode: boolean;
};

export type MathDiagnostic = {
  from: number;
  to: number;
  message: string;
  severity: "error";
  texOffset?: number;
  token?: MarkdownMathToken;
};

export type MathRenderResult =
  | { ok: true; html: string }
  | { ok: false; error: MathDiagnostic };

export type MathMacroDefinition = {
  name: string;
  command: "def" | "gdef" | "newcommand" | "renewcommand" | "providecommand";
  from: number;
  to: number;
};

export type MathEvaluationEntry = {
  token: MarkdownMathToken;
  result: MathRenderResult;
  diagnostic: MathDiagnostic | null;
  availableMacroNames: string[];
  definedMacroNames: string[];
  definitionOnly: boolean;
  usesMhchem: boolean;
};

export type MathDocumentEvaluation = {
  entries: MathEvaluationEntry[];
  diagnostics: MathDiagnostic[];
  macroNames: string[];
  usesMhchem: boolean;
};

export type PandocMathPreparation = {
  markdown: string;
  latexHeader: string;
  usesMhchem: boolean;
  macroNames: string[];
};

type Range = { from: number; to: number };
type MathMacroMap = Record<string, unknown>;

const MATH_ENVIRONMENTS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "aligned",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "split",
]);

export function parseMarkdownMath(source: string) {
  const lineStarts = collectLineStarts(source);
  const protectedRanges = collectProtectedMarkdownRanges(source);
  const tokens: MarkdownMathToken[] = [];
  const diagnostics: MathDiagnostic[] = [];
  const occupied = [...protectedRanges];

  collectDisplayMath(source, lineStarts, occupied, tokens, diagnostics);
  collectInlineMath(source, lineStarts, occupied, tokens);

  tokens.sort((left, right) => left.from - right.from);
  diagnostics.sort((left, right) => left.from - right.from);
  return { tokens, diagnostics };
}

export function parseInlineMathText(source: string) {
  const lineStarts = collectLineStarts(source);
  const tokens: MarkdownMathToken[] = [];
  collectInlineMath(source, lineStarts, [], tokens);
  return tokens.sort((left, right) => left.from - right.from);
}

export function evaluateMarkdownMath(source: string): MathDocumentEvaluation {
  const parsed = parseMarkdownMath(source);
  const evaluated = evaluateMathTokens(parsed.tokens);
  return {
    ...evaluated,
    diagnostics: [...parsed.diagnostics, ...evaluated.diagnostics]
      .sort((left, right) => left.from - right.from),
  };
}

export function evaluateMathTokens(tokens: MarkdownMathToken[]): MathDocumentEvaluation {
  let macros: MathMacroMap = {};
  const entries: MathEvaluationEntry[] = [];
  const diagnostics: MathDiagnostic[] = [];
  let usesMhchem = false;

  for (const token of [...tokens].sort((left, right) => left.from - right.from)) {
    const availableMacroNames = sortedMacroNames(macros);
    const definitions = extractMathMacroDefinitions(token.tex);
    const workingMacros = { ...macros };
    const result = renderMathWithMacros(token, workingMacros, true);
    const diagnostic = result.ok ? null : result.error;
    const tokenUsesMhchem = usesMhchemCommands(token.tex);
    usesMhchem ||= tokenUsesMhchem;

    if (result.ok) macros = workingMacros;
    else diagnostics.push(result.error);

    const definedMacroNames = result.ok
      ? unique(definitions.map((definition) => definition.name))
      : [];
    entries.push({
      token,
      result,
      diagnostic,
      availableMacroNames,
      definedMacroNames,
      definitionOnly: result.ok
        && definedMacroNames.length > 0
        && !hasVisibleKatexOutput(result.html),
      usesMhchem: tokenUsesMhchem,
    });
  }

  return {
    entries,
    diagnostics,
    macroNames: sortedMacroNames(macros),
    usesMhchem,
  };
}

export function validateMathToken(
  token: MarkdownMathToken,
  macros: MathMacroMap = {},
): MathDiagnostic | null {
  if (!token.tex.trim()) {
    return {
      from: token.contentFrom,
      to: Math.max(token.contentFrom + 1, token.contentTo),
      message: "公式内容为空",
      severity: "error",
      token,
    };
  }
  const rendered = renderMathWithMacros(token, { ...macros }, false);
  return rendered.ok ? null : rendered.error;
}

export function renderMathToken(
  token: MarkdownMathToken,
  macros: MathMacroMap = {},
): MathRenderResult {
  if (!token.tex.trim()) {
    return {
      ok: false,
      error: {
        from: token.contentFrom,
        to: Math.max(token.contentFrom + 1, token.contentTo),
        message: "公式内容为空",
        severity: "error",
        token,
      },
    };
  }
  return renderMathWithMacros(token, { ...macros }, false);
}

function renderMathWithMacros(
  token: MarkdownMathToken,
  macros: MathMacroMap,
  globalGroup: boolean,
): MathRenderResult {
  if (!token.tex.trim()) {
    return {
      ok: false,
      error: {
        from: token.contentFrom,
        to: Math.max(token.contentFrom + 1, token.contentTo),
        message: "公式内容为空",
        severity: "error",
        token,
      },
    };
  }
  try {
    return {
      ok: true,
      html: katex.renderToString(token.tex, {
        displayMode: token.displayMode,
        throwOnError: true,
        strict: false,
        trust: false,
        maxExpand: 1000,
        globalGroup,
        macros: macros as katex.KatexOptions["macros"],
      }),
    };
  } catch (error) {
    const texOffset = mathErrorOffset(error);
    const reportedFrom = texOffset === undefined
      ? token.contentFrom
      : Math.min(token.contentTo, token.contentFrom + texOffset);
    const from = reportedFrom >= token.contentTo
      ? Math.max(token.contentFrom, token.contentTo - 1)
      : reportedFrom;
    return {
      ok: false,
      error: {
        from,
        to: Math.min(token.contentTo, Math.max(from + 1, token.contentTo)),
        message: readableMathError(error),
        severity: "error",
        texOffset,
        token,
      },
    };
  }
}

export function extractMathMacroDefinitions(tex: string): MathMacroDefinition[] {
  const definitions: MathMacroDefinition[] = [];
  const direct = /\\(g?def)\s*(\\[A-Za-z@]+|\\.)/g;
  const command = /\\(newcommand|renewcommand|providecommand)\s*\{?\s*(\\[A-Za-z@]+|\\.)/g;
  let match: RegExpExecArray | null;
  while ((match = direct.exec(tex))) {
    definitions.push({
      name: match[2],
      command: match[1] as MathMacroDefinition["command"],
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  while ((match = command.exec(tex))) {
    definitions.push({
      name: match[2],
      command: match[1] as MathMacroDefinition["command"],
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return definitions.sort((left, right) => left.from - right.from);
}

export function preparePandocMath(markdown: string): PandocMathPreparation {
  const evaluation = evaluateMarkdownMath(markdown);
  let next = markdown;
  for (const entry of [...evaluation.entries].reverse()) {
    if (!entry.result.ok || entry.definedMacroNames.length === 0) continue;
    const token = entry.token;
    const relativeContentFrom = token.contentFrom - token.from;
    const raw = token.delimiter === "environment"
      ? injectEnvironmentGlobalDefinitions(token.raw)
      : `${token.raw.slice(0, relativeContentFrom)}\\globaldefs=1 ${token.raw.slice(relativeContentFrom)}`;
    next = `${next.slice(0, token.from)}${raw}${next.slice(token.to)}`;
  }
  return {
    markdown: next,
    latexHeader: evaluation.usesMhchem
      ? [
          "\\usepackage[version=4]{mhchem}",
          "% Older TeX distributions may ship mhchem without \\pu.",
          "\\providecommand{\\pu}[1]{\\ce{#1}}",
          "",
        ].join("\n")
      : "",
    usesMhchem: evaluation.usesMhchem,
    macroNames: evaluation.macroNames,
  };
}

export function serializeMathToken(
  token: Pick<MarkdownMathToken, "delimiter" | "raw" | "tex">,
  tex = token.tex,
  preserveOriginal = tex === token.tex,
) {
  if (preserveOriginal && token.raw) return token.raw;
  switch (token.delimiter) {
    case "inline-dollar":
      return `$${tex}$`;
    case "inline-double-dollar":
      return `$$${tex}$$`;
    case "inline-paren":
      return `\\(${tex}\\)`;
    case "display-bracket":
      return `\\[\n${tex}\n\\]`;
    case "display-dollar":
    case "environment":
      return `$$\n${tex}\n$$`;
  }
}

export function mathTokenFromParts(input: {
  tex: string;
  delimiter?: MathDelimiter;
  raw?: string;
  displayMode?: boolean;
}) {
  const delimiter = input.delimiter ?? (input.displayMode ? "display-dollar" : "inline-dollar");
  const raw = input.raw || serializeMathToken({ delimiter, raw: "", tex: input.tex }, input.tex, false);
  const openLength = openingDelimiterLength(delimiter, raw);
  const closeLength = closingDelimiterLength(delimiter, raw);
  return {
    kind: input.displayMode ? "display" : "inline",
    delimiter,
    from: 0,
    to: raw.length,
    contentFrom: openLength,
    contentTo: Math.max(openLength, raw.length - closeLength),
    raw,
    tex: input.tex,
    line: 0,
    column: 0,
    displayMode: input.displayMode ?? isDisplayDelimiter(delimiter),
  } satisfies MarkdownMathToken;
}

function collectDisplayMath(
  source: string,
  lineStarts: number[],
  occupied: Range[],
  tokens: MarkdownMathToken[],
  diagnostics: MathDiagnostic[],
) {
  const lines = source.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const start = lineStarts[lineIndex];
    if (rangeOverlaps(occupied, start, start + line.length)) continue;

    const dollarOpen = line.match(/^([ \t]*)\$\$[ \t]*$/);
    const bracketOpen = line.match(/^([ \t]*)\\\[[ \t]*$/);
    if (dollarOpen || bracketOpen) {
      const closePattern = dollarOpen ? /^[ \t]*\$\$[ \t]*$/ : /^[ \t]*\\\][ \t]*$/;
      let closeLine = -1;
      let hasBlankLine = false;
      for (let candidate = lineIndex + 1; candidate < lines.length; candidate += 1) {
        if (!lines[candidate].trim()) hasBlankLine = true;
        if (closePattern.test(lines[candidate])) {
          closeLine = candidate;
          break;
        }
      }
      if (closeLine < 0) {
        diagnostics.push({
          from: start + (dollarOpen ? dollarOpen[1].length : bracketOpen![1].length),
          to: start + line.length,
          message: dollarOpen ? "块级公式缺少结束分隔符 $$" : "块级公式缺少结束分隔符 \\]",
          severity: "error",
        });
        continue;
      }
      if (hasBlankLine) continue;
      const from = start;
      const to = lineStarts[closeLine] + lines[closeLine].length;
      if (rangeOverlaps(occupied, from, to)) continue;
      const contentFrom = start + line.length + lineBreakLengthAt(source, start + line.length);
      const contentTo = Math.max(contentFrom, lineStarts[closeLine] - lineBreakLengthBefore(source, lineStarts[closeLine]));
      const delimiter: MathDelimiter = dollarOpen ? "display-dollar" : "display-bracket";
      tokens.push(makeToken(source, lineStarts, delimiter, from, to, contentFrom, contentTo, true));
      occupied.push({ from, to });
      lineIndex = closeLine;
      continue;
    }

    const environmentOpen = line.match(/^[ \t]*\\begin\{([^}]+)\}/);
    if (!environmentOpen || !MATH_ENVIRONMENTS.has(environmentOpen[1])) continue;
    const environment = environmentOpen[1];
    const closePattern = new RegExp(`\\\\end\\{${escapeRegExp(environment)}\\}`);
    let closeLine = lineIndex;
    while (closeLine < lines.length && !closePattern.test(lines[closeLine])) closeLine += 1;
    if (closeLine >= lines.length) {
      diagnostics.push({
        from: start,
        to: start + line.length,
        message: `数学环境 ${environment} 缺少 \\end{${environment}}`,
        severity: "error",
      });
      continue;
    }
    const from = start + (line.match(/^[ \t]*/)?.[0].length ?? 0);
    const to = lineStarts[closeLine] + lines[closeLine].length;
    if (rangeOverlaps(occupied, from, to)) continue;
    tokens.push(makeToken(source, lineStarts, "environment", from, to, from, to, true));
    occupied.push({ from, to });
    lineIndex = closeLine;
  }
}

function collectInlineMath(
  source: string,
  lineStarts: number[],
  occupied: Range[],
  tokens: MarkdownMathToken[],
) {
  for (let index = 0; index < source.length; index += 1) {
    if (rangeAt(occupied, index)) continue;
    if (source[index] === "\n" || source[index] === "\r") continue;

    if (source.startsWith("\\(", index) && !isEscaped(source, index)) {
      const close = findInlineClose(source, index + 2, "\\)");
      if (close >= 0 && !rangeOverlaps(occupied, index, close + 2)) {
        const token = makeToken(source, lineStarts, "inline-paren", index, close + 2, index + 2, close, false);
        tokens.push(token);
        occupied.push({ from: token.from, to: token.to });
        index = token.to - 1;
      }
      continue;
    }

    if (source.startsWith("$$", index) && !isEscaped(source, index)) {
      const close = findDoubleDollarClose(source, index + 2);
      if (close >= 0 && !rangeOverlaps(occupied, index, close + 2)) {
        const token = makeToken(source, lineStarts, "inline-double-dollar", index, close + 2, index + 2, close, true);
        tokens.push(token);
        occupied.push({ from: token.from, to: token.to });
        index = token.to - 1;
      }
      continue;
    }

    if (source[index] !== "$" || isEscaped(source, index) || source[index + 1] === "$") continue;
    if (!canOpenSingleDollar(source, index)) continue;
    const pair = findSingleDollarPair(source, index);
    if (!pair || rangeOverlaps(occupied, pair.open, pair.close + 1)) continue;
    const token = makeToken(source, lineStarts, "inline-dollar", pair.open, pair.close + 1, pair.open + 1, pair.close, false);
    tokens.push(token);
    occupied.push({ from: token.from, to: token.to });
    index = token.to - 1;
  }
}

function findSingleDollarPair(source: string, initialOpening: number) {
  let opening = initialOpening;
  const lineEnd = findLineEnd(source, initialOpening + 1);
  const mhchemArguments = collectMhchemArgumentRanges(source, initialOpening + 1, lineEnd);
  for (let index = initialOpening + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n" || character === "\r") return null;
    if (character !== "$" || isEscaped(source, index)) continue;
    if (rangeAt(mhchemArguments, index)) continue;
    if (
      (source[index + 1] === "$" && !isEscaped(source, index + 1))
      || (source[index - 1] === "$" && !isEscaped(source, index - 1))
    ) continue;
    if (canCloseSingleDollar(source, index)) return { open: opening, close: index };
    if (canOpenSingleDollar(source, index)) opening = index;
  }
  return null;
}

function collectMhchemArgumentRanges(source: string, from: number, to: number) {
  const ranges: Range[] = [];
  const command = /\\(?:ce|pu)\s*\{/g;
  command.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = command.exec(source)) && match.index < to) {
    const open = match.index + match[0].lastIndexOf("{");
    let depth = 1;
    let index = open + 1;
    for (; index < to; index += 1) {
      if (isEscaped(source, index)) continue;
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      ranges.push({ from: open + 1, to: index });
      command.lastIndex = index + 1;
    }
  }
  return ranges;
}

function findLineEnd(source: string, from: number) {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === "\n" || source[index] === "\r") return index;
  }
  return source.length;
}

function findDoubleDollarClose(source: string, from: number) {
  for (let index = from; index < source.length - 1; index += 1) {
    if (source[index] === "\n" || source[index] === "\r") return -1;
    if (source.startsWith("$$", index) && !isEscaped(source, index)) return index;
  }
  return -1;
}

function findInlineClose(source: string, from: number, delimiter: string) {
  for (let index = from; index < source.length - 1; index += 1) {
    if (source[index] === "\n" || source[index] === "\r") return -1;
    if (source.startsWith(delimiter, index) && !isEscaped(source, index)) return index;
  }
  return -1;
}

function canOpenSingleDollar(source: string, index: number) {
  const next = source[index + 1];
  return Boolean(next && next !== "$" && !/[ \t\r\n]/.test(next));
}

function canCloseSingleDollar(source: string, index: number) {
  const previous = source[index - 1];
  const next = source[index + 1];
  return Boolean(previous && !/[ \t\r\n\\]/.test(previous) && !(next && /\d/.test(next)));
}

function collectProtectedMarkdownRanges(source: string) {
  const ranges: Range[] = [];
  collectHtmlBlockRanges(source, ranges);
  const lineStarts = collectLineStarts(source);
  const lines = source.split(/\r?\n/);
  let fence: { marker: string; length: number; from: number } | null = null;
  let frontMatter = lines[0]?.trim() === "---";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const from = lineStarts[lineIndex];
    const to = from + line.length;
    if (frontMatter) {
      if (lineIndex > 0 && /^(---|\.\.\.)[ \t]*$/.test(line)) {
        ranges.push({ from: 0, to });
        frontMatter = false;
      }
      continue;
    }
    if (fence) {
      const close = line.match(/^[ \t]*(`+|~+)[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        ranges.push({ from: fence.from, to });
        fence = null;
      }
      continue;
    }
    const open = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { marker: open[1][0], length: open[1].length, from };
      continue;
    }
    collectInlineCodeRanges(line, from, ranges);
    collectInlineHtmlRanges(line, from, ranges);
  }
  if (frontMatter) ranges.push({ from: 0, to: source.length });
  if (fence) ranges.push({ from: fence.from, to: source.length });
  return ranges;
}

function collectHtmlBlockRanges(source: string, ranges: Range[]) {
  const block = /<(script|style|pre|textarea|address|article|aside|blockquote|body|details|dialog|div|dl|fieldset|figure|footer|form|header|iframe|main|nav|ol|section|table|ul)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = block.exec(source))) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
}

function collectInlineCodeRanges(line: string, lineOffset: number, ranges: Range[]) {
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let length = 1;
    while (line[index + length] === "`") length += 1;
    const delimiter = "`".repeat(length);
    const close = line.indexOf(delimiter, index + length);
    if (close < 0) {
      index += length;
      continue;
    }
    ranges.push({ from: lineOffset + index, to: lineOffset + close + length });
    index = close + length;
  }
}

function collectInlineHtmlRanges(line: string, lineOffset: number, ranges: Range[]) {
  const paired = /<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = paired.exec(line))) {
    ranges.push({ from: lineOffset + match.index, to: lineOffset + match.index + match[0].length });
  }
  const tag = /<\/?[A-Za-z][^>]*>/g;
  while ((match = tag.exec(line))) {
    ranges.push({ from: lineOffset + match.index, to: lineOffset + match.index + match[0].length });
  }
}

function makeToken(
  source: string,
  lineStarts: number[],
  delimiter: MathDelimiter,
  from: number,
  to: number,
  contentFrom: number,
  contentTo: number,
  displayMode: boolean,
): MarkdownMathToken {
  const location = sourceLocation(lineStarts, from);
  return {
    kind: displayMode ? "display" : "inline",
    delimiter,
    from,
    to,
    contentFrom,
    contentTo,
    raw: source.slice(from, to),
    tex: source.slice(contentFrom, contentTo),
    line: location.line,
    column: location.column,
    displayMode,
  };
}

function collectLineStarts(source: string) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function sourceLocation(lineStarts: number[], offset: number) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const line = Math.max(0, high);
  return { line, column: offset - lineStarts[line] };
}

function rangeAt(ranges: Range[], position: number) {
  return ranges.some((range) => position >= range.from && position < range.to);
}

function rangeOverlaps(ranges: Range[], from: number, to: number) {
  return ranges.some((range) => from < range.to && to > range.from);
}

function isEscaped(source: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function lineBreakLengthAt(source: string, index: number) {
  return source.startsWith("\r\n", index) ? 2 : source[index] === "\n" ? 1 : 0;
}

function lineBreakLengthBefore(source: string, index: number) {
  return source.slice(Math.max(0, index - 2), index) === "\r\n" ? 2 : source[index - 1] === "\n" ? 1 : 0;
}

function readableMathError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw
    .replace(/^KaTeX parse error:\s*/i, "")
    .replace(/\s+at position \d+:\s*/i, "：")
    .replace(/\s+/g, " ")
    .trim();
  return `公式语法错误：${cleaned || "无法解析当前 TeX"}`;
}

function mathErrorOffset(error: unknown) {
  const position = (error as { position?: unknown })?.position;
  if (typeof position === "number" && Number.isFinite(position)) return Math.max(0, position);
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/at position\s+(\d+)/i);
  return match ? Math.max(0, Number.parseInt(match[1], 10) - 1) : undefined;
}

function openingDelimiterLength(delimiter: MathDelimiter, raw: string) {
  if (delimiter === "inline-dollar") return 1;
  if (delimiter === "inline-double-dollar") return 2;
  if (delimiter === "inline-paren") return 2;
  if (delimiter === "display-bracket") return raw.indexOf("\n") + 1 || 2;
  if (delimiter === "display-dollar") return raw.indexOf("\n") + 1 || 2;
  return 0;
}

function closingDelimiterLength(delimiter: MathDelimiter, raw: string) {
  if (delimiter === "inline-dollar") return 1;
  if (delimiter === "inline-double-dollar" || delimiter === "inline-paren") return 2;
  if (delimiter === "display-bracket" || delimiter === "display-dollar") {
    const lineStart = raw.lastIndexOf("\n");
    return lineStart >= 0 ? raw.length - lineStart : 2;
  }
  return 0;
}

function isDisplayDelimiter(delimiter: MathDelimiter) {
  return delimiter === "display-dollar"
    || delimiter === "display-bracket"
    || delimiter === "environment"
    || delimiter === "inline-double-dollar";
}

function sortedMacroNames(macros: MathMacroMap) {
  return Object.keys(macros)
    .filter((name) => name.startsWith("\\"))
    .sort((left, right) => left.localeCompare(right));
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function usesMhchemCommands(tex: string) {
  return /\\(?:ce|pu)\s*\{/.test(tex);
}

function hasVisibleKatexOutput(html: string) {
  return /class="[^"]*\bbase\b/.test(html);
}

function injectEnvironmentGlobalDefinitions(raw: string) {
  return raw.replace(
    /(\\begin\{[^}]+\})/,
    "$1\n\\globaldefs=1 ",
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
