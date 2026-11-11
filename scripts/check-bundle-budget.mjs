import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = process.argv.indexOf('--dist');
if (distIndex >= 0 && (!process.argv[distIndex + 1] || process.argv[distIndex + 1].startsWith('--'))) throw new Error('--dist requires an artifact directory');
const distRoot = distIndex >= 0 ? resolve(process.argv[distIndex + 1]) : join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(distRoot, ".vite/manifest.json"), "utf8"));
const entry = Object.keys(manifest).find(key => manifest[key].isEntry && key.endsWith(".html"));
if (!entry) throw new Error("The build manifest has no application entry.");
function closure(roots) {
  const visited = new Set();
  const queue = [...roots];
  while (queue.length) {
    const key = queue.pop();
    if (visited.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing build manifest dependency: ${key}`);
    visited.add(key);
    queue.push(...(chunk.imports ?? []));
  }
  const files = [...new Set([...visited].map(key => manifest[key].file))].filter(file => file.endsWith(".js"));
  const artifacts = files.sort().map(file => {
    const content = readFileSync(join(distRoot, file));
    return { file, bytes: content.byteLength, gzipBytes: gzipSync(content).byteLength, sha256: createHash("sha256").update(content).digest("hex") };
  });
  return { artifacts, files, bytes: artifacts.reduce((sum, artifact) => sum + artifact.gzipBytes, 0) };
}
const budgets = [
  { name: "Shell", roots: [entry], limitKiB: 210 },
  { name: "Shell + Source", roots: [entry, "src/components/editor/SourceEditor.vue"], limitKiB: 330 },
  { name: "Shell + WYS", roots: [entry, "src/components/editor/WysiwygEditor.vue"], limitKiB: 650 },
];
const failures = [];
const measurements = [];
for (const budget of budgets) {
  const result = closure(budget.roots);
  const size = result.bytes / 1024;
  measurements.push({ ...budget, gzipBytes: result.bytes, gzipKiB: size, passed: size <= budget.limitKiB, artifacts: result.artifacts });
  if (!process.argv.includes("--json")) console.log(`${budget.name}: ${size.toFixed(1)} KiB gzip, ${result.files.length} static JS chunks, budget ${budget.limitKiB} KiB.`);
  if (size > budget.limitKiB) failures.push(`${budget.name} exceeds ${budget.limitKiB} KiB`);
}
if (process.argv.includes("--json")) console.log(JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), metric: "sum of individually gzipped unique static JavaScript dependencies; dynamic imports and CSS excluded", manifestSha256: createHash("sha256").update(readFileSync(join(distRoot, ".vite/manifest.json"))).digest("hex"), measurements }, null, 2));
if (failures.length) throw new Error(failures.join("; "));
