import assert from "node:assert/strict";
import { test } from "node:test";

import { ec, shortString } from "starknet";

import {
  authorizationElements,
  authorizationHash,
  BACKUP_CONFIRMATION,
  LocalStarkKey,
  OPERATION_TAG,
  unixSeconds,
  type Authorization,
  type AuthorizationBase,
} from "../src/index.js";

const base: AuthorizationBase = {
  chain_id: "0x534e5f4d41494e",
  contract: "0x1234",
  vault_id: "0xabc",
  token: "0x999",
  amount: 10n ** 19n,
  expected_state: 1n,
  epoch: 2n,
  nonce: 3n,
  signer_key: "0x444",
  note_id: "0x555",
  valid_until: 1_787_540_000n,
};

const vectors: ReadonlyArray<readonly [Authorization, string]> = [
  [
    {
      operation: "FUND",
      base,
      mode: 1n,
      successor_key: "0x666",
      inactivity_seconds: 120n,
      grace_seconds: 60n,
    },
    "0x235558e175c62beb0f26c05a9b292a40a8c4a5146544cc637d97ca700f70f22",
  ],
  [
    { operation: "CANCEL_REFUND", base },
    "0x67d0e21e3670e00343b7d9d5fd9bf56759d06c22a1c21dff9b99428f3ea3ea4",
  ],
  [
    { operation: "CLAIM", base, requested_at: 1_787_539_000n, claim_after: 1_787_539_900n },
    "0x4349ce2da049d1ed496f65c1ba3742ca997c2f102db2b459dd56cd76dca3140",
  ],
  [
    { operation: "HEARTBEAT", base, last_heartbeat: 1_787_538_000n },
    "0x7e730e8e4f0855df7c159438eeb2606d99c22385bb9eb81188ef4ef85a0c79f",
  ],
  [
    { operation: "REQUEST", base, last_heartbeat: 1_787_538_000n },
    "0x129fabc595665af491b544f9079e3e15594de0f25f8858021d3376183c7d95d",
  ],
  [
    { operation: "VETO", base, requested_at: 1_787_539_000n, claim_after: 1_787_539_900n },
    "0x4623d9e97a90ca2cda54aca217896ae98dcae852e8b9c600187d0b27a7de222",
  ],
];

test("authorization hashes have stable cross-language vectors", () => {
  for (const [authorization, expected] of vectors) {
    assert.equal(authorizationHash(authorization), expected, authorization.operation);
  }
});

test("domain element order is tag then the eleven fixed fields then operation extras", () => {
  const authorization = vectors[0]![0];
  assert.equal(authorization.operation, "FUND");
  assert.deepEqual(authorizationElements(authorization), [
    BigInt(shortString.encodeShortString(OPERATION_TAG.FUND)),
    BigInt(base.chain_id),
    BigInt(base.contract),
    BigInt(base.vault_id),
    BigInt(base.token),
    BigInt(base.amount),
    BigInt(base.expected_state),
    BigInt(base.epoch),
    BigInt(base.nonce),
    BigInt(base.signer_key),
    BigInt(base.note_id),
    BigInt(base.valid_until),
    1n,
    0x666n,
    120n,
    60n,
  ]);
});

test("every required base binding changes the signature hash", () => {
  const original: Authorization = {
    operation: "CLAIM",
    base,
    requested_at: 1_787_539_000n,
    claim_after: 1_787_539_900n,
  };
  const originalHash = authorizationHash(original);
  for (const field of Object.keys(base) as Array<keyof AuthorizationBase>) {
    const changed: Authorization = {
      ...original,
      base: { ...base, [field]: BigInt(base[field]) + 1n },
    };
    assert.notEqual(authorizationHash(changed), originalHash, field);
  }
  assert.notEqual(
    authorizationHash({ ...original, requested_at: BigInt(original.requested_at) + 1n }),
    originalHash,
  );
  assert.notEqual(
    authorizationHash({ ...original, claim_after: BigInt(original.claim_after) + 1n }),
    originalHash,
  );
});

