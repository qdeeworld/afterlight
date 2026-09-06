import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const clientRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkOutput = new URL("../dist/sdk/", import.meta.url);

// Clear only this build's generated directory so stale files cannot enter a pack.
rmSync(sdkOutput, { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.sdk.json"], {
  cwd: clientRoot,
  stdio: "inherit",
});

// Preserve the hand-authored .mjs declaration: inference would widen its API.
mkdirSync(sdkOutput, { recursive: true });
for (const filename of ["setup-authorization.mjs", "setup-authorization.d.mts"]) {
  copyFileSync(new URL(`../src/${filename}`, import.meta.url), new URL(filename, sdkOutput));
}
