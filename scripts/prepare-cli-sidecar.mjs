import { copyFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tauriRoot = path.join(root, "src-tauri");
const triple = process.env.TARGET || "x86_64-pc-windows-msvc";
const executable = process.platform === "win32" ? "lightmark-cli.exe" : "lightmark-cli";
const source = path.join(tauriRoot, "target", "release", executable);
const destinationDirectory = path.join(tauriRoot, "binaries");
const destination = path.join(
  destinationDirectory,
  process.platform === "win32"
    ? `lightmark-cli-${triple}.exe`
    : `lightmark-cli-${triple}`,
);

execFileSync(
  "cargo",
  ["build", "--manifest-path", path.join(tauriRoot, "Cargo.toml"), "--release", "--bin", "lightmark-cli"],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }),
    },
  },
);
mkdirSync(destinationDirectory, { recursive: true });
copyFileSync(source, destination);
console.log(`Prepared CLI sidecar: ${destination}`);
