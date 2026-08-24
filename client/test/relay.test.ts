import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRelayRequest,
  encodeRelayRequest,
  MAX_RELAY_PAYLOAD_BYTES,
  MAX_RELAY_TTL_SECONDS,
  RelayOperation,
  validateRelayPayload,
  type ControlArgs,
  type RelayPolicy,
  type RelayRequest,
} from "../src/index.js";

const now = 1_787_539_000n;
const contract = "0x1234";
const token = "0x5678";
const amount = 10n ** 19n;
const args: ControlArgs = {
  vault_id: "0xabc",
  token,
  amount,
  expected_state: 1n,
  expected_epoch: 2n,
  expected_nonce: 3n,
  valid_until: now + 600n,
  sig_r: "0x444",
  sig_s: "0x555",
};
const policy: RelayPolicy = { now_seconds: now, contract, token, amount };

test("neutral relay schema carries only bounded public authorization material", () => {
  for (const operation of Object.values(RelayOperation)) {
    const request = buildRelayRequest(operation, contract, args);
    const encoded = encodeRelayRequest(request);
    assert.ok(Buffer.byteLength(encoded) < MAX_RELAY_PAYLOAD_BYTES);
    assert.doesNotMatch(encoded, /private|secret|ready|wallet|sender|ip/i);
    assert.deepEqual(validateRelayPayload(encoded, policy), request);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.args), true);
  }
});

test("relay preflight rejects expired, unbounded and mismatched authorizations", () => {
  const valid = buildRelayRequest(RelayOperation.Heartbeat, contract, args);
  assert.throws(
    () => validateRelayPayload(encodeRelayRequest(valid), { ...policy, now_seconds: now + 601n }),
    /expired/,
  );
  const tooFar = buildRelayRequest(RelayOperation.Heartbeat, contract, {
    ...args,
    valid_until: now + MAX_RELAY_TTL_SECONDS + 1n,
  });
  assert.throws(
    () => validateRelayPayload(encodeRelayRequest(tooFar), policy),
    /expiry is unbounded/,
  );
  assert.throws(
    () => validateRelayPayload(encodeRelayRequest(valid), { ...policy, contract: "0x999" }),
    /contract is not allowlisted/,
  );
  assert.throws(
    () => validateRelayPayload(encodeRelayRequest(valid), { ...policy, token: "0x999" }),
    /token is not allowlisted/,
  );
  assert.throws(
    () => validateRelayPayload(encodeRelayRequest(valid), { ...policy, amount: amount + 1n }),
    /amount is not allowlisted/,
  );
  assert.throws(
    () =>
      validateRelayPayload(encodeRelayRequest(valid), {
        ...policy,
        max_ttl_seconds: MAX_RELAY_TTL_SECONDS + 1n,
      }),
    /hard maximum/,
  );
});

test("relay schema rejects extra fields, operations and oversized input", () => {
  const request = buildRelayRequest(RelayOperation.Veto, contract, args);
  const extraTop = { ...request, private_key: "0x1" };
  assert.throws(
    () => validateRelayPayload(JSON.stringify(extraTop), policy),
    /does not match schema/,
  );
  const extraArgs = { ...request, args: { ...request.args, wallet_address: "0x1" } };
  assert.throws(
    () => validateRelayPayload(JSON.stringify(extraArgs), policy),
    /does not match schema/,
  );
  const wrongOperation = { ...request, operation: "CLAIM" };
  assert.throws(
    () => validateRelayPayload(JSON.stringify(wrongOperation), policy),
    /does not match schema/,
  );
  assert.throws(
    () => validateRelayPayload("{".repeat(MAX_RELAY_PAYLOAD_BYTES + 1), policy),
    /payload limit/,
  );
  const malformed = {
    ...request,
    args: { ...request.args, sig_r: "x".repeat(MAX_RELAY_PAYLOAD_BYTES) },
  } as RelayRequest;
  assert.throws(() => encodeRelayRequest(malformed), /payload limit/);
});
