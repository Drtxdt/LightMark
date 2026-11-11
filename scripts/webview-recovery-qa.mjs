import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This entry point deliberately delegates to the isolated launcher. It must
// never attach to a caller-selected CDP port or mutate an arbitrary active
// LightMark window. The launcher creates the nonce/profile/process ownership
// evidence and passes only its verified target to runRecoveryBundleProbe.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(repositoryRoot, "scripts", "qa", "isolated-native-evidence.mjs");
const forwarded = process.argv.slice(2);
const forbidden = forwarded.filter((argument) => (
  argument === "--launch"
  || argument === "--scenario"
  || argument.startsWith("--scenario=")
  || argument === "--cdp-port"
  || argument === "--port"
  || argument.startsWith("--cdp-port=")
  || argument.startsWith("--port=")
));
if (forbidden.length) {
  throw new Error("Recovery WebView QA does not accept arbitrary CDP/HTTP ports; use the isolated launcher.");
}

const child = spawn(process.execPath, [launcher, "--launch", "--scenario", "recovery-bundle", ...forwarded], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
process.exitCode = exitCode;
