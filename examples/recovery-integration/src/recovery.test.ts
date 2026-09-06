import assert from "node:assert/strict";
import { test } from "node:test";

import * as recovery from "@afterlight/recovery";
import { buildFundActions, serializeExit, PrivateAction } from "@afterlight/recovery/actions";
import { felt } from "@afterlight/recovery/encoding";
import { verifyRoleSignature } from "@afterlight/recovery/exit-preflight";
import { BACKUP_CONFIRMATION, LocalStarkKey } from "@afterlight/recovery/keys";
import { authorizationHash, type AuthorizationBase } from "@afterlight/recovery/messages";
import { validateRelayPayload } from "@afterlight/recovery/relay";
import { ROLE_BOUND_SETUP_POLICY, setupAuthorizationHash } from "@afterlight/recovery/setup-authorization";

import { prepareControl, type VaultSnapshot } from "./prepare-control.js";

// Entirely local fixtures: these addresses, timestamps and snapshots are not
// Mainnet evidence. Generated application keys never leave this process.
const now = 1_800_000_000n;
function fixture(owner: LocalStarkKey, successor: LocalStarkKey): VaultSnapshot {
  return {
    chainId: "0x534e5f4d41494e",
    contract: "0x1234",
    vaultId: "0xabc",
    token: "0x5678",
    amount: 10n ** 18n,
    state: 1n,
    epoch: 2n,
    ownerKey: owner.publicKey,
    successorKey: successor.publicKey,
    ownerNonce: 3n,
    successorNonce: 4n,
    lastHeartbeat: now - 120n,
    requestedAt: 0n,
    claimAfter: 0n,
  };
}

test("packed ESM root and all documented subpaths resolve to the same public primitives", () => {
  assert.equal(recovery.LocalStarkKey, LocalStarkKey);
  assert.equal(recovery.buildFundActions, buildFundActions);
  assert.equal(recovery.authorizationHash, authorizationHash);
  assert.equal(recovery.verifyRoleSignature, verifyRoleSignature);
  assert.equal(recovery.felt, felt);
  assert.equal(recovery.validateRelayPayload, validateRelayPayload);
  assert.equal(recovery.setupAuthorizationHash, setupAuthorizationHash);
  assert.equal(ROLE_BOUND_SETUP_POLICY, "afterlight-role-bound-setup/1");
});

test("local owner heartbeat, successor request and owner veto bind their exact fixture snapshots", () => {
  const owner = LocalStarkKey.generate();
  const successor = LocalStarkKey.generate();
  try {
    const active = fixture(owner, successor);
    const grace = { ...active, state: 2n, successorNonce: 5n, requestedAt: now, claimAfter: now + 60n };
    const cases = [
      ["HEARTBEAT", active, owner, successor, 3n],
      ["REQUEST", active, successor, owner, 4n],
      ["VETO", grace, owner, successor, 3n],
    ] as const;

    for (const [operation, snapshot, role, otherRole, nonce] of cases) {
      const prepared = prepareControl(operation, snapshot, role, now);
      assert.equal(prepared.request.args.expected_nonce, felt(nonce));
      assert.equal(prepared.request.args.expected_state, felt(snapshot.state));
      assert.equal(verifyRoleSignature(prepared.messageHash, role.publicKey, prepared.signature), true);
      assert.equal(verifyRoleSignature(prepared.messageHash, otherRole.publicKey, prepared.signature), false);
      assert.deepEqual(validateRelayPayload(prepared.payload, prepared.policy), prepared.request);
      assert.throws(() => prepareControl(operation, snapshot, otherRole, now), /does not match/);

      for (const field of ["expected_state", "epoch", "nonce"] as const satisfies readonly (keyof AuthorizationBase)[]) {
        const changed = {
          ...prepared.authorization,
          base: { ...prepared.authorization.base, [field]: BigInt(prepared.authorization.base[field]) + 1n },
        };
        assert.equal(verifyRoleSignature(authorizationHash(changed), role.publicKey, prepared.signature), false);
      }
      assert.throws(
        () => validateRelayPayload(prepared.payload, { ...prepared.policy, now_seconds: now + 601n }),
        /expired/,
      );
      assert.throws(
        () => validateRelayPayload(prepared.payload, { ...prepared.policy, contract: "0x9999" }),
        /not allowlisted/,
      );
      // Assert payload field names rather than printing any signature or key.
      assert.deepEqual(Object.keys(prepared.request).sort(), ["args", "contract", "operation", "schema"]);
      assert.deepEqual(Object.keys(prepared.request.args).sort(), [
        "amount", "expected_epoch", "expected_nonce", "expected_state", "sig_r", "sig_s", "token", "valid_until", "vault_id",
      ]);
    }
  } finally {
    owner.destroy();
    successor.destroy();
  }
});

