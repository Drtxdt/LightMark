import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "dist", "index.html"), "utf8");
const entry = html.match(/<script[^>]+src="(?:\.\/|\/)assets\/([^"]+\.js)"/)?.[1];
if (!entry) throw new Error("Unable to resolve the production entry chunk from dist/index.html.");

const gzipBytes = gzipSync(readFileSync(join(root, "dist", "assets", entry))).byteLength;
const limitBytes = 800 * 1024;
if (gzipBytes > limitBytes) {
  throw new Error(`Entry chunk ${entry} is ${(gzipBytes / 1024).toFixed(1)} KiB gzip; budget is 800 KiB.`);
}
console.log(`Entry bundle budget passed: ${entry} ${(gzipBytes / 1024).toFixed(1)} KiB gzip.`);
