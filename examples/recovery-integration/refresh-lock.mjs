#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicit maintainer operation: generate the dependency lock for a reviewed SDK
// archive. Ordinary verification uses npm ci and never modifies this lockfile.
const exampleDirectory = path.dirname(fileURLToPath(import.meta.url));
const [tarballArgument, ...unexpected] = process.argv.slice(2);
if (!tarballArgument || unexpected.length > 0 || !tarballArgument.endsWith(".tgz")) {
  throw new Error("Usage: node examples/recovery-integration/refresh-lock.mjs /absolute/path/afterlight-recovery-0.1.0.tgz");
}
const tarball = await realpath(path.resolve(tarballArgument));
assert.equal((await stat(tarball)).isFile(), true, "SDK tarball must be a regular file");
const expectedIntegrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
const lockDirectory = await mkdtemp(path.join(tmpdir(), "afterlight-recovery-lock-"));

try {
  await copyFile(tarball, path.join(lockDirectory, "afterlight-recovery.tgz"));
  await copyFile(path.join(exampleDirectory, "package.json"), path.join(lockDirectory, "package.json"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: lockDirectory,
    stdio: "inherit",
    timeout: 180_000,
    env: { ...process.env, NODE_PATH: "" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Lockfile generation failed (exit ${result.status})`);
  const generatedPath = path.join(lockDirectory, "package-lock.json");
  const generated = JSON.parse(await readFile(generatedPath, "utf8"));
  assert.equal(generated.packages?.["node_modules/@afterlight/recovery"]?.integrity, expectedIntegrity);
  await copyFile(generatedPath, path.join(exampleDirectory, "package-lock.json"));
  console.log("Updated consumer package-lock.json. Review all dependency changes, then run verify.mjs against the same archive.");
} finally {
  // This exact directory was created by this run and contains only generated
  // dependency metadata and copies of the supplied package inputs.
  await rm(lockDirectory, { recursive: true, force: true });
}