test("fresh application keys expose only the public half unless backup is explicit", () => {
  const key = LocalStarkKey.generate();
  const another = LocalStarkKey.generate();
  assert.match(key.publicKey, /^0x[0-9a-f]+$/);
  assert.notEqual(key.publicKey, another.publicKey);
  assert.deepEqual(Object.keys(key), ["publicKey"]);
  assert.deepEqual(JSON.parse(JSON.stringify(key)), { public_key: key.publicKey });

  assert.throws(
    () => key.serializeBackup("NO" as typeof BACKUP_CONFIRMATION),
    /confirmation required/,
  );
  const backup = key.serializeBackup(BACKUP_CONFIRMATION);
  const envelope = JSON.parse(backup) as { private_key: string };
  assert.match(envelope.private_key, /^0x[0-9a-f]{64}$/);
  const restored = LocalStarkKey.restore(backup);
  assert.equal(restored.publicKey, key.publicKey);

  const message = authorizationHash(vectors[2]![0]);
  const signature = key.sign(message);
  const fullPublicKey = ec.starkCurve.getPublicKey(envelope.private_key, false);
  const compactSignature = ec.starkCurve.Signature.fromCompact(
    `${BigInt(signature.sig_r).toString(16).padStart(64, "0")}${BigInt(signature.sig_s)
      .toString(16)
      .padStart(64, "0")}`,
  );
  assert.equal(
    ec.starkCurve.verify(compactSignature, message, fullPublicKey),
    true,
  );

  key.destroy();
  assert.throws(() => key.sign(message), /destroyed/);
  assert.throws(() => key.serializeBackup(BACKUP_CONFIRMATION), /destroyed/);
  restored.destroy();
  another.destroy();
});

test("backup restoration rejects extra fields and malformed scalars", () => {
  assert.throws(
    () =>
      LocalStarkKey.restore(
        JSON.stringify({ format: "afterlight-stark-key-v1", private_key: `0x${"01".repeat(32)}`, x: 1 }),
      ),
    /invalid Afterlight key backup envelope/,
  );
  assert.throws(() => LocalStarkKey.restore("not-json"), /invalid Afterlight key backup JSON/);
});

test("encrypted application key backups require the password and authenticate every field", async () => {
  const key = LocalStarkKey.generate();
  const password = "correct horse battery staple";
  const encrypted = await key.serializeEncryptedBackup(BACKUP_CONFIRMATION, password);
  const envelope = JSON.parse(encrypted) as Record<string, unknown>;

  assert.equal(envelope.format, "afterlight-stark-key-v2");
  assert.equal(envelope.kdf, "PBKDF2-SHA256");
  assert.equal(envelope.iterations, 600_000);
  assert.equal(envelope.cipher, "AES-256-GCM");
  assert.equal(envelope.public_key, key.publicKey);
  assert.equal("private_key" in envelope, false);
  assert.doesNotMatch(encrypted, /0x[0-9a-f]{64}/i);

  const restored = await LocalStarkKey.restoreEncrypted(encrypted, password);
  assert.equal(restored.publicKey, key.publicKey);
  await assert.rejects(
    LocalStarkKey.restoreEncrypted(encrypted, "wrong password value"),
    /incorrect backup password or damaged backup/,
  );

  for (const field of ["salt", "iv", "public_key", "ciphertext"] as const) {
    const tampered = { ...envelope };
    if (field === "public_key") {
      tampered[field] = LocalStarkKey.generate().publicKey;
    } else {
      const encoded = String(tampered[field]);
      tampered[field] = `${encoded[0] === "A" ? "B" : "A"}${encoded.slice(1)}`;
    }
    await assert.rejects(
      LocalStarkKey.restoreEncrypted(JSON.stringify(tampered), password),
      /incorrect backup password|invalid encrypted backup|public key mismatch/,
      field,
    );
  }

  await assert.rejects(
    key.serializeEncryptedBackup(BACKUP_CONFIRMATION, "too short"),
    /between 12 and 256/,
  );
  restored.destroy();
  key.destroy();
});

test("timestamps are truncated to Unix seconds", () => {
  assert.equal(unixSeconds(1_787_539_123_999), 1_787_539_123n);
  assert.throws(() => unixSeconds(-1), /non-negative/);
});
