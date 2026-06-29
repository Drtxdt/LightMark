export function buildTextDiffSummary(localText: string, diskText: string, limit = 12) {
  const localLines = localText.split(/\r?\n/);
  const diskLines = diskText.split(/\r?\n/);
  const max = Math.max(localLines.length, diskLines.length);
  const summary: string[] = [];
  for (let index = 0; index < max && summary.length < limit; index += 1) {
    const local = localLines[index];
    const disk = diskLines[index];
    if (local === disk) continue;
    const line = index + 1;
    if (local === undefined) {
      summary.push(`磁盘新增 L${line}: ${clipDiffLine(disk)}`);
    } else if (disk === undefined) {
      summary.push(`本地新增 L${line}: ${clipDiffLine(local)}`);
    } else {
      summary.push(`L${line} 磁盘: ${clipDiffLine(disk)}`);
      if (summary.length < limit) summary.push(`L${line} 本地: ${clipDiffLine(local)}`);
    }
  }
  if (summary.length === 0) return ["内容差异仅包含换行或不可见字符。"];
  if (max > summary.length) summary.push("...");
  return summary;
}

function clipDiffLine(value = "") {
  const trimmed = value.trim();
  if (!trimmed) return "(空行)";
  return trimmed.length > 96 ? `${trimmed.slice(0, 96)}...` : trimmed;
}
