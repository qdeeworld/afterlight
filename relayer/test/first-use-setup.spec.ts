import { env } from "cloudflare:test";
import { Account, RpcProvider, constants, ec, hash, shortString } from "starknet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_BOUND_SETUP_POLICY, SETUP_AUTHORIZATION_SCHEMA, setupAuthorizationHash } from "../../client/src/setup-authorization.mjs";
import { EXIT_POLICY, assertSetupStorageFreshness, executePreparedExit, isFirstUseSetupEnabled, validatePreparedExitPayload } from "../src/exit-executor.js";
import type { BudgetCoordinator } from "../src/executor.js";
import {
  LOCKED_POOL_CLASS_HASH, OPEN_NOTE_PACKED_VALUE, PROOF1_HEADER,
  buildExitLocks, hashCanonical, parseVaultResult, validateLiveExitState, validatePreparedExitPackage,
} from "../src/neutral-exit-policy.mjs";

const ROLE_KEY = "0x123456";
const OTHER_KEY = "0x654321";
const rolePublicKey = ec.starkCurve.getStarkKey(ROLE_KEY);
const otherPublicKey = ec.starkCurve.getStarkKey(OTHER_KEY);

afterEach(() => vi.restoreAllMocks());

describe("role-bound first-use setup sponsorship", () => {
  it("is opt-in and requires exactly the versioned five-action package", () => {
    const candidate = fixture();
    expect(() => validatePreparedExitPackage(candidate, EXIT_POLICY)).toThrow(/setup_disabled/);
    expect(() => validatePreparedExitPayload(JSON.stringify(candidate))).toThrow(/invalid_exit/);
    const result = validatePreparedExitPackage(candidate, EXIT_POLICY, { allowSetup: true });
    expect(result.hasSetup).toBe(true);
    expect(result.setupStorageSlots).toEqual([273n, 274n, 819n]);
    expect(() => validateLiveExitState(result, liveVault(), 200n)).not.toThrow();

    const downgraded = fixture();
    downgraded.schema = "afterlight-prepared-neutral-exit/1";
    expect(() => validatePreparedExitPackage(downgraded, EXIT_POLICY, { allowSetup: true })).toThrow(/versioned_exit/);
    const ordinary = fixture();
    ordinary.prepared.call.calldata.splice(1, 9);
    ordinary.prepared.call.calldata[0] = "3";
    expect(() => validatePreparedExitPackage(ordinary, EXIT_POLICY, { allowSetup: true })).toThrow(/exact_write_note_invoke_shape/);
  });

  it.each(["CLAIM", "CANCEL_REFUND"] as const)("uses the live designated key for %s, never a caller-supplied key", (action) => {
    const candidate = fixture(action);
    const result = validatePreparedExitPackage(candidate, EXIT_POLICY, { allowSetup: true });
    expect(() => validateLiveExitState(result, liveVault(action), 200n)).not.toThrow();
    expect(() => validateLiveExitState(result, liveVault(action, true), 200n)).toThrow(/setup_role_authorization_invalid/);
  });

  it.each([
    ["proof bytes", (item: Fixture) => { item.prepared.proof.data = "Ag=="; }],
    ["preparation metadata", (item: Fixture) => { item.preparedAtBlock = "101"; }],
    ["extra unsigned field", (item: Fixture) => { Object.assign(item, { unrelatedField: "changed" }); }],
    ["prototype-named JSON property", (item: Fixture) => { Object.defineProperty(item, "__proto__", { value: { changed: true }, enumerable: true }); }],
  ])("rejects a changed final %s even when outer package locks are recomputed", (_label, mutate) => {
    const candidate = fixture();
    mutate(candidate);
    candidate.locks = buildExitLocks(candidate);
    const result = validatePreparedExitPackage(candidate, EXIT_POLICY, { allowSetup: true });
    expect(() => validateLiveExitState(result, liveVault(), 200n)).toThrow(/setup_role_authorization_invalid/);
  });

  it("does not reuse setup consent for changed writes or ciphertext", () => {
    for (const index of [2, 4, 5]) {
      const candidate = fixture();
      candidate.prepared.call.calldata[index] = String(BigInt(candidate.prepared.call.calldata[index]!) + 10n);
      synchronizeProof(candidate);
      candidate.locks = buildExitLocks(candidate);
      const result = validatePreparedExitPackage(candidate, EXIT_POLICY, { allowSetup: true });
      expect(() => validateLiveExitState(result, liveVault(), 200n)).toThrow(/setup_role_authorization_invalid/);
    }
  });

  it.each([
    ["wrong policy", (item: Fixture) => { item.setupPolicy = "unknown"; }],
    ["wrong authorization schema", (item: Fixture) => { item.setupAuthorization.schema = "unknown"; }],
    ["extra claimed public key", (item: Fixture) => { Object.assign(item.setupAuthorization, { publicKey: rolePublicKey }); }],
    ["zero signature", (item: Fixture) => { item.setupAuthorization.sig_r = "0"; }],
    ["missing authorization", (item: Fixture) => { Reflect.deleteProperty(item, "setupAuthorization"); }],
    ["zero salt", (item: Fixture) => { item.prepared.call.calldata[4] = "0"; }],
    ["false existence", (item: Fixture) => { item.prepared.call.calldata[9] = "0"; }],
    ["overlapping setup", (item: Fixture) => { item.prepared.call.calldata[7] = "274"; }],
    ["overlapping note", (item: Fixture) => { item.prepared.call.calldata[7] = item.prepared.call.calldata[11]!; }],
    ["zero storage", (item: Fixture) => { item.prepared.call.calldata[2] = "0"; }],
    ["storage range", (item: Fixture) => { item.prepared.call.calldata[2] = constants.ADDR_BOUND.toString(); }],
    ["configuration storage", (item: Fixture) => { item.prepared.call.calldata[2] = hash.starknetKeccak("fee_amount").toString(); }],
    ["wrong destination note value", (item: Fixture) => { item.prepared.call.calldata[13] = "0"; }],
  ])("rejects %s before any sponsor action", (_label, mutate) => {
    const candidate = fixture();
    mutate(candidate);
    expect(() => validatePreparedExitPackage(candidate, EXIT_POLICY, { allowSetup: true })).toThrow();
  });

  it("permits felt252 salt, zero ciphertext, and valid base-address offset semantics", () => {
    const candidate = fixture();
    candidate.prepared.call.calldata[2] = (constants.ADDR_BOUND - 1n).toString();
    candidate.prepared.call.calldata[4] = ((1n << 200n) + 1n).toString();
    candidate.prepared.call.calldata[5] = "0";
    synchronizeProof(candidate);
    authorize(candidate);
    const result = validatePreparedExitPackage(candidate, EXIT_POLICY, { allowSetup: true });
    expect(result.setupStorageSlots.slice(0, 2)).toEqual([constants.ADDR_BOUND - 1n, constants.ADDR_BOUND]);
    expect(() => validateLiveExitState(result, liveVault(), 200n)).not.toThrow();
  });

  it("rejects mock proof envelopes and altered action-bound proof facts", () => {
    const mock = fixture();
    mock.prepared.proof.proof_facts[0] = "0x50524f4f4630";
    authorize(mock);
    expect(() => validatePreparedExitPackage(mock, EXIT_POLICY, { allowSetup: true })).toThrow(/real_proof1/);
    const changed = fixture();
    changed.prepared.proof.proof_facts[8] = "1";
    authorize(changed);
    expect(() => validatePreparedExitPackage(changed, EXIT_POLICY, { allowSetup: true })).toThrow(/facts_binding_mismatch/);
  });

  it("treats local proof-envelope validation as structural, not cryptographic admission", () => {
    // These synthetic bytes/facts are deliberately not a genuine STARK proof.
    // No transaction is signed/submitted here. Canonical gateway proof and
    // program/config validation must happen before any real admission/effects.
    const candidate = fixture();
    candidate.prepared.proof.data = "Ag==";
    candidate.prepared.proof.proof_facts[2] = "123";
    candidate.prepared.proof.proof_facts[6] = "456";
    authorize(candidate);
    const validated = validatePreparedExitPackage(candidate, EXIT_POLICY, { allowSetup: true });
    expect(validated.proof.data).toBe("Ag==");
    expect(validated.proof.facts.facts[2]).toBe("123");
    expect(validated.proof.facts.facts[6]).toBe("456");
  });

  it("never signs a fresh setup exit while the rollout is disabled", async () => {
    const candidate = fixture();
    const budget = { lookup: vi.fn().mockResolvedValue({ outcome: "missing" }) } as Pick<BudgetCoordinator, "lookup">;
    const sign = vi.spyOn(Account.prototype, "getSignedTransaction");
    const invoke = vi.spyOn(RpcProvider.prototype, "invokeSignedTx");
    await expect(executePreparedExit(JSON.stringify(candidate), env, budget as BudgetCoordinator)).rejects.toMatchObject({ code: "exit_unavailable" });
    expect(sign).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires the exact rollout flag, without truthy string coercion", () => {
    expect(isFirstUseSetupEnabled("true")).toBe(true);
    expect(isFirstUseSetupEnabled("false")).toBe(false);
    expect(isFirstUseSetupEnabled("TRUE")).toBe(false);
    expect(isFirstUseSetupEnabled("1")).toBe(false);
    expect(isFirstUseSetupEnabled("")).toBe(false);
  });

  it("checks every occupied setup slot at the proof base and live snapshot", async () => {
    const validated = validatePreparedExitPackage(fixture(), EXIT_POLICY, { allowSetup: true });
    const provider = {
      getBlockWithTxHashes: vi.fn().mockResolvedValue({ block_hash: "0x1" }),
      getStorageAt: vi.fn().mockResolvedValue({ value: "0x0", last_update_block: 0 }),
    };
    await expect(assertSetupStorageFreshness(provider, validated, 120n)).resolves.toBeUndefined();
    expect(provider.getBlockWithTxHashes).toHaveBeenCalledWith(100);
    expect(provider.getStorageAt.mock.calls).toEqual([
      [EXIT_POLICY.poolAddress, "0x111", 100], [EXIT_POLICY.poolAddress, "0x111", 120],
      [EXIT_POLICY.poolAddress, "0x112", 100], [EXIT_POLICY.poolAddress, "0x112", 120],
      [EXIT_POLICY.poolAddress, "0x333", 100], [EXIT_POLICY.poolAddress, "0x333", 120],
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5])("rejects used setup storage read %s", async (usedRead) => {
    const validated = validatePreparedExitPackage(fixture(), EXIT_POLICY, { allowSetup: true });
    let readIndex = 0;
    const provider = {
      getBlockWithTxHashes: vi.fn().mockResolvedValue({ block_hash: "0x1" }),
      getStorageAt: vi.fn().mockImplementation(async () => ({ value: readIndex++ === usedRead ? "0x1" : "0x0", last_update_block: 0 })),
    };
    await expect(assertSetupStorageFreshness(provider, validated, 120n)).rejects.toThrow(/storage_already_used/);
  });

  it("rejects unavailable storage or a different proof-base block", async () => {
    const validated = validatePreparedExitPackage(fixture(), EXIT_POLICY, { allowSetup: true });
    const provider = {
      getBlockWithTxHashes: vi.fn().mockResolvedValue({ block_hash: "0x2" }),
      getStorageAt: vi.fn().mockRejectedValue(new Error("unavailable")),
    };
    await expect(assertSetupStorageFreshness(provider, validated, 120n)).rejects.toThrow(/base_block_mismatch/);
    expect(provider.getStorageAt).not.toHaveBeenCalled();
    provider.getBlockWithTxHashes.mockResolvedValue({ block_hash: "0x1" });
    await expect(assertSetupStorageFreshness(provider, validated, 120n)).rejects.toThrow(/unavailable/);
  });
});

function liveVault(action: "CLAIM" | "CANCEL_REFUND" = "CLAIM", wrongRole = false) {
  const designated = wrongRole ? otherPublicKey : rolePublicKey;
  return parseVaultResult([
    "1", action === "CLAIM" ? "2" : "1", "1",
    action === "CLAIM" ? otherPublicKey : designated,
    action === "CLAIM" ? designated : otherPublicKey,
    EXIT_POLICY.tokenAddress, EXIT_POLICY.fixedAmountFri,
    "300", "300", "1", "2", "100", "1", "3", "3",
  ]);
}

function fixture(action: "CLAIM" | "CANCEL_REFUND" = "CLAIM") {
  const noteId = 0x123n;
  const state = action === "CLAIM" ? "2" : "1";
  const noteStorage = BigInt(hash.computePedersenHash(hash.starknetKeccak("notes"), noteId)) % constants.ADDR_BOUND;
  const actions = [
    "5", "0", "273", "2", ((1n << 200n) + 1n).toString(), "42",
    "0", "819", "1", "1",
    "0", noteStorage.toString(), "2", OPEN_NOTE_PACKED_VALUE.toString(), EXIT_POLICY.tokenAddress,
    "7", "1", "2", "3", EXIT_POLICY.tokenAddress, noteId.toString(),
    "10", EXIT_POLICY.afterlightAddress, "11", state, "1110", EXIT_POLICY.tokenAddress,
    EXIT_POLICY.fixedAmountFri, state, "1", "3", noteId.toString(), "2000000000", "4", "5",
  ];
  const result = {
    schema: "afterlight-prepared-neutral-exit/2", setupPolicy: String(ROLE_BOUND_SETUP_POLICY),
    evidence: "APPLICATION_AUTHORIZED_OUTER_UNSIGNED_NOT_SUBMITTED", action,
    chainId: EXIT_POLICY.chainId, neutralAddress: EXIT_POLICY.neutralAddress,
    afterlightAddress: EXIT_POLICY.afterlightAddress, poolAddress: EXIT_POLICY.poolAddress,
    tokenAddress: EXIT_POLICY.tokenAddress, amountFri: EXIT_POLICY.fixedAmountFri,
    vaultId: "1110", expectedState: state, expectedEpoch: "1", expectedRoleNonce: "3",
    destinationNoteId: noteId.toString(), validUntil: "2000000000", preparedAtBlock: "100",
    prepared: {
      call: { contractAddress: EXIT_POLICY.poolAddress, entrypoint: "apply_actions", calldata: [...actions, "1"] },
      proof: { data: "AQ==", output: [LOCKED_POOL_CLASS_HASH, ...actions], proof_facts: [PROOF1_HEADER, shortString.encodeShortString("VIRTUAL_SNOS"), "1", shortString.encodeShortString("VIRTUAL_SNOS0"), "100", "1", "1", "1", "1"] },
    },
    setupAuthorization: { schema: String(SETUP_AUTHORIZATION_SCHEMA), sig_r: "1", sig_s: "1" },
    locks: { callSha256: "", proofDataSha256: "", proofOutputSha256: "", proofFactsSha256: "", bindingSha256: "" },
  };
  synchronizeProof(result);
  authorize(result);
  return result;
}
type Fixture = ReturnType<typeof fixture>;

function synchronizeProof(candidate: Fixture) {
  candidate.prepared.proof.output = [LOCKED_POOL_CLASS_HASH, ...candidate.prepared.call.calldata.slice(0, -1)];
  const output = candidate.prepared.proof.output.map(BigInt);
  candidate.prepared.proof.proof_facts[8] = ec.starkCurve.poseidonHashMany([
    BigInt(EXIT_POLICY.poolAddress), 0n, BigInt(output.length), ...output,
  ]).toString();
}

function authorize(candidate: Fixture) {
  const { locks: _locks, setupAuthorization: _auth, ...unsigned } = candidate;
  const signature = ec.starkCurve.sign(setupAuthorizationHash(hashCanonical(unsigned)), ROLE_KEY);
  candidate.setupAuthorization = { schema: SETUP_AUTHORIZATION_SCHEMA, sig_r: signature.r.toString(), sig_s: signature.s.toString() };
  candidate.locks = buildExitLocks(candidate);
}
