export type PairAction =
  | { type: "wrap"; open: string; close: string }
  | { type: "insert"; open: string; close: string }
  | { type: "skip" }
  | { type: "delete" }
  | null;

export type ListContinuation =
  | { type: "continue"; insert: string }
  | { type: "exit"; markerLength: number }
  | null;

export type MarkdownShortcutKind =
  | "horizontal-rule"
  | "table"
  | "blockquote"
  | "alert"
  | "task"
  | "footnote-reference"
  | "footnote-definition";

export type MarkdownShortcutMatch =
  | { kind: "horizontal-rule"; marker: "-" | "*" | "_" }
  | { kind: "table"; headers: string[] }
  | { kind: "blockquote"; depth: number; text: string }
  | { kind: "alert"; alert: "note" | "tip" | "important" | "warning" | "caution"; text: string }
  | { kind: "task"; checked: boolean; marker: string }
  | { kind: "footnote-reference"; id: string; from: number; to: number }
  | { kind: "footnote-definition"; id: string; text: string };

export interface MarkdownShortcutInput {
  text: string;
  trigger: "enter" | "text";
  insertedText?: string;
  atDocumentStart?: boolean;
  protectedContext?: boolean;
  insideListItem?: boolean;
  insideBlockquote?: boolean;
  composing?: boolean;
}

const pairs: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

const closingCharacters = new Set(Object.values(pairs));

export function pairedCharacter(key: string) {
  return pairs[key] ?? null;
}

export function decidePairAction(input: {
  key: string;
  selectedText?: string;
  before?: string;
  after?: string;
  composing?: boolean;
}): PairAction {
  if (input.composing || input.key.length !== 1 && input.key !== "Backspace") return null;
  const selectedText = input.selectedText ?? "";
  const before = input.before ?? "";
  const after = input.after ?? "";

  if (input.key === "Backspace") {
    if (!selectedText && before && pairs[before] === after) return { type: "delete" };
    return null;
  }

  // Backticks are Markdown syntax delimiters. Auto-inserting a closing
  // backtick breaks the natural ``` fenced-code sequence, so only wrap an
  // explicit selection and otherwise leave the editor's Markdown rules in charge.
  if (input.key === "`") {
    return selectedText ? { type: "wrap", open: "`", close: "`" } : null;
  }

  const close = pairs[input.key];
  if (close) {
    if (input.key === "'" && !selectedText && /[\p{L}\p{N}]$/u.test(before)) return null;
    if (selectedText) return { type: "wrap", open: input.key, close };
    if (after === input.key && closingCharacters.has(input.key)) return { type: "skip" };
    return { type: "insert", open: input.key, close };
  }

  if (!selectedText && closingCharacters.has(input.key) && after === input.key) return { type: "skip" };
  return null;
}

export function listContinuationForLine(lineBeforeCursor: string): ListContinuation {
  const match = lineBeforeCursor.match(/^(\s*)([-+*]|(\d+)([.)]))\s+(?:(\[[ xX]\])\s+)?(.*)$/);
  if (!match) return null;
  const [, indent, marker, number, numberSuffix, task, content] = match;
  const markerLength = lineBeforeCursor.length - content.length;
  if (!content.trim()) return { type: "exit", markerLength };

  const nextMarker = number ? `${Number(number) + 1}${numberSuffix}` : marker;
  const taskPrefix = task ? "[ ] " : "";
  return { type: "continue", insert: `\n${indent}${nextMarker} ${taskPrefix}` };
}

export function isMarkdownTableLine(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 3;
}

