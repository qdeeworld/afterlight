import assert from "node:assert/strict";
import test from "node:test";

import { hash, type CompiledSierra } from "starknet";

import { buildReadyLegacyDeclarationPayload } from "../src/operator-declaration.js";

const LOCKED_CLASS_HASH = "0x123";
const LOCKED_COMPILED_CLASS_HASH = "0x456";
const CONTRACT = {
  abi: [],
  contract_class_version: "0.1.0",
  entry_points_by_type: { CONSTRUCTOR: [], EXTERNAL: [], L1_HANDLER: [] },
  sierra_program: [],
} as CompiledSierra;

test("Ready legacy declaration preserves the unstringified ABI and explicit hashes", () => {
  const payload = buildReadyLegacyDeclarationPayload(
    CONTRACT,
    LOCKED_CLASS_HASH,
    LOCKED_COMPILED_CLASS_HASH,
  );

  assert.equal(payload.contract, CONTRACT);
  assert(Array.isArray(payload.contract.abi));
  assert.equal(payload.classHash, LOCKED_CLASS_HASH);
  assert.equal(payload.compiledClassHash, LOCKED_COMPILED_CLASS_HASH);
  assert(Object.isFrozen(payload));
});

test("Ready legacy declaration rejects a pre-stringified ABI", () => {
  assert.throws(
    () =>
      buildReadyLegacyDeclarationPayload(
        { ...CONTRACT, abi: "[]" } as unknown as CompiledSierra,
        LOCKED_CLASS_HASH,
        LOCKED_COMPILED_CLASS_HASH,
      ),
    /unstringified Sierra ABI/,
  );
});

test("the regression fixture demonstrates that ABI double-stringification changes a class hash", () => {
  const artifact = {
    ...CONTRACT,
    abi: [{ type: "function", name: "f", inputs: [], outputs: [], state_mutability: "view" }],
  } as CompiledSierra;
  const correct = hash.computeContractClassHash(artifact);
  const doubled = hash.computeContractClassHash({
    ...artifact,
    abi: JSON.stringify(artifact.abi),
  } as unknown as CompiledSierra);

  assert.notEqual(doubled, correct);
});
