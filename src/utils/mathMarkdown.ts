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

export type MathNumberingMode = "none" | "ams-block" | "all-display";

export type MathLabelDefinition = {
  key: string;
  from: number;
  to: number;
  tokenIndex: number;
  duplicate: boolean;
};

export type MathReference = {
  key: string;
  from: number;
  to: number;
  tokenIndex: number;
  targetId?: string;
  display?: string;
};

export type MathEquationTarget = {
  id: string;
  tokenIndex: number;
  line: number;
  display: string;
  labels: string[];
  tex: string;
  autoNumber?: number;
  manualTag?: string;
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
  labels: MathLabelDefinition[];
  references: MathReference[];
  equationTarget: MathEquationTarget | null;
  preparedTex: string;
};

export type MathDocumentEvaluation = {
  entries: MathEvaluationEntry[];
  diagnostics: MathDiagnostic[];
  macroNames: string[];
  usesMhchem: boolean;
  labels: MathLabelDefinition[];
  references: MathReference[];
  equations: MathEquationTarget[];
};

export type PandocMathPreparation = {
  markdown: string;
  latexHeader: string;
  usesMhchem: boolean;
  macroNames: string[];
};

type Range = { from: number; to: number };
type MathMacroMap = Record<string, unknown>;
type MathEvaluationOptions = { numberingMode?: MathNumberingMode };
type MathSemanticCommand = {
  name: "label" | "tag" | "ref";
  value: string;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
};

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

export function evaluateMarkdownMath(
  source: string,
  options: MathEvaluationOptions = {},
): MathDocumentEvaluation {
  const parsed = parseMarkdownMath(source);
  const evaluated = evaluateMathTokens(parsed.tokens, options);
  return {
    ...evaluated,
    diagnostics: [...parsed.diagnostics, ...evaluated.diagnostics]
      .sort((left, right) => left.from - right.from),
  };
}

