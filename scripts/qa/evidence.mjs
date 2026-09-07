import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function runCaptured(command, args, { cwd = repositoryRoot } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: "", error: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, signal: null, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stdout, stderr, error: null });
    });
  });
}

export async function createEvidenceDirectory(prefix, requestedPath) {
  if (requestedPath) {
    const resolved = path.resolve(requestedPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await mkdir(resolved);
    return resolved;
  }
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commandSummary(result) {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    version: result.stdout.trim() || null,
    stderr: result.stderr.trim() || null,
    availability: result.exitCode === 0 ? "available" : "unknown",
  };
}

function toolExecutable(name) {
  if (process.platform !== "win32") return name;
  if (name === "pnpm") return "pnpm.cmd";
  if (name === "git") return "git.exe";
  if (name === "rustc") return "rustc.exe";
  return name;
}

function isExcludedWorkspacePath(relativePath) {
  return /^(?:\.git|node_modules|dist|target)(?:[\\/]|$)/u.test(relativePath)
    || /(?:^|[\\/])\.lightmark-[^\\/]+/u.test(relativePath);
}

export async function captureWorkspaceHashes(root) {
  const listing = await runCaptured(toolExecutable("git"), ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root });
  if (listing.exitCode !== 0) {
    return {
      source: "git ls-files -co --exclude-standard",
      command: commandSummary(listing),
      files: [],
    };
  }
  const relativePaths = listing.stdout
    .split("\0")
    .filter((value) => value.length > 0 && !isExcludedWorkspacePath(value));
  const files = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(root, relativePath);
    try {
      const content = await readFile(absolutePath);
      files.push({
        path: relativePath.replaceAll("\\", "/"),
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    } catch (error) {
      files.push({
        path: relativePath.replaceAll("\\", "/"),
        error: error.message,
      });
    }
  }
  return {
    source: "git ls-files -co --exclude-standard -z",
    command: commandSummary(listing),
    excluded: [".git", "node_modules", "dist", "target", "scripts/.lightmark-*"],
    files,
  };
}

export async function captureRepositoryEvidence(root, runDir) {
  const [head, status, diff] = await Promise.all([
    runCaptured("git", ["rev-parse", "HEAD"], { cwd: root }),
    runCaptured("git", ["status", "--short"], { cwd: root }),
    runCaptured("git", ["diff", "--no-ext-diff", "--binary", "HEAD"], { cwd: root }),
  ]);
  await writeFile(path.join(runDir, "git-status.txt"), `${status.stdout}${status.stderr}`, "utf8");
  await writeFile(path.join(runDir, "git.diff"), `${diff.stdout}${diff.stderr}`, "utf8");

  const toolCommands = {
    node: [process.execPath, ["--version"]],
    git: [toolExecutable("git"), ["--version"]],
    pnpm: [toolExecutable("pnpm"), ["--version"]],
    rustc: [toolExecutable("rustc"), ["--version"]],
  };
  const toolEntries = await Promise.all(
    Object.entries(toolCommands).map(async ([name, [command, args]]) => [
      name,
      commandSummary(await runCaptured(command, args, { cwd: root })),
    ]),
  );
  const workspace = await captureWorkspaceHashes(root);

  let packageManager = null;
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageManager = packageJson.packageManager ?? null;
  } catch {
    packageManager = null;
  }

  return {
    capturedAt: new Date().toISOString(),
    head: head.stdout.trim() || null,
    headCommand: commandSummary(head),
    packageManager,
    tools: Object.fromEntries(toolEntries),
    workspace,
    git: {
      statusExitCode: status.exitCode,
      diffExitCode: diff.exitCode,
      statusFile: "git-status.txt",
      diffFile: "git.diff",
    },
  };
}