export function isInsideFencedCode(markdown: string, position: number) {
  const before = markdown.slice(0, position).split(/\r?\n/);
  let fence: "```" | "~~~" | null = null;
  for (const line of before) {
    const match = line.match(/^\s*(```|~~~)/);
    if (!match) continue;
    if (!fence) fence = match[1] as "```" | "~~~";
    else if (match[1] === fence) fence = null;
  }
  return Boolean(fence);
}

export function codeBlockIndentEdits(text: string, from: number, to: number, reverse: boolean) {
  if (from === to) return reverse ? [] : [{ from, to: from, insert: "  " }];
  const effectiveTo = Math.max(from, to - 1);
  const firstLineStart = text.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const lineStarts = [firstLineStart];
  for (let index = text.indexOf("\n", firstLineStart); index >= 0 && index < effectiveTo; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  return lineStarts.map((lineStart) => {
    if (!reverse) return { from: lineStart, to: lineStart, insert: "  " };
    const prefix = text.slice(lineStart, lineStart + 2);
    const remove = prefix.startsWith("  ") ? 2 : prefix.startsWith("\t") || prefix.startsWith(" ") ? 1 : 0;
    return { from: lineStart, to: lineStart + remove, insert: "" };
  }).filter((edit) => edit.from !== edit.to || edit.insert);
}

/**
 * Recognizes Typora-style Markdown shortcuts without mutating editor state.
 * Callers remain responsible for checking structural editor context and for
 * applying the returned conversion as one history transaction.
 */
export function detectMarkdownShortcut(input: MarkdownShortcutInput): MarkdownShortcutMatch | null {
  if (input.protectedContext || input.composing) return null;
  const text = input.text.replace(/\r\n?/g, "\n");

  if (input.trigger === "text") {
    const insertedText = input.insertedText ?? "";
    const candidate = `${text}${insertedText}`;

    if (insertedText === " ") {
      const task = candidate.match(/^\s*(?:(-?|\+|\*|\d+[.)])\s+)?\[([ xX])\]\s$/);
      if (task && (input.insideListItem || Boolean(task[1]))) {
        return { kind: "task", checked: task[2].toLowerCase() === "x", marker: task[1] || "-" };
      }
    }

    if (insertedText === "]") {
      const reference = candidate.match(/(?:^|[^\\])\[\^([^\]\n]+)\]$/);
      if (!reference) return null;
      const raw = reference[0];
      const relative = raw.lastIndexOf("[^");
      const from = candidate.length - raw.length + relative;
      // A reference at the beginning of a line may still become a definition
      // when the user types ':', so leave that form literal for the Enter rule.
      if (from === 0) return null;
      const id = reference[1].trim();
      return id ? { kind: "footnote-reference", id, from, to: candidate.length } : null;
    }

    return null;
  }

  const definition = text.match(/^ {0,3}\[\^([^\]\n]+)\]:[ \t]*(.*)$/);
  if (definition) {
    const id = definition[1].trim();
    if (id) return { kind: "footnote-definition", id, text: definition[2] };
  }

  const alertPattern = input.insideBlockquote
    ? /^ {0,3}\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.*))?$/i
    : /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.*))?$/i;
  const alert = text.match(alertPattern);
  if (alert) {
    return {
      kind: "alert",
      alert: alert[1].toLowerCase() as "note" | "tip" | "important" | "warning" | "caution",
      text: alert[2] || "",
    };
  }

  const rule = text.match(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/);
  if (rule && !(input.atDocumentStart && rule[1] === "-")) {
    return { kind: "horizontal-rule", marker: rule[1] as "-" | "*" | "_" };
  }

  const headers = parseShortcutTableHeaders(text);
  if (headers) return { kind: "table", headers };

  const quote = text.match(/^ {0,3}(>+)[ \t]+(.*)$/);
  if (quote) return { kind: "blockquote", depth: quote[1].length, text: quote[2] };

  return null;
}

function parseShortcutTableHeaders(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("|") || !hasUnescapedTrailingPipe(trimmed)) return null;
  const body = trimmed.slice(1, -1);
  const headers: string[] = [];
  let current = "";
  let escaped = false;
  let codeFence = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (body[index + run] === "`") run += 1;
      current += "`".repeat(run);
      if (codeFence === 0) codeFence = run;
      else if (codeFence === run) codeFence = 0;
      index += run - 1;
      continue;
    }
    if (character === "|" && codeFence === 0) {
      headers.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  headers.push(current.trim());
  if (headers.length < 2 || headers.some((header) => !header)) return null;
  if (headers.every((header) => /^:?-{3,}:?$/.test(header.replace(/\s/g, "")))) return null;
  return headers;
}

function hasUnescapedTrailingPipe(value: string) {
  if (!value.endsWith("|")) return false;
  let slashes = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 0;
}
