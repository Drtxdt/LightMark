export type LeadingFrontMatter = {
  yaml: string;
  rest: string;
};

export function splitLeadingFrontMatter(markdown: string): LeadingFrontMatter | null {
  const match = markdown.match(/^(?:\uFEFF)?---[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)(?:---|\.\.\.)[^\S\r\n]*(?:(?:\r?\n)+|$)/);
  if (!match) return null;
  return {
    yaml: match[1],
    rest: markdown.slice(match[0].length),
  };
}

export function markdownForNativeExport(markdown: string, includeYamlFrontMatter: boolean) {
  if (includeYamlFrontMatter) return markdown;
  return splitLeadingFrontMatter(markdown)?.rest ?? markdown;
}

export function markdownForPandocExport(markdown: string, includeYamlFrontMatter: boolean) {
  const frontMatter = splitLeadingFrontMatter(markdown);
  if (!frontMatter) return markdown;
  if (!includeYamlFrontMatter) return frontMatter.rest;
  const yaml = frontMatter.yaml.replace(/\s+$/, "");
  return `\`\`\`yaml\n${yaml}\n\`\`\`\n\n${frontMatter.rest}`;
}
