import assert from "node:assert/strict";
import test from "node:test";

import { verifyDeploymentState } from "../src/operator-validation.js";

const CLASS_HASH = "0x123";
const CONFIG = ["0x1", "0x2", "3", "0x4"] as const;

test("deployment verification normalizes and accepts an exact locked state", () => {
  const verified = verifyDeploymentState(CLASS_HASH, CONFIG, "291", ["1", "0x2", "0x3", "4"]);
  assert.deepEqual(verified, {
    classHash: "0x123",
    config: ["0x1", "0x2", "0x3", "0x4"],
  });
  assert(Object.isFrozen(verified));
  assert(Object.isFrozen(verified.config));
});

test("deployment verification rejects a wrong class hash", () => {
  assert.throws(
    () => verifyDeploymentState(CLASS_HASH, CONFIG, "0x124", CONFIG),
    /wrong class hash/,
  );
});

test("deployment verification rejects missing or extra config fields", () => {
  assert.throws(
    () => verifyDeploymentState(CLASS_HASH, CONFIG, CLASS_HASH, CONFIG.slice(0, 3)),
    /3 fields; expected 4/,
  );
  assert.throws(
    () => verifyDeploymentState(CLASS_HASH, CONFIG, CLASS_HASH, [...CONFIG, "0x5"]),
    /5 fields; expected 4/,
  );
});

test("deployment verification names the first mismatched config field", () => {
  assert.throws(
    () => verifyDeploymentState(CLASS_HASH, CONFIG, CLASS_HASH, ["0x1", "0x2", "0x99", "0x4"]),
    /field 2/,
  );
});
