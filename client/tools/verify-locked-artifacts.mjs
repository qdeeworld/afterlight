import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hash } from "starknet";

const profile = "spike-inline-56";
const expected = {
  classHash:
    "0x05da9866f62cc6dd1e380e8d9206e78a752b460abdb802070e0be1208ec7b1a6",
  compiledClassHash:
    "0x055ba10e36aac8e21b3437f1413f009f6b17d3633c307941a4412ce73566251",
  sierraWords: 5767,
  casmWords: 12725,
};

const clientDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifactDirectory = path.join(
  path.dirname(clientDirectory),
  "target",
  profile,
);
const sierraPath = path.join(
  artifactDirectory,
  "afterlight_spike_Afterlight.contract_class.json",
);
const casmPath = path.join(
  artifactDirectory,
  "afterlight_spike_Afterlight.compiled_contract_class.json",
);

if (!fs.existsSync(sierraPath) || !fs.existsSync(casmPath)) {
  throw new Error(`Missing ${profile} artifacts; run scarb --profile ${profile} build.`);
}

const sierra = JSON.parse(fs.readFileSync(sierraPath, "utf8"));
const casm = JSON.parse(fs.readFileSync(casmPath, "utf8"));
const actual = {
  classHash: hash.computeContractClassHash(sierra),
  compiledClassHash: hash.computeCompiledClassHash(casm),
  sierraWords: sierra.sierra_program.length,
  casmWords: casm.bytecode.length,
};
const sameFelt = (left, right) => BigInt(left) === BigInt(right);

if (!sameFelt(actual.classHash, expected.classHash)) {
  throw new Error("Locked Sierra class hash changed.");
}
if (!sameFelt(actual.compiledClassHash, expected.compiledClassHash)) {
  throw new Error("Locked compiled class hash changed.");
}
if (
  actual.sierraWords !== expected.sierraWords ||
  actual.casmWords !== expected.casmWords
) {
  throw new Error("Locked artifact size changed.");
}

process.stdout.write(
  `${JSON.stringify({ evidence: "LOCKED_ARTIFACTS_VERIFIED", profile, ...actual })}\n`,
);
