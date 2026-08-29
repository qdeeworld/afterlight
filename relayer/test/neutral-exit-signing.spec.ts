import { Account, RpcProvider, constants, ec, hash, transaction, type Call } from "starknet";
import { describe, expect, it, vi } from "vitest";

import {
  LOCKED_AFTERLIGHT_ADDRESS,
  LOCKED_AMOUNT_FRI,
  LOCKED_NEUTRAL_ADDRESS as POLICY_NEUTRAL,
  LOCKED_POOL_ADDRESS,
  LOCKED_POOL_CLASS_HASH,
  LOCKED_TOKEN_ADDRESS,
  OPEN_NOTE_PACKED_VALUE,
  PROOF1_HEADER,
  assertOuterSignatureMatchesHash,
  assertSignedExitTransaction,
  buildExitLocks,
  validateAllowanceForAction,
  validatePreparedExitPackage,
} from "../src/neutral-exit-policy.mjs";
import { EXIT_POLICY, applyLedgerCapacity, classifyBroadcastFailure, executePreparedExit, reconcileSubmittedExit, serializeSignedExitForStorage, validateStoredSignedExit } from "../src/exit-executor.js";

const MAINNET_CHAIN_ID = "0x534e5f4d41494e";
const LOCKED_NEUTRAL_ADDRESS = "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46";
const TEST_SIGNER = "0x12345";

