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
