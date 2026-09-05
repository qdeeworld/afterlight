import assert from "node:assert/strict";
import test from "node:test";
import { ec, hash, shortString } from "starknet";
import { setupAuthorizationHash } from "../src/setup-authorization.mjs";

test("setup consent commits both digest limbs and a separate Mainnet domain", () => {
  const digest = "0123456789abcdef".repeat(4);
  const expected = hash.computeHashOnElements([
    shortString.encodeShortString("AFTERLIGHT_SETUP_V1"), "0x534e5f4d41494e",
    "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46",
    "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
    "0x067dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d",
    "0x06e8b6e49b4366e0dc6a35eee722b417c718988eca3f4a0c298bdf8785261c25",
    "0x05da9866f62cc6dd1e380e8d9206e78a752b460abdb802070e0be1208ec7b1a6",
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    `0x${digest.slice(0, 32)}`, `0x${digest.slice(32)}`,
  ]);
  assert.equal(setupAuthorizationHash(digest), expected);
  assert.notEqual(setupAuthorizationHash(`f${digest.slice(1)}`), expected);
  assert.notEqual(setupAuthorizationHash(`${digest.slice(0, 63)}0`), expected);
  // Synthetic key only: changing a single final-package byte invalidates consent.
  const signature = ec.starkCurve.sign(expected, "0x12345");
  const publicKey = ec.starkCurve.getPublicKey("0x12345");
  assert.equal(ec.starkCurve.verify(signature, expected, publicKey), true);
  assert.equal(ec.starkCurve.verify(signature, setupAuthorizationHash("f".repeat(64)), publicKey), false);
});

test("setup consent refuses truncated, decorated or noncanonical digests", () => {
  for (const digest of ["", "0".repeat(63), "0".repeat(65), "0x" + "0".repeat(64), "A".repeat(64), "g".repeat(64), " " + "0".repeat(64)]) {
    assert.throws(() => setupAuthorizationHash(digest), /canonical SHA-256/);
  }
});