describe("neutral exact-exit signing boundary", () => {
  it("distinguishes definitive RPC rejection from ambiguous transport failure", () => {
    expect(classifyBroadcastFailure({ baseError: { code: 55 } })).toEqual({
      category: "rpc_validation",
      definitiveReject: true,
    });
    expect(classifyBroadcastFailure(new Error("network unavailable"))).toEqual({
      category: "transport_or_unknown",
      definitiveReject: false,
    });
    expect(classifyBroadcastFailure({ baseError: { code: 59 } })).toEqual({
      category: "rpc_duplicate",
      definitiveReject: false,
    });
    expect(classifyBroadcastFailure({ code: 999 })).toEqual({
      category: "rpc_other",
      definitiveReject: false,
    });
  });

  it("accepts only the exact WriteOnce, open-note, Afterlight Invoke package and pinned pool class", () => {
    const valid = preparedClaimPackage();
    expect(validatePreparedExitPackage(valid, EXIT_POLICY).action).toBe("CLAIM");

    const extraAction = structuredClone(valid);
    const raw = extraAction.prepared.call.calldata;
    raw[0] = "4";
    raw.splice(6, 0, "1", "1", "2", "3", "4");
    expect(() => validatePreparedExitPackage(extraAction, EXIT_POLICY)).toThrow(/exact_write_note_invoke_shape/);

    const wrongWrite = structuredClone(valid);
    wrongWrite.prepared.call.calldata[2] = "0x123";
    expect(() => validatePreparedExitPackage(wrongWrite, EXIT_POLICY)).toThrow(/wrong_open_note_write_once/);

    const wrongPoolClass = structuredClone(valid);
    wrongPoolClass.prepared.proof.output[0] = "0x123";
    expect(() => validatePreparedExitPackage(wrongPoolClass, EXIT_POLICY)).toThrow(/proof_output_shape/);
  });

  it("accepts the same exact-note boundary for an owner-authorized cancellation", () => {
    const cancellation = structuredClone(preparedClaimPackage());
    cancellation.action = "CANCEL_REFUND";
    cancellation.expectedState = "1";
    cancellation.prepared.call.calldata[15] = "1";
    cancellation.prepared.call.calldata[19] = "1";
    cancellation.prepared.proof.output[16] = "1";
    cancellation.prepared.proof.output[20] = "1";
    cancellation.locks = buildExitLocks(cancellation);
    expect(validatePreparedExitPackage(cancellation, EXIT_POLICY).action).toBe("CANCEL_REFUND");
  });

  it("admits exactly one bounded claim or cancellation from the same replenished allowance", () => {
    const readyAllowance = 12n * 10n ** 18n;
    const exhaustedAllowance = 6n * 10n ** 18n;
    expect(validateAllowanceForAction("CLAIM", readyAllowance)).toBe(exhaustedAllowance);
    expect(validateAllowanceForAction("CANCEL_REFUND", readyAllowance)).toBe(exhaustedAllowance);
    expect(() => validateAllowanceForAction("CLAIM", exhaustedAllowance)).toThrow(/wrong_exact_pool_allowance/);
  });

  it("reports capacity exhausted when the sponsorship ledger cannot reserve a full exit", () => {
    const ready = { status: "ready", reason: "ready", fundingStatus: "ready", fundingReason: "ready" } as const;
    const base = { reservedTodayFri: "0", spentTodayFri: "0", reservedCount: 0, submittedCount: 0, sponsorshipFrozen: false };
    expect(applyLedgerCapacity(ready, base)).toEqual(ready);
    for (const unavailable of [
      { ...base, reservedTodayFri: "1", reservedCount: 1 },
      { ...base, submittedCount: 1 },
      { ...base, spentTodayFri: "1" },
      { ...base, sponsorshipFrozen: true },
    ]) {
      expect(applyLedgerCapacity(ready, unavailable)).toMatchObject({
        status: "exhausted",
        reason: "ledger",
        fundingStatus: "exhausted",
      });
    }
    expect(applyLedgerCapacity(ready, { ...base, fundingAdmissionActive: true })).toEqual({
      status: "ready",
      reason: "ready",
      fundingStatus: "exhausted",
      fundingReason: "exit_capacity",
    });
  });

  it("reconciles an already-submitted private exit instead of leaving the nonce lane blocked", async () => {
    const transactionHash = "0xabc";
    const binding = "a".repeat(64);
    const provider = {
      waitForTransaction: vi.fn().mockResolvedValue({
        isError: () => false,
        isReverted: () => false,
        value: { transaction_hash: transactionHash, actual_fee: { amount: "70" } },
      }),
    } as any;
    const budget = {
      markSubmitted: vi.fn().mockResolvedValue({ outcome: "submitted" }),
      finalize: vi.fn().mockResolvedValue({ outcome: "committed" }),
    } as any;
    await expect(reconcileSubmittedExit(provider, budget, { bindingSha256: binding } as any, transactionHash)).resolves.toEqual({
      status: "accepted",
      transactionHash,
      actualFeeFri: "70",
    });
    expect(budget.finalize).toHaveBeenCalledWith(binding, binding, transactionHash, "70", "succeeded", expect.any(Number));
  });

  it.each([
    ["missing", undefined],
    ["malformed object", {}],
    ["malformed amount", { amount: "not-a-fee" }],
    ["zero", { amount: "0x0" }],
    ["non-FRI unit", { amount: "70", unit: "WEI" }],
    ["malformed unit", { amount: "70", unit: null }],
  ])("keeps an accepted receipt with a %s actual fee uncertain", async (_label, actualFee) => {
    const transactionHash = "0xabc";
    const binding = "a".repeat(64);
    const provider = {
      waitForTransaction: vi.fn().mockResolvedValue({
        isError: () => false,
        isReverted: () => false,
        value: { transaction_hash: transactionHash, actual_fee: actualFee },
      }),
    } as any;
    const budget = {
      markSubmitted: vi.fn().mockResolvedValue({ outcome: "submitted" }),
      finalize: vi.fn().mockResolvedValue({ outcome: "committed" }),
    } as any;
    await expect(reconcileSubmittedExit(provider, budget, { bindingSha256: binding } as any, transactionHash)).rejects.toMatchObject({
      code: "exit_uncertain",
    });
    expect(budget.markSubmitted).not.toHaveBeenCalled();
    expect(budget.finalize).not.toHaveBeenCalled();
  });

  it("reconciles a stored SUBMITTED exit while fresh submission is disabled", async () => {
    const transactionHash = "0xabc";
    const validated = validatePreparedExitPackage(preparedClaimPackage(), EXIT_POLICY);
    vi.spyOn(RpcProvider.prototype, "waitForTransaction").mockResolvedValue({
      isError: () => false,
      isReverted: () => false,
      value: { transaction_hash: transactionHash, actual_fee: { amount: "70" } },
    } as any);
    const budget = {
      lookup: vi.fn().mockResolvedValue({
        outcome: "found",
        state: "submitted",
        exactFingerprint: validated.bindingSha256,
        transactionHash,
      }),
      markSubmitted: vi.fn().mockResolvedValue({ outcome: "submitted" }),
      finalize: vi.fn().mockResolvedValue({ outcome: "committed" }),
    } as any;
    const afterAuthenticated = vi.fn(async () => {});
    await expect(executePreparedExit("{}", {
      SUBMIT_ENABLED: "false",
      EXIT_RPC_URL: "https://rpc.invalid",
      STARKNET_RPC_AUTH_TOKEN: "configured",
    } as any, budget, validated, afterAuthenticated)).resolves.toMatchObject({
      status: "accepted",
      transactionHash,
    });
    expect(budget.finalize).toHaveBeenCalledOnce();
    expect(afterAuthenticated).not.toHaveBeenCalled();
  });

  it("validates before the kill switch and never signs a fresh disabled exit", async () => {
    await expect(executePreparedExit("{}", { SUBMIT_ENABLED: "false" } as any, {} as any)).rejects.toMatchObject({ code: "invalid_exit" });
  });

  it("signs the real proof facts and reconstructs the exact outer hash offline", async () => {
    const provider = new RpcProvider({ nodeUrl: "http://127.0.0.1:1", plugins: false });
    vi.spyOn(provider, "getChainId").mockResolvedValue(MAINNET_CHAIN_ID);

    const account = new Account({
      provider,
      address: LOCKED_NEUTRAL_ADDRESS,
      signer: TEST_SIGNER,
      cairoVersion: "1",
      transactionVersion: "0x3",
      plugins: false,
    });
    const call: Call = {
      contractAddress: "0x987654321",
      entrypoint: "privacy_invoke",
      calldata: ["0x1", "0x2", "0x3"],
    };
    const proof = "AQIDBA==";
    const proofFacts = ["0xabc", "0xdef"];
    const resourceBounds = {
      l1_gas: { max_amount: 2n, max_price_per_unit: 3n },
      l1_data_gas: { max_amount: 5n, max_price_per_unit: 7n },
      l2_gas: { max_amount: 11n, max_price_per_unit: 13n },
    };

    const signed = await account.getSignedTransaction(call, {
      nonce: 7n,
      resourceBounds,
      tip: 0,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      proof,
      proofFacts,
    });

    expect(assertSignedExitTransaction(signed, {
      nonce: 7n,
      executeCalldata: transaction.getExecuteCalldata([call], "1"),
      proof,
      proofFacts,
      resourceBounds,
      networkCapFri: 184n,
    })).toBe(true);

    const publicKey = ec.starkCurve.getStarkKey(TEST_SIGNER);
    expect(assertOuterSignatureMatchesHash(signed, publicKey)).toMatch(/^0x[0-9a-f]+$/);
  });

  it("persists and revalidates the exact signed exit artifact required for safe rebroadcast", async () => {
    const provider = new RpcProvider({ nodeUrl: "http://127.0.0.1:1", plugins: false });
    vi.spyOn(provider, "getChainId").mockResolvedValue(MAINNET_CHAIN_ID);
    const account = new Account({
      provider,
      address: LOCKED_NEUTRAL_ADDRESS,
      signer: TEST_SIGNER,
      cairoVersion: "1",
      transactionVersion: "0x3",
      plugins: false,
    });
    const validated = validatePreparedExitPackage(preparedClaimPackage(), EXIT_POLICY);
    const call: Call = {
      contractAddress: validated.call.contractAddress,
      entrypoint: validated.call.entrypoint,
      calldata: validated.call.calldata.map((value) => `0x${BigInt(value).toString(16)}`),
    };
    const proofFacts = validated.proof.facts.facts.map((value) => `0x${BigInt(value).toString(16)}`);
    const resourceBounds = {
      l1_gas: { max_amount: 2n, max_price_per_unit: 3n },
      l1_data_gas: { max_amount: 5n, max_price_per_unit: 7n },
      l2_gas: { max_amount: 11n, max_price_per_unit: 13n },
    };
    const signed = await account.getSignedTransaction(call, {
      nonce: 7n,
      resourceBounds,
      tip: 0,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      proof: validated.proof.data,
      proofFacts,
    });
    const publicKey = ec.starkCurve.getStarkKey(TEST_SIGNER);
    const expectedHash = assertOuterSignatureMatchesHash(signed, publicKey);
    const serialized = serializeSignedExitForStorage(signed);
    const restored = JSON.parse(serialized) as Record<string, unknown>;
    expect(validateStoredSignedExit(restored, validated, expectedHash, publicKey)).toBe(true);

    const tampered = structuredClone(restored);
    (tampered.calldata as string[])[0] = "0x999";
    expect(() => validateStoredSignedExit(tampered, validated, expectedHash, publicKey)).toThrow();
  });
});

