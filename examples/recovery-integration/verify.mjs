#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, copyFile, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleDirectory = path.dirname(fileURLToPath(import.meta.url));
const [tarballArgument, ...unexpected] = process.argv.slice(2);
if (!tarballArgument || unexpected.length > 0 || !tarballArgument.endsWith(".tgz")) {
  throw new Error("Usage: node examples/recovery-integration/verify.mjs /absolute/path/afterlight-recovery-0.1.0.tgz");
}
const tarball = await realpath(path.resolve(tarballArgument));
assert.equal((await stat(tarball)).isFile(), true, "SDK tarball must be a regular file");
const lockfile = JSON.parse(await readFile(path.join(exampleDirectory, "package-lock.json"), "utf8"));
const lockedIntegrity = lockfile.packages?.["node_modules/@afterlight/recovery"]?.integrity;
const tarballIntegrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
assert.equal(tarballIntegrity, lockedIntegrity,
  "SDK archive differs from the reviewed consumer lockfile; regenerate with refresh-lock.mjs and review the diff");
const consumerDirectory = await mkdtemp(path.join(tmpdir(), "afterlight-recovery-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: consumerDirectory,
    stdio: "inherit",
    timeout: 180_000,
    env: { ...process.env, NODE_PATH: "" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Consumer verification command failed: ${command} (exit ${result.status})`);
}

try {
  await copyFile(tarball, path.join(consumerDirectory, "afterlight-recovery.tgz"));
  await copyFile(path.join(exampleDirectory, "package.json"), path.join(consumerDirectory, "package.json"));
  await copyFile(path.join(exampleDirectory, "package-lock.json"), path.join(consumerDirectory, "package-lock.json"));
  await copyFile(path.join(exampleDirectory, "tsconfig.json"), path.join(consumerDirectory, "tsconfig.json"));
  await cp(path.join(exampleDirectory, "src"), path.join(consumerDirectory, "src"), { recursive: true });
  run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  run(npm, ["audit", "--audit-level=high"]);

  const installedDirectory = await realpath(path.join(consumerDirectory, "node_modules", "@afterlight", "recovery"));
  const expectedDirectory = path.join(await realpath(consumerDirectory), "node_modules", "@afterlight", "recovery");
  assert.equal(installedDirectory, expectedDirectory, "Consumer must use an unpacked tarball, not a workspace symlink");
  const installed = JSON.parse(await readFile(path.join(installedDirectory, "package.json"), "utf8"));
  assert.equal(installed.name, "@afterlight/recovery");
  assert.equal(installed.version, "0.1.0");
  assert.equal(installed.type, "module");
  run(npm, ["run", "check"]);
  console.log("PASS: isolated packed-SDK consumer; TypeScript, browser bundle and local fixture checks. No wallet or chain execution.");
} finally {
  // This exact directory was created by mkdtemp above and contains only copies,
  // installed dependencies and generated verification output owned by this run.
  await rm(consumerDirectory, { recursive: true, force: true });
}
