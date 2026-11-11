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

  // Match the original string: Unicode case conversion can change its UTF-16
  // length, so offsets from a lowercased copy cannot select original text.
  const pattern = options.regex ? query : query.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.caseSensitive ? "gu" : "giu");
  } catch (error) {
    return { matches: [], error: error instanceof Error ? error.message : "无效正则表达式" };
  }
  const matches: TextMatch[] = [];
  for (const result of text.matchAll(regex)) {
    const value = result[0];
    if (!value) continue;
    const from = result.index;
    const to = from + value.length;
    if (options.wholeWord && !isWholeWordMatch(text, from, to)) continue;
    const match: TextMatch = { from, to, text: value };
    if (options.regex) match.groups = result.slice(1);
    matches.push(match);
  }
  return { matches, error: "" };
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

function isWholeWordMatch(text: string, from: number, to: number) {
  const low = text.charCodeAt(from - 1), high = text.charCodeAt(from - 2);
  const prev = from - (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1);
  return !isWordChar(text.codePointAt(prev)) && !isWordChar(text.codePointAt(to));
}

function isWordChar(code: number | undefined) {
  return code !== undefined && /[\p{L}\p{N}_]/u.test(String.fromCodePoint(code));
}