test("local funding assembly and exact-note claim calldata preserve the consumer's signed fields", () => {
  const owner = LocalStarkKey.generate();
  const successor = LocalStarkKey.generate();
  try {
    const snapshot = fixture(owner, successor);
    const base: AuthorizationBase = {
      chain_id: snapshot.chainId, contract: snapshot.contract, vault_id: snapshot.vaultId,
      token: snapshot.token, amount: snapshot.amount, expected_state: 0n, epoch: 0n, nonce: 0n,
      signer_key: owner.publicKey, note_id: 0n, valid_until: now + 600n,
    };
    const fundAuthorization = {
      operation: "FUND", base, mode: 1n, successor_key: successor.publicKey,
      inactivity_seconds: 120n, grace_seconds: 60n,
    } as const;
    const fundSignature = owner.sign(authorizationHash(fundAuthorization));
    const fundActions = buildFundActions(snapshot.contract, {
      vault_id: snapshot.vaultId, token: snapshot.token, amount: snapshot.amount,
      mode: fundAuthorization.mode, owner_key: owner.publicKey, successor_key: successor.publicKey,
      inactivity_seconds: fundAuthorization.inactivity_seconds, grace_seconds: fundAuthorization.grace_seconds,
      valid_until: base.valid_until, ...fundSignature,
    });
    assert.deepEqual(fundActions.map((action) => action.type), ["withdraw", "invoke"]);

    const claim = {
      operation: "CLAIM",
      base: { ...base, expected_state: 2n, epoch: 2n, nonce: 5n, signer_key: successor.publicKey, note_id: "0x777" },
      requested_at: now - 120n,
      claim_after: now - 60n,
    } as const;
    const claimSignature = successor.sign(authorizationHash(claim));
    const calldata = serializeExit(PrivateAction.Claim, {
      vault_id: claim.base.vault_id, token: claim.base.token, amount: claim.base.amount,
      expected_state: claim.base.expected_state, expected_epoch: claim.base.epoch,
      expected_nonce: claim.base.nonce, note_id: claim.base.note_id,
      valid_until: claim.base.valid_until, ...claimSignature,
    });
    assert.equal(calldata[0], "0x2");
    assert.equal(calldata[7], claim.base.note_id);
    assert.equal(verifyRoleSignature(authorizationHash(claim), successor.publicKey, claimSignature), true);
    const redirected = { ...claim, base: { ...claim.base, note_id: "0x778" } };
    assert.equal(verifyRoleSignature(authorizationHash(redirected), successor.publicKey, claimSignature), false);
  } finally {
    owner.destroy();
    successor.destroy();
  }
});

test("local encrypted application-key backup round trip works from the installed package", async () => {
  const owner = LocalStarkKey.generate();
  let restored: LocalStarkKey | undefined;
  try {
    // Public fixture password for a throwaway key, never an example production password.
    const password = "local fixture only - discard this generated key";
    const backup = await owner.serializeEncryptedBackup(BACKUP_CONFIRMATION, password);
    assert.equal(Object.hasOwn(JSON.parse(backup) as object, "private_key"), false);
    restored = await LocalStarkKey.restoreEncrypted(backup, password);
    assert.equal(restored.publicKey, owner.publicKey);
    await assert.rejects(LocalStarkKey.restoreEncrypted(backup, "wrong fixture password"), /incorrect backup password/);
  } finally {
    restored?.destroy();
    owner.destroy();
  }
});
