export type FindReplaceOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export type TextMatch = {
  from: number;
  to: number;
  text: string;
  groups?: string[];
};

export type FindResult = {
  matches: TextMatch[];
  error: string;
};

export function findTextMatches(text: string, query: string, options: FindReplaceOptions): FindResult {
  if (!query) return { matches: [], error: "" };

  if (options.regex) {
    return findRegexMatches(text, query, options);
  }

  return findLiteralMatches(text, query, options);
}

export function replacementForMatch(match: TextMatch, replacement: string, regex: boolean) {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|`|'|\d{1,2})/g, (token, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return match.text;
    if (/^\d+$/.test(key)) return match.groups?.[Number(key) - 1] ?? "";
    return token;
  });
}

export function replaceAllText(text: string, query: string, replacement: string, options: FindReplaceOptions) {
  const result = findTextMatches(text, query, options);
  if (result.error || result.matches.length === 0) return { text, count: 0, error: result.error };

  let next = "";
  let cursor = 0;
  for (const match of result.matches) {
    next += text.slice(cursor, match.from);
    next += replacementForMatch(match, replacement, options.regex);
    cursor = match.to;
  }
  next += text.slice(cursor);
  return { text: next, count: result.matches.length, error: "" };
}

export function normalizeMatchIndex(index: number, total: number) {
  if (total <= 0) return -1;
  return ((index % total) + total) % total;
}

function findLiteralMatches(text: string, query: string, options: FindReplaceOptions): FindResult {
  const source = options.caseSensitive ? text : text.toLocaleLowerCase();
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const matches: TextMatch[] = [];
  let from = 0;

  while (from <= source.length) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    const to = index + needle.length;
    if (!options.wholeWord || isWholeWordMatch(text, index, to)) {
      matches.push({ from: index, to, text: text.slice(index, to) });
    }
    from = Math.max(to, index + 1);
  }

  return { matches, error: "" };
}

function findRegexMatches(text: string, query: string, options: FindReplaceOptions): FindResult {
  let regex: RegExp;
  try {
    regex = new RegExp(query, options.caseSensitive ? "gu" : "giu");
  } catch (error) {
    return { matches: [], error: error instanceof Error ? error.message : "无效正则表达式" };
  }

  const matches: TextMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const value = match[0];
    const from = match.index;
    const to = from + value.length;
    if (value.length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    if (!options.wholeWord || isWholeWordMatch(text, from, to)) {
      matches.push({ from, to, text: value, groups: match.slice(1) });
    }
  }

  return { matches, error: "" };
}

function isWholeWordMatch(text: string, from: number, to: number) {
  return !isWordChar(text.charAt(from - 1)) && !isWordChar(text.charAt(to));
}

function isWordChar(value: string) {
  return /[\p{L}\p{N}_]/u.test(value);
}
