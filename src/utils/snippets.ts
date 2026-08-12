import type {
  SlashCommandDefinition,
  SnippetDefinition,
  SnippetExpansionContext,
  SnippetExpansionResult,
} from "../types";

const VARIABLE_NAMES = ["cursor", "selection", "date", "time"] as const;
const VARIABLE_PATTERN = /\\?\$\{(cursor|selection|date|time)\}/g;

export const builtinSlashCommands: SlashCommandDefinition[] = [
  command("paragraph", "正文", "转换为普通段落", ["paragraph", "text", "正文"], "基础", "paragraph"),
  ...([1, 2, 3, 4, 5, 6] as const).map((level) =>
    command(`heading-${level}`, `标题 ${level}`, `转换为 ${level} 级标题`, [`h${level}`, `heading${level}`, `标题${level}`], "基础", "heading", level),
  ),
  command("bullet-list", "无序列表", "创建项目符号列表", ["ul", "bullet", "列表"], "结构", "bulletList"),
  command("ordered-list", "有序列表", "创建编号列表", ["ol", "ordered", "编号"], "结构", "orderedList"),
  command("task-list", "任务列表", "创建未完成任务", ["todo", "task", "待办"], "结构", "taskList"),
  command("blockquote", "引用", "创建引用块", ["quote", "blockquote", "引用"], "结构", "blockquote"),
  command("code-block", "代码块", "创建围栏代码块", ["code", "fence", "代码"], "结构", "codeBlock"),
  command("math-block", "公式块", "创建块级数学公式", ["math", "latex", "公式"], "结构", "mathBlock"),
  command("table", "表格", "创建 2 × 2 表格", ["table", "grid", "表格"], "插入", "table"),
  command("horizontal-rule", "分隔线", "插入水平分隔线", ["divider", "rule", "hr", "分隔"], "插入", "horizontalRule"),
  command("image", "图片", "插入图片占位符", ["image", "picture", "图片"], "插入", "image"),
  command("toc", "目录", "插入文档目录", ["toc", "目录"], "插入", "toc"),
  ...(["note", "tip", "important", "warning", "caution"] as const).map((kind) =>
    command(`alert-${kind}`, alertLabel(kind), `创建 ${kind.toUpperCase()} 警示框`, [kind, "alert", "callout", "警示"], "警示框", "alert", kind),
  ),
];

export const reservedSnippetTriggers = new Set(
  builtinSlashCommands.flatMap((item) => [item.id, item.label, ...item.keywords].map(normalizeSearchText)),
);

export function expandSnippet(markdown: string, context: SnippetExpansionContext): SnippetExpansionResult {
  const now = context.now ?? new Date();
  const replacements: Record<(typeof VARIABLE_NAMES)[number], string> = {
    cursor: "",
    selection: context.selection,
    date: localDate(now),
    time: localTime(now),
  };
  let result = "";
  let cursorOffset = -1;
  let usedSelection = false;
  let sourceOffset = 0;
  for (const match of markdown.matchAll(VARIABLE_PATTERN)) {
    const index = match.index ?? 0;
    result += markdown.slice(sourceOffset, index);
    const raw = match[0];
    const name = match[1] as (typeof VARIABLE_NAMES)[number];
    if (raw.startsWith("\\")) {
      result += raw.slice(1);
    } else {
      if (name === "cursor" && cursorOffset < 0) cursorOffset = result.length;
      if (name === "selection") usedSelection = true;
      result += replacements[name];
    }
    sourceOffset = index + raw.length;
  }
  result += markdown.slice(sourceOffset);
  return {
    markdown: result,
    cursorOffset: cursorOffset < 0 ? result.length : cursorOffset,
    usedSelection,
  };
}

export function normalizeSnippets(value: unknown): SnippetDefinition[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const triggers = new Set<string>();
  const result: SnippetDefinition[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<SnippetDefinition>;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 80) : "";
    const trigger = typeof item.trigger === "string" ? item.trigger.trim().slice(0, 40) : "";
    const markdown = typeof item.markdown === "string" ? item.markdown.slice(0, 65_536) : "";
    const normalizedTrigger = normalizeSearchText(trigger);
    if (!name || !validSnippetTrigger(trigger) || triggers.has(normalizedTrigger) || reservedSnippetTriggers.has(normalizedTrigger)) continue;
    let id = typeof item.id === "string" ? item.id.trim().slice(0, 80) : "";
    if (!id || ids.has(id)) id = createSnippetId(ids);
    ids.add(id);
    triggers.add(normalizedTrigger);
    result.push({
      id,
      name,
      trigger,
      description: typeof item.description === "string" ? item.description.trim().slice(0, 160) : "",
      markdown,
      enabled: item.enabled !== false,
    });
    if (result.length >= 200) break;
  }
  return result;
}

export function validateSnippet(candidate: SnippetDefinition, siblings: SnippetDefinition[]) {
  if (!candidate.name.trim()) return "请输入片段名称。";
  if (!validSnippetTrigger(candidate.trigger)) return "触发词不能包含空白或“/”，长度须为 1–40 个字符。";
  const trigger = normalizeSearchText(candidate.trigger);
  if (reservedSnippetTriggers.has(trigger)) return "该触发词已被内置命令使用。";
  if (siblings.some((item) => item.id !== candidate.id && normalizeSearchText(item.trigger) === trigger)) return "触发词不能重复。";
  if (candidate.markdown.length > 65_536) return "单个片段不能超过 64 KiB。";
  return "";
}

export function snippetSlashCommands(items: SnippetDefinition[]): SlashCommandDefinition[] {
  return items.filter((item) => item.enabled).map((item) => ({
    id: `snippet-${item.id}`,
    label: item.name,
    description: item.description || `/${item.trigger}`,
    keywords: [item.trigger, item.name, item.description],
    category: "片段",
    kind: "snippet",
    snippetId: item.id,
  }));
}

export function filterSlashCommands(items: SlashCommandDefinition[], query: string) {
  const needle = normalizeSearchText(query);
  if (!needle) return items;
  return items
    .map((item, index) => ({ item, index, score: slashMatchScore(item, needle) }))
    .filter((entry) => entry.score < 99)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
}

export function validSnippetTrigger(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && !/[\s/]/u.test(trimmed);
}

function command(
  id: string,
  label: string,
  description: string,
  keywords: string[],
  category: SlashCommandDefinition["category"],
  action: string,
  value?: string | number,
): SlashCommandDefinition {
  return { id, label, description, keywords, category, kind: "builtin", action, value };
}

function alertLabel(kind: string) {
  return ({ note: "提示", tip: "技巧", important: "重要", warning: "警告", caution: "注意" } as Record<string, string>)[kind] || kind;
}

function normalizeSearchText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function slashMatchScore(item: SlashCommandDefinition, needle: string) {
  const label = normalizeSearchText(item.label);
  const keywords = item.keywords.map(normalizeSearchText);
  if (label === needle || keywords.includes(needle)) return 0;
  if (label.startsWith(needle)) return 1;
  if (keywords.some((value) => value.startsWith(needle))) return 2;
  if (label.includes(needle)) return 3;
  if (keywords.some((value) => value.includes(needle)) || normalizeSearchText(item.description).includes(needle)) return 4;
  return 99;
}

function createSnippetId(existing: Set<string>) {
  let index = existing.size + 1;
  while (existing.has(`snippet-${index}`)) index += 1;
  return `snippet-${index}`;
}

function localDate(value: Date) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function localTime(value: Date) {
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
