import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
  classifyCheck,
  categoryNote,
  CATEGORY_DESCRIPTIONS,
  EXPLICIT_QA_GATES,
} from "./qa/check-catalog.mjs";
import {
  captureRepositoryEvidence,
  createEvidenceDirectory,
  repositoryRoot,
  runCaptured,
  writeJson,
} from "./qa/evidence.mjs";

const scriptsDirectory = path.join(repositoryRoot, "scripts");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const requestedOutput = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

const checks = await discoverChecks();
if (args.includes("--list")) {
  console.log(JSON.stringify(checks.map((fileName) => ({
    fileName,
    category: classifyCheck(fileName),
    note: categoryNote(fileName),
    description: CATEGORY_DESCRIPTIONS[classifyCheck(fileName)],
  })), null, 2));
} else {
  await runChecks(checks, requestedOutput);
}

async function discoverChecks() {
  const entries = await readdir(scriptsDirectory, { withFileTypes: true });
  const discovered = entries
    .filter((entry) => entry.isFile() && /^check-.*\.mjs$/u.test(entry.name) && entry.name !== "check-all.mjs")
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return [...discovered, ...EXPLICIT_QA_GATES].sort((left, right) => left.localeCompare(right));
}

async function runChecks(fileNames, requestedPath) {
  const startedAt = new Date().toISOString();
  const runDir = await createEvidenceDirectory("lightmark-check-all-", requestedPath);
  const checksDir = path.join(runDir, "checks");
  await mkdir(checksDir, { recursive: true });
  const repository = await captureRepositoryEvidence(repositoryRoot, runDir);
  const manifest = {
    schemaVersion: 1,
    kind: "lightmark-check-all",
    startedAt,
    repositoryRoot,
    runDir,
    discovery: {
      directory: scriptsDirectory,
      recursive: false,
      excluded: "check-all.mjs",
      explicitQaGates: EXPLICIT_QA_GATES,
      count: fileNames.length,
    },
    categories: CATEGORY_DESCRIPTIONS,
    execution: {
      entryScript: "scripts/check-all.mjs",
      importedHelpers: ["scripts/qa/check-catalog.mjs", "scripts/qa/evidence.mjs"],
      checks: fileNames.map((fileName) => {
        const relativePath = `scripts/${fileName}`;
        const file = repository.workspace.files.find((entry) => entry.path === relativePath);
        return { path: relativePath, sha256: file?.sha256 ?? null };
      }),
    },
    repository,
  };
  await writeJson(path.join(runDir, "manifest.json"), manifest);

  const results = [];
  for (const fileName of fileNames) {
    const category = classifyCheck(fileName);
    const relativeScript = path.join("scripts", fileName);
    const started = Date.now();
    const command = [process.execPath, relativeScript];
    const processResult = await runCaptured(process.execPath, [path.join(repositoryRoot, relativeScript)], { cwd: repositoryRoot });
    const result = {
      fileName,
      category,
      note: categoryNote(fileName),
      command,
      cwd: repositoryRoot,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      error: processResult.error,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
    };
    results.push(result);
    const resultPath = path.join(checksDir, `${fileName}.json`);
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeJson(resultPath, result);
    await writeJson(path.join(runDir, "summary.json"), { ...manifest, results });
    const state = result.exitCode === 0 ? "PASS" : "FAIL";
    console.log(`[${state}] [${category}] ${fileName} exit=${String(result.exitCode)}${result.signal ? ` signal=${result.signal}` : ""}`);
    if (state === "FAIL" && (result.stdout || result.stderr || result.error)) {
      if (result.stdout) console.error(result.stdout.trimEnd());
      if (result.stderr) console.error(result.stderr.trimEnd());
      if (result.error) console.error(result.error);
    }
  }

  const failed = results.filter((result) => result.exitCode !== 0);
  const summary = {
    ...manifest,
    finishedAt: new Date().toISOString(),
    results,
    totals: {
      count: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
    },
    ok: failed.length === 0,
  };
  await writeJson(path.join(runDir, "summary.json"), summary);
  console.log(`Evidence retained at ${runDir}`);
  console.log(`check-all: ${summary.totals.passed}/${summary.totals.count} passed; failed=${summary.totals.failed}`);
  if (failed.length > 0) process.exitCode = 1;
}
