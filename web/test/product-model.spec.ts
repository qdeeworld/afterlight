import { describe, expect, it } from "vitest";
import { CONTRACT, STRK } from "../src/config.ts";
import { isHashlessRelayedResult, isRetryableCheckpointCode } from "../src/checkpoint-policy.ts";
import { isCompatibleReadyVersion, isRecognizedReadyName } from "../src/compatibility.ts";
import { classifyTransactionOutcome, executeFundingSequence, isExplicitWalletRejection, parsePendingFundingAttempt, withAvailableExclusiveLock, type AvailableLockManager } from "../src/funding-attempt.ts";
import { parseInvitation, type RecoveryInvitation, type VaultSnapshot } from "../src/model.ts";
import { assertInvitationMatchesVault, bindVerifiedVault, snapshotForInvitation } from "../src/vault-verification.ts";

const invitation = {
  version: 1,
  chain: "SN_MAIN",
  contract: CONTRACT,
  vaultId: "0x123",
  ownerKey: "0x456",
  successorKey: "0x789",
  token: "STRK",
  amount: "1",
  mode: "NORMAL",
  inactivitySeconds: "2592000",
  graceSeconds: "604800",
};

describe("public product compatibility", () => {
  it.each(["Ready", "Ready X", "Ready Wallet", "Argent X", "ARGENT-X Wallet"])("recognizes the supported Ready identity %s", (name) => {
    expect(isRecognizedReadyName(name)).toBe(true);
  });

  it.each(["Braavos", "MetaMask", "Not Ready", "Ready Wallet Clone", ""])("rejects an unrelated wallet identity %s", (name) => {
    expect(isRecognizedReadyName(name)).toBe(false);
  });

  it.each(["5.33.9", "5.34.0", "5.99.1", "5.33.9+ready.1"])("accepts compatible Ready %s", (version) => {
    expect(isCompatibleReadyVersion(version)).toBe(true);
  });

  it.each(["5.33.8", "5.33.9-beta.1", "4.99.0", "6.0.0", "latest", ""])("rejects incompatible Ready %s", (version) => {
    expect(isCompatibleReadyVersion(version)).toBe(false);
  });

  it("accepts the exact NORMAL terms exposed as the canonical product", () => {
    expect(parseInvitation(JSON.stringify(invitation))).toMatchObject({ valid: true });
  });

  it("accepts only the exact contract-enforced Recovery Drill terms", () => {
    expect(parseInvitation(JSON.stringify({
      ...invitation,
      mode: "FAST_DEMO",
      inactivitySeconds: "300",
      graceSeconds: "300",
    }))).toMatchObject({ valid: true });
    expect(parseInvitation(JSON.stringify({
      ...invitation,
      mode: "FAST_DEMO",
      inactivitySeconds: "301",
      graceSeconds: "300",
    }))).toMatchObject({ valid: false });
  });

  it.each([
    "internal_error",
    "receipt_unreconciled",
    "receipt_reverted",
    "relayer_busy",
    "fee_policy_rejected",
    "simulation_failed",
    "simulation_mismatch",
    "signer_adapter_unavailable",
    "sponsorship_frozen",
    "sponsorship_invariant_breach",
    "submission_mismatch",
    "submission_not_started",
    "submission_uncertain",
  ])("retains the owner-bound checkpoint token for retryable %s outcomes", (code) => {
    expect(isRetryableCheckpointCode(code)).toBe(true);
  });

  it.each(["funding_unavailable", "invalid_request", "submission_disabled", undefined])(
    "clears the checkpoint token for definitive %s outcomes",
    (code) => {
      expect(isRetryableCheckpointCode(code)).toBe(false);
    },
  );

  it.each(["accepted", "duplicate"])(
    "retains exact retry state for a hashless relayed %s result",
    (status) => {
      expect(isHashlessRelayedResult("relayed", status, null)).toBe(true);
      expect(isHashlessRelayedResult("relayed", status, undefined)).toBe(true);
    },
  );

  it("does not classify terminal hashes or malformed responses as hashless relays", () => {
    expect(isHashlessRelayedResult("relayed", "duplicate", "0x123")).toBe(false);
    expect(isHashlessRelayedResult("error", "duplicate", null)).toBe(false);
    expect(isHashlessRelayedResult("relayed", "reverted", null)).toBe(false);
  });
});