export function evaluateMathTokens(
  tokens: MarkdownMathToken[],
  options: MathEvaluationOptions = {},
): MathDocumentEvaluation {
  const ordered = [...tokens].sort((left, right) => left.from - right.from);
  const numberingMode = options.numberingMode ?? "none";
  let macros: MathMacroMap = {};
  const preliminary: Array<{
    token: MarkdownMathToken;
    commands: MathSemanticCommand[];
    macrosBefore: MathMacroMap;
    result: MathRenderResult;
    definitions: MathMacroDefinition[];
    definitionOnly: boolean;
    usesMhchem: boolean;
  }> = [];
  const diagnostics: MathDiagnostic[] = [];
  let usesMhchem = false;

  for (const token of ordered) {
    const commands = extractMathSemanticCommands(token.tex);
    const definitions = extractMathMacroDefinitions(token.tex);
    const macrosBefore = { ...macros };
    const workingMacros = { ...macros };
    const validationTex = prepareSemanticTex(token.tex, commands, () => "\\text{??}", false);
    const result = renderMathWithMacros({ ...token, tex: validationTex }, workingMacros, true);
    const tokenUsesMhchem = usesMhchemCommands(token.tex);
    usesMhchem ||= tokenUsesMhchem;

    if (result.ok) macros = workingMacros;
    const definedMacroNames = result.ok
      ? unique(definitions.map((definition) => definition.name))
      : [];
    preliminary.push({
      token,
      commands,
      macrosBefore,
      result,
      definitions,
      definitionOnly: result.ok
        && definedMacroNames.length > 0
        && !hasVisibleKatexOutput(result.html),
      usesMhchem: tokenUsesMhchem,
    });
  }

  const labels: MathLabelDefinition[] = [];
  const references: MathReference[] = [];
  const equations: MathEquationTarget[] = [];
  const labelTargets = new Map<string, MathEquationTarget>();
  const seenLabels = new Set<string>();
  let equationCounter = 0;

  preliminary.forEach((item, tokenIndex) => {
    const labelCommands = item.commands.filter((command) => command.name === "label");
    const tagCommands = item.commands.filter((command) => command.name === "tag");
    const referenceCommands = item.commands.filter((command) => command.name === "ref");
    const isDisplay = item.token.displayMode;

    if (!isDisplay) {
      for (const command of [...labelCommands, ...tagCommands]) {
        diagnostics.push(semanticDiagnostic(item.token, command, `\\${command.name} 只能用于块级公式`));
      }
    }
    if (tagCommands.length > 1) {
      for (const command of tagCommands.slice(1)) {
        diagnostics.push(semanticDiagnostic(item.token, command, "一个公式只能包含一个 \\tag"));
      }
    }

    const manualTag = isDisplay && tagCommands[0]?.value.trim()
      ? tagCommands[0].value.trim()
      : undefined;
    const eligible = isDisplay
      && !item.definitionOnly
      && isAutoNumberEligible(item.token, numberingMode);
    const autoNumber = eligible ? ++equationCounter : undefined;
    const display = manualTag ?? (autoNumber === undefined ? "" : String(autoNumber));
    const target = isDisplay && !item.definitionOnly
      ? {
          id: `lm-equation-${tokenIndex + 1}`,
          tokenIndex,
          line: item.token.line,
          display,
          labels: [] as string[],
          tex: item.token.tex,
          autoNumber,
          manualTag,
        }
      : null;
    if (target) equations.push(target);

    for (const command of labelCommands) {
      const key = command.value.trim();
      if (!key) {
        diagnostics.push(semanticDiagnostic(item.token, command, "公式标签不能为空"));
        continue;
      }
      const absolute = semanticRange(item.token, command);
      const duplicate = seenLabels.has(key);
      seenLabels.add(key);
      const definition: MathLabelDefinition = {
        key,
        ...absolute,
        tokenIndex,
        duplicate,
      };
      labels.push(definition);
      if (!isDisplay) continue;
      if (!target || !target.display) {
        diagnostics.push(semanticDiagnostic(item.token, command, `标签 “${key}” 所在公式没有编号`));
      }
      if (duplicate) {
        diagnostics.push(semanticDiagnostic(item.token, command, `公式标签 “${key}” 重复，引用将跳转到首次定义`));
        continue;
      }
      if (target) {
        target.labels.push(key);
        labelTargets.set(key, target);
      }
    }

    for (const command of referenceCommands) {
      const key = command.value.trim();
      const absolute = semanticRange(item.token, command);
      references.push({ key, ...absolute, tokenIndex });
      if (!key) diagnostics.push(semanticDiagnostic(item.token, command, "公式引用不能为空"));
    }
  });

  const referencesByToken = new Map<number, MathReference[]>();
  for (const reference of references) {
    const target = labelTargets.get(reference.key);
    if (target) {
      reference.targetId = target.id;
      reference.display = target.display || undefined;
      if (!target.display) {
        const token = preliminary[reference.tokenIndex].token;
        const command = preliminary[reference.tokenIndex].commands.find(
          (item) => item.name === "ref"
            && token.contentFrom + item.from === reference.from,
        );
        if (command) diagnostics.push(semanticDiagnostic(
          token,
          command,
          `公式标签 “${reference.key}” 所在公式没有编号`,
        ));
      }
    } else if (reference.key) {
      const token = preliminary[reference.tokenIndex].token;
      const command = preliminary[reference.tokenIndex].commands.find(
        (item) => item.name === "ref"
          && token.contentFrom + item.from === reference.from,
      );
      if (command) diagnostics.push(semanticDiagnostic(token, command, `未找到公式标签 “${reference.key}”`));
    }
    const list = referencesByToken.get(reference.tokenIndex) ?? [];
    list.push(reference);
    referencesByToken.set(reference.tokenIndex, list);
  }

  const entries: MathEvaluationEntry[] = preliminary.map((item, tokenIndex) => {
    const target = equations.find((equation) => equation.tokenIndex === tokenIndex) ?? null;
    const tokenReferences = referencesByToken.get(tokenIndex) ?? [];
    const preparedTex = prepareSemanticTex(
      item.token.tex,
      item.commands,
      (command) => {
        const reference = tokenReferences.find((candidate) =>
          candidate.from === item.token.contentFrom + command.from
        );
        if (!reference?.targetId || !reference.display) return "\\text{??}";
        return `\\href{#${reference.targetId}}{${reference.display}}`;
      },
      Boolean(target),
      target?.display,
    );
    const result = renderMathWithMacros(
      { ...item.token, tex: preparedTex },
      { ...item.macrosBefore },
      true,
    );
    if (!result.ok) diagnostics.push(result.error);
    const definedMacroNames = item.result.ok
      ? unique(item.definitions.map((definition) => definition.name))
      : [];
    return {
      token: item.token,
      result,
      diagnostic: result.ok ? null : result.error,
      availableMacroNames: sortedMacroNames(item.macrosBefore),
      definedMacroNames,
      definitionOnly: item.definitionOnly,
      usesMhchem: item.usesMhchem,
      labels: labels.filter((label) => label.tokenIndex === tokenIndex),
      references: tokenReferences,
      equationTarget: target,
      preparedTex,
    };
  });

  return {
    entries,
    diagnostics: diagnostics.sort((left, right) => left.from - right.from),
    macroNames: sortedMacroNames(macros),
    usesMhchem,
    labels,
    references,
    equations,
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
    const html = katex.renderToString(token.tex, {
      displayMode: token.displayMode,
      throwOnError: true,
      strict: false,
      trust: (context) =>
        context.command === "\\href"
        && typeof context.url === "string"
        && context.url.startsWith("#lm-equation-"),
      maxExpand: 1000,
      globalGroup,
      macros: macros as katex.KatexOptions["macros"],
    });
    return {
      ok: true,
      html: html.replace(/<a href="(#lm-equation-[^"]+)"/g, '<a class="math-ref-link" href="$1"'),
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

export function preparePandocMath(
  markdown: string,
  options: MathEvaluationOptions = {},
): PandocMathPreparation {
  const evaluation = evaluateMarkdownMath(markdown, options);
  const unresolved = evaluation.references.filter(
    (reference) => !reference.targetId || !reference.display,
  );
  if (unresolved.length > 0) {
    throw new Error(`公式引用无法解析：${unique(unresolved.map((item) => item.key || "(空标签)")).join("、")}`);
  }
  let next = markdown;
  for (const entry of [...evaluation.entries].reverse()) {
    const token = entry.token;
    const relativeContentFrom = token.contentFrom - token.from;
    let tex = token.tex;
    if (entry.equationTarget && !entry.equationTarget.manualTag) {
      tex = `${tex}\\tag{${entry.equationTarget.display}}`;
    }
    if (entry.definedMacroNames.length > 0) {
      tex = token.delimiter === "environment"
        ? injectEnvironmentGlobalDefinitions(tex)
        : `\\globaldefs=1 ${tex}`;
    }
    if (tex === token.tex) continue;
    const raw = `${token.raw.slice(0, relativeContentFrom)}${tex}${token.raw.slice(relativeContentFrom + token.tex.length)}`;
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

export function extractMathSemanticCommands(tex: string): MathSemanticCommand[] {
  const commands: MathSemanticCommand[] = [];
  for (let index = 0; index < tex.length; index += 1) {
    if (tex[index] !== "\\" || isEscaped(tex, index)) continue;
    const match = tex.slice(index).match(/^\\(label|tag|ref)\s*\{/);
    if (!match) continue;
    const open = index + match[0].lastIndexOf("{");
    let depth = 1;
    let close = open + 1;
    for (; close < tex.length; close += 1) {
      if (isEscaped(tex, close)) continue;
      if (tex[close] === "{") depth += 1;
      else if (tex[close] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    commands.push({
      name: match[1] as MathSemanticCommand["name"],
      value: tex.slice(open + 1, close),
      from: index,
      to: close + 1,
      contentFrom: open + 1,
      contentTo: close,
    });
    index = close;
  }
  return commands;
}

function prepareSemanticTex(
  tex: string,
  commands: MathSemanticCommand[],
  renderReference: (command: MathSemanticCommand) => string,
  includeTag: boolean,
  display?: string,
) {
  let next = "";
  let cursor = 0;
  for (const command of commands) {
    next += tex.slice(cursor, command.from);
    if (command.name === "ref") next += renderReference(command);
    cursor = command.to;
  }
  next += tex.slice(cursor);
  if (includeTag && display) next += `\\tag{${display}}`;
  return next;
}

function isAutoNumberEligible(token: MarkdownMathToken, mode: MathNumberingMode) {
  if (mode === "none") return false;
  if (mode === "all-display") return token.displayMode;
  if (token.delimiter !== "environment") return false;
  const environment = token.tex.match(/^\s*\\begin\{([^}]+)\}/)?.[1] ?? "";
  return environment === "equation"
    || environment === "align"
    || environment === "gather"
    || environment === "multline";
}

function semanticRange(token: MarkdownMathToken, command: MathSemanticCommand) {
  return {
    from: token.contentFrom + command.from,
    to: token.contentFrom + command.to,
  };
}

function semanticDiagnostic(
  token: MarkdownMathToken,
  command: MathSemanticCommand,
  message: string,
): MathDiagnostic {
  return {
    ...semanticRange(token, command),
    message,
    severity: "error",
    texOffset: command.from,
    token,
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
