import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const clientRoot = fileURLToPath(new URL("../", import.meta.url));
const publicModules = ["index", "actions", "encoding", "exit-preflight", "keys", "messages", "relay"];
const sdkFiles = [
  ...publicModules.flatMap((name) => [`${name}.js`, `${name}.d.ts`]),
  "setup-authorization.mjs",
  "setup-authorization.d.mts",
].sort();
const packageFiles = ["LICENSE", "README.md", "package.json", ...sdkFiles.map((name) => `dist/sdk/${name}`)].sort();
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("SDK build emits only public modules and preserves the .mjs declaration", () => {
  assert.deepEqual(readdirSync(new URL("../dist/sdk/", import.meta.url)).sort(), sdkFiles);
  for (const filename of ["setup-authorization.mjs", "setup-authorization.d.mts"]) {
    assert.equal(
      readFileSync(new URL(`../dist/sdk/${filename}`, import.meta.url), "utf8"),
      readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8"),
    );
  }
  assert.equal(
    readFileSync(new URL("../LICENSE", import.meta.url), "utf8"),
    readFileSync(new URL("../../LICENSE", import.meta.url), "utf8"),
  );
});

test("package entrypoints resolve to shipped runtime and type files with no install hooks", () => {
  assert.equal(manifest.name, "@afterlight/recovery");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.main, manifest.exports["."].import);
  assert.equal(manifest.types, manifest.exports["."].types);
  assert.deepEqual(
    Object.keys(manifest.exports).sort(),
    [".", ...publicModules.filter((name) => name !== "index").map((name) => `./${name}`), "./setup-authorization"].sort(),
  );
  for (const target of Object.values(manifest.exports)) {
    assert.deepEqual(Object.keys(target), ["types", "import"]);
    for (const filename of Object.values(target)) {
      assert.ok(packageFiles.includes(filename.slice(2)), `unshipped export: ${filename}`);
    }
  }
  assert.deepEqual([...manifest.files, "package.json"].sort(), packageFiles);
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts[hook], undefined, `install must not run ${hook}`);
  }
});

test("npm tarball has the exact allowlist and is reproducible", () => {
  const packageTemp = mkdtempSync(join(tmpdir(), "afterlight-recovery-pack-"));
  try {
    const pack = () => {
      const result = JSON.parse(execFileSync("npm", [
        "pack", "--json", "--ignore-scripts", "--pack-destination", packageTemp,
      ], { cwd: clientRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
      assert.equal(result.length, 1);
      assert.deepEqual(result[0].files.map((file) => file.path).sort(), packageFiles);
      assert.deepEqual(result[0].bundled, []);
      return result[0];
    };
    const first = pack();
    const firstBytes = readFileSync(join(packageTemp, first.filename));
    const second = pack();
    assert.equal(first.filename, "afterlight-recovery-0.1.0.tgz");
    assert.equal(first.integrity, second.integrity);
    assert.deepEqual(firstBytes, readFileSync(join(packageTemp, second.filename)));
  } finally {
    rmSync(packageTemp, { recursive: true, force: true });
  }
});