describe("pending funding recovery", () => {
  it("restores the exact invitation saved before wallet approval", () => {
    const preparedAt = "2026-09-03T16:00:00.000Z";
    expect(parsePendingFundingAttempt(JSON.stringify({ invitation, preparedAt }))).toEqual({
      invitation,
      transactionHash: undefined,
      preparedAt,
    });
  });

  it("normalizes a recorded transaction hash for Mainnet reconciliation", () => {
    const attempt = parsePendingFundingAttempt(JSON.stringify({
      invitation,
      transactionHash: "0x000ABC",
      preparedAt: "2026-09-03T16:00:00.000Z",
    }));
    expect(attempt?.transactionHash).toBe("0xabc");
  });

  it.each([
    null,
    "not json",
    JSON.stringify({ invitation, preparedAt: "not-a-date" }),
    JSON.stringify({ invitation, transactionHash: "pending", preparedAt: "2026-09-03T16:00:00.000Z" }),
    JSON.stringify({ invitation: { ...invitation, contract: "0x123" }, preparedAt: "2026-09-03T16:00:00.000Z" }),
  ])("rejects a malformed pending record", (record) => {
    expect(parsePendingFundingAttempt(record)).toBeUndefined();
  });

  it.each([
    ["SUCCEEDED", "ACCEPTED_ON_L2", "succeeded"],
    ["SUCCEEDED", "ACCEPTED_ON_L1", "succeeded"],
    ["REVERTED", "ACCEPTED_ON_L2", "reverted"],
    [undefined, "REJECTED", "rejected"],
    ["REVERTED", "PRE_CONFIRMED", "unknown"],
    ["SUCCEEDED", "PRE_CONFIRMED", "unknown"],
    ["REVERTED", undefined, "unknown"],
  ])("requires accepted finality for %s / %s", (execution, finality, outcome) => {
    expect(classifyTransactionOutcome(execution, finality)).toBe(outcome);
  });

  it("clears only standardized, explicit wallet refusals", () => {
    expect(isExplicitWalletRejection({ code: 113 })).toBe(true);
    expect(isExplicitWalletRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isExplicitWalletRejection({ code: 163, message: "unknown" })).toBe(false);
    expect(isExplicitWalletRejection(new Error("user rejected"))).toBe(false);
  });

  it("fails closed when another tab already holds the funding lock", async () => {
    const unavailable: AvailableLockManager = {
      request: async (_name, _options, callback) => callback(null),
    };
    await expect(withAvailableExclusiveLock(unavailable, "afterlight:funding:v1", async () => "funded"))
      .rejects.toThrow("Another Afterlight tab");
  });

  it("runs one funding action while the exclusive lock is available", async () => {
    const available: AvailableLockManager = {
      request: async (_name, _options, callback) => callback({}),
    };
    await expect(withAvailableExclusiveLock(available, "afterlight:funding:v1", async () => "funded"))
      .resolves.toBe("funded");
  });

  it("persists the invitation before invoking Ready and records the hash before finality", async () => {
    const order: string[] = [];
    await expect(executeFundingSequence({
      invitation: invitation as RecoveryInvitation,
      checkpoint: async () => { order.push("checkpoint"); return "0x1"; },
      onCheckpoint: () => order.push("checkpoint-callback"),
      onPrepared: () => order.push("prepared"),
      invoke: async () => { order.push("invoke"); return "0x2"; },
      onSubmitted: () => order.push("submitted"),
      waitForSuccess: async () => { order.push("confirmed"); },
    })).resolves.toBe("0x2");
    expect(order).toEqual(["checkpoint", "checkpoint-callback", "prepared", "invoke", "submitted", "confirmed"]);
  });

  it("never reports submission or confirmation after a wallet refusal", async () => {
    const order: string[] = [];
    await expect(executeFundingSequence({
      invitation: invitation as RecoveryInvitation,
      checkpoint: async () => "0x1",
      onPrepared: () => order.push("prepared"),
      invoke: async () => { order.push("invoke"); throw { code: 113 }; },
      onSubmitted: () => order.push("submitted"),
      waitForSuccess: async () => { order.push("confirmed"); },
    })).rejects.toMatchObject({ code: 113 });
    expect(order).toEqual(["prepared", "invoke"]);
  });
});

describe("Mainnet invitation verification", () => {
  const snapshot: VaultSnapshot = {
    exists: true,
    state: "1",
    mode: "0",
    ownerKey: invitation.ownerKey,
    successorKey: invitation.successorKey,
    token: STRK,
    amount: "1000000000000000000",
    inactivitySeconds: invitation.inactivitySeconds,
    graceSeconds: invitation.graceSeconds,
    lastHeartbeat: "1",
    requestedAt: "0",
    claimAfter: "0",
    epoch: "1",
    ownerNonce: "0",
    successorNonce: "0",
  };

  it("accepts only the invitation's exact on-chain terms", () => {
    expect(() => assertInvitationMatchesVault(invitation as RecoveryInvitation, snapshot)).not.toThrow();
  });

  it.each([
    ["owner key", { ownerKey: "0x999" }],
    ["successor key", { successorKey: "0x999" }],
    ["token", { token: "0x999" }],
    ["amount", { amount: "2" }],
    ["mode", { mode: "1" }],
    ["inactivity", { inactivitySeconds: "300" }],
    ["grace", { graceSeconds: "300" }],
  ])("rejects a mismatched %s", (label, change) => {
    expect(() => assertInvitationMatchesVault(invitation as RecoveryInvitation, { ...snapshot, ...change }))
      .toThrow(`Invitation ${label} does not match Mainnet state.`);
  });

  it("never reuses an identical snapshot for a different vault ID", () => {
    const record = bindVerifiedVault(invitation as RecoveryInvitation, snapshot);
    const otherInvitation = { ...invitation, vaultId: "0x124" } as RecoveryInvitation;
    expect(snapshotForInvitation(otherInvitation, record)).toBeUndefined();
    expect(snapshotForInvitation(invitation as RecoveryInvitation, record)).toBe(snapshot);
  });
});