function preparedClaimPackage() {
  const noteId = 0x123n;
  const vaultId = 0x456n;
  const validUntil = 2_000_000_000n;
  const storageAddress = BigInt(hash.computePedersenHash(hash.starknetKeccak("notes"), noteId)) % constants.ADDR_BOUND;
  const actions = [
    3n,
    0n, storageAddress, 2n, OPEN_NOTE_PACKED_VALUE, BigInt(LOCKED_TOKEN_ADDRESS),
    7n, 1n, 2n, 3n, BigInt(LOCKED_TOKEN_ADDRESS), noteId,
    10n, BigInt(LOCKED_AFTERLIGHT_ADDRESS), 11n,
    2n, vaultId, BigInt(LOCKED_TOKEN_ADDRESS), LOCKED_AMOUNT_FRI, 2n, 1n, 3n, noteId, validUntil, 4n, 5n,
  ];
  const input: any = {
    schema: "afterlight-prepared-neutral-exit/1",
    evidence: "APPLICATION_AUTHORIZED_OUTER_UNSIGNED_NOT_SUBMITTED",
    action: "CLAIM",
    chainId: MAINNET_CHAIN_ID,
    neutralAddress: POLICY_NEUTRAL,
    afterlightAddress: LOCKED_AFTERLIGHT_ADDRESS,
    poolAddress: LOCKED_POOL_ADDRESS,
    tokenAddress: LOCKED_TOKEN_ADDRESS,
    amountFri: LOCKED_AMOUNT_FRI.toString(),
    vaultId: `0x${vaultId.toString(16)}`,
    expectedState: "2",
    expectedEpoch: "1",
    expectedRoleNonce: "3",
    destinationNoteId: `0x${noteId.toString(16)}`,
    validUntil: validUntil.toString(),
    preparedAtBlock: "100",
    prepared: {
      call: {
        contractAddress: LOCKED_POOL_ADDRESS,
        entrypoint: "apply_actions",
        calldata: [...actions.map(String), "1"],
      },
      proof: {
        data: "AQ==",
        output: [LOCKED_POOL_CLASS_HASH, ...actions.map(String)],
        proof_facts: [PROOF1_HEADER, "1", "1", "1", "100", "1", "1", "1", "1"],
      },
    },
  };
  input.locks = buildExitLocks(input);
  return input;
}
