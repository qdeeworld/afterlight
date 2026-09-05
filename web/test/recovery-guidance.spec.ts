import { describe, expect, it } from "vitest";
import type { VaultSnapshot } from "../src/model.ts";
import { successorRecoveryGuidance, type SuccessorRecoveryGuidanceInput } from "../src/recovery-guidance.ts";

const active: VaultSnapshot = {
  exists: true,
  state: "1",
  mode: "1",
  ownerKey: "0x1",
  successorKey: "0x2",
  token: "0x3",
  amount: "1000000000000000000",
  inactivitySeconds: "300",
  graceSeconds: "300",
  lastHeartbeat: "1000",
  requestedAt: "0",
  claimAfter: "0",
  epoch: "1",
  ownerNonce: "0",
  successorNonce: "0",
};
const grace: VaultSnapshot = { ...active, state: "2", requestedAt: "1300", claimAfter: "1600" };
const ready: SuccessorRecoveryGuidanceInput = {
  snapshot: grace,
  invitationValid: true,
  keyVerified: true,
  keyMatches: true,
  walletConnected: true,
  exitCapacity: "ready",
  nowSeconds: 1600,
};

function guidance(overrides: Partial<SuccessorRecoveryGuidanceInput> = {}): string {
  return successorRecoveryGuidance({ ...ready, ...overrides }).now;
}

describe("successor recovery guidance", () => {
  it.each([
    ["3", "Review the completed recovery"],
    ["4", "Review the reserve returned to its owner"],
  ])("puts terminal state %s ahead of missing prerequisites or retained requests", (state, expected) => {
    expect(guidance({
      snapshot: { ...grace, state }, invitationValid: false, keyVerified: false,
      keyMatches: false, walletConnected: false, exitCapacity: "unknown",
      preparationRejected: true, pendingClaim: true,
    })).toBe(expected);
  });

  it("keeps backup verification and designated-key matching ahead of recovery", () => {
    expect(guidance({ keyVerified: false })).toBe("Secure your successor key");
    expect(guidance({ keyMatches: false })).toBe("Restore the designated successor key");
    expect(guidance({ keyMatches: false, snapshot: undefined })).toBe("Restore the designated successor key");
  });

  it("requires invitation and live verification before time-based guidance", () => {
    expect(guidance({ invitationValid: false, keyMatches: false, snapshot: undefined })).toBe("Import the recovery invitation");
    expect(guidance({ snapshot: undefined })).toBe("Read the live reserve");
    expect(guidance({ snapshot: { ...grace, exists: false } })).toBe("Read the live reserve");
  });

  it.each([
    [1299, "Wait until inactivity expires"],
    [1300, "Request recovery"],
    [1301, "Request recovery"],
  ])("handles the exact inactivity boundary at %s without requiring a wallet or exit capacity", (nowSeconds, expected) => {
    expect(guidance({ snapshot: active, nowSeconds, walletConnected: false, exitCapacity: "exhausted" })).toBe(expected);
  });

  it.each([
    [1599, "Wait for the grace period to finish"],
    [1600, "Recover privately after validation"],
    [1601, "Recover privately after validation"],
  ])("handles the exact grace boundary at %s without claiming preparation already passed", (nowSeconds, expected) => {
    expect(guidance({ nowSeconds })).toBe(expected);
  });

  it("shows the next missing prerequisite after grace rather than declaring recovery ready", () => {
    expect(guidance({ walletConnected: false, preparationRejected: true })).toBe("Connect Ready X to continue recovery");
    expect(guidance({ preparationRejected: true, exitCapacity: "exhausted" })).toBe("Check preparation only — no claim");
    expect(guidance({ exitCapacity: "checking" })).toBe("Checking sponsored recovery capacity");
    expect(guidance({ exitCapacity: "unknown" })).toBe("Check sponsored recovery capacity again");
    expect(guidance({ exitCapacity: "exhausted" })).toBe("Wait for sponsored recovery capacity");
  });

  it("reconciles a retained claim before considering another preparation or deadline", () => {
    expect(guidance({ pendingClaim: true, nowSeconds: 1599, exitCapacity: "exhausted", preparationRejected: true }))
      .toBe("Reconcile the pending private recovery");
    expect(guidance({ pendingClaim: true, walletConnected: false })).toBe("Connect Ready X to reconcile recovery");
    expect(guidance({ pendingClaim: true, keyMatches: false })).toBe("Restore the designated successor key");
  });

  it("keeps unsupported states and unusable timestamps non-actionable", () => {
    expect(guidance({ snapshot: { ...grace, state: "9" } })).toBe("Refresh the live reserve");
    expect(guidance({ snapshot: { ...grace, claimAfter: "unknown" } })).toBe("Refresh the live reserve");
    expect(guidance({ snapshot: { ...active, lastHeartbeat: "unknown" } })).toBe("Refresh the live reserve");
    expect(guidance({ nowSeconds: Number.NaN })).toBe("Refresh the live reserve");
    expect(guidance({ snapshot: { ...grace, claimAfter: "18446744073709551615" } })).toBe("Wait for the grace period to finish");
  });
});
