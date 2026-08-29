import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { RelayPlan } from "../src/core.js";
import { readActualFeeFri } from "../src/starknet-adapter.js";
import {
  ExecutorError,
  assessBalanceHealth,
  createStarknetRelayAdapter,
  executeRelayPlan,
  executorReadiness,
  readBalanceHealth,
  type BudgetCoordinator,
  type ExactReceipt,
  type ExactSimulation,
  type ExactSubmission,
  type StarknetRelayAdapter,
} from "../src/executor.js";

const nowMs = Date.UTC(2026, 7, 24, 12);
const day = "2026-08-24";
const seededOwner = "a".repeat(64);
const plan: RelayPlan = Object.freeze({
  schema: "afterlight-relay-plan/1",
  operation: "HEARTBEAT",
  chainId: "0x534e5f4d41494e",
  fingerprint: "e".repeat(64),
  semanticKey: "d".repeat(64),
  call: Object.freeze({
    contractAddress: "0x1234",
    entrypoint: "heartbeat",
    calldata: Object.freeze(["0x1"]),
  }),
  requiresContractSimulation: true,
  contractVerificationAuthoritative: true,
  maxSponsoredFeeFri: "200",
  dailySponsorBudgetFri: "1000",
});

const policy = {
  submitEnabled: true,
  perCallCapFri: 200n,
  dailyBudgetFri: 1_000n,
  feeMarginBps: 11_000n,
} as const;

describe("fail-closed exact-call executor", () => {
  it("accepts only scalar or explicitly FRI control receipt fees", () => {
    expect(readActualFeeFri("0x46")).toBe("70");
    expect(readActualFeeFri({ amount: "0x46", unit: "FRI" })).toBe("70");
    expect(readActualFeeFri({ amount: "0x46" })).toBeUndefined();
    expect(readActualFeeFri({ amount: "0x46", unit: "WEI" })).toBeUndefined();
  });
  it("does nothing when submission is disabled", async () => {
    const adapter = fakeAdapter();
    const budget = freshBudget();
    await expect(
      executeRelayPlan(plan, { ...policy, submitEnabled: false }, adapter, budget, nowMs),
    ).rejects.toThrowError(new ExecutorError("submission_disabled"));
    expect(adapter.simulateExact).not.toHaveBeenCalled();
    expect(await budget.snapshot(day)).toMatchObject({ reservedTodayFri: "0", spentTodayFri: "0" });
  });

  it("keeps the concrete adapter unreachable under inert Phase A configuration", () => {
    expect(() => createStarknetRelayAdapter(env)).toThrowError(
      new ExecutorError("executor_config_incomplete"),
    );
  });

  it("does not reserve or submit when exact-call simulation fails", async () => {
    const adapter = fakeAdapter({ simulation: { ok: false } });
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
      new ExecutorError("simulation_failed"),
    );
    expect(adapter.signAndSubmitExact).not.toHaveBeenCalled();
    expect(await budget.snapshot(day)).toMatchObject({ reservedTodayFri: "0", spentTodayFri: "0" });
  });

  it("rejects the quoted transaction above the cap before reservation", async () => {
    const adapter = fakeAdapter({ simulation: successfulSimulation("190") });
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
      new ExecutorError("fee_policy_rejected"),
    );
    expect(adapter.signAndSubmitExact).not.toHaveBeenCalled();
    expect(await budget.snapshot(day)).toMatchObject({ reservedTodayFri: "0", spentTodayFri: "0" });
  });

  it("releases only when the adapter proves submission never started", async () => {
    const adapter = fakeAdapter({ submission: { submitted: false } });
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
      new ExecutorError("submission_not_started"),
    );
    expect(await budget.snapshot(day)).toMatchObject({ reservedTodayFri: "0", spentTodayFri: "0" });
  });

  it.each([41, 52, 53, 54, 55])(
    "releases a prepared control reservation after definitive RPC rejection %i",
    async (code) => {
      const adapter = fakeAdapter({ submissionError: { baseError: { code } } });
      const budget = freshBudget();
      await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
        new ExecutorError("submission_not_started"),
      );
      expect(await budget.snapshot(day)).toMatchObject({ reservedTodayFri: "0", spentTodayFri: "0" });
      expect(await budget.lookup(plan.semanticKey)).toMatchObject({ outcome: "found", state: "released" });
      expect(adapter.reconcileReceipt).not.toHaveBeenCalled();
    },
  );

  it("keeps a prepared control reservation locked after an ambiguous broadcast failure", async () => {
    const adapter = fakeAdapter({ submissionError: new Error("network unavailable") });
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
      new ExecutorError("submission_uncertain"),
    );
    expect(await budget.snapshot(day)).toMatchObject({
      reservedTodayFri: "110",
      spentTodayFri: "0",
      reservedCount: 1,
    });
    expect(await budget.lookup(plan.semanticKey)).toMatchObject({
      outcome: "found",
      state: "reserved",
      transactionHash: "0xabc",
      preparedPayload: "{}",
    });
  });

  it("keeps ambiguous receipt exposure reserved for exact-request reconciliation", async () => {
    const adapter = fakeAdapter({ receipt: { status: "pending" } });
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
      new ExecutorError("receipt_unreconciled"),
    );
    expect(await budget.snapshot(day)).toMatchObject({
      reservedTodayFri: "110",
      spentTodayFri: "0",
      submittedCount: 1,
    });
    expect(await budget.lookup(plan.semanticKey)).toMatchObject({
      outcome: "found",
      state: "submitted",
      transactionHash: "0xabc",
    });
  });

  it("reconciles a previously submitted transaction without simulating or signing again", async () => {
    const adapter = fakeAdapter();
    adapter.reconcileReceipt = vi
      .fn<StarknetRelayAdapter["reconcileReceipt"]>()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce(successfulReceipt());
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
      new ExecutorError("receipt_unreconciled"),
    );
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs + 1)).resolves.toMatchObject({
      status: "accepted",
      transactionHash: "0xabc",
      actualFeeFri: "70",
    });
    expect(adapter.simulateExact).toHaveBeenCalledTimes(1);
    expect(adapter.signAndSubmitExact).toHaveBeenCalledTimes(1);
    expect(adapter.reconcileReceipt).toHaveBeenCalledTimes(2);
  });

  it("takes over an exact hashless reservation only after its owner lease expires", async () => {
    const adapter = fakeAdapter();
    const budget = freshBudget();
    await budget.reserve({
      budgetClass: "control",
      dayKey: day,
      semanticKey: plan.semanticKey,
      exactFingerprint: plan.fingerprint,
      maxFeeFri: "110",
      perCallCapFri: "200",
      dailyBudgetFri: "1000",
      ownerToken: seededOwner,
      nowMs,
    });

    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs + 1)).resolves.toEqual({
      status: "duplicate",
      state: "reserved",
      transactionHash: null,
    });
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs + 120_001)).resolves.toMatchObject({
      status: "accepted",
      transactionHash: "0xabc",
    });
    expect(adapter.signAndSubmitExact).toHaveBeenCalledOnce();
  });

  it("rebroadcasts and reconciles an exact prepared checkpoint across semantic buckets", async () => {
    const adapter = fakeAdapter();
    const budget = freshBudget();
    await budget.reserve({
      budgetClass: "control",
      dayKey: day,
      semanticKey: plan.semanticKey,
      exactFingerprint: plan.fingerprint,
      maxFeeFri: "110",
      perCallCapFri: "200",
      dailyBudgetFri: "1000",
      ownerToken: seededOwner,
      nowMs,
    });
    await budget.markPrepared(plan.semanticKey, plan.fingerprint, "0xabc", "{}", seededOwner, nowMs + 1);
    const nextBucket = { ...plan, semanticKey: "b".repeat(64) };

    await expect(executeRelayPlan(nextBucket, policy, adapter, budget, nowMs + 2)).resolves.toMatchObject({
      status: "accepted",
      transactionHash: "0xabc",
    });
    expect(adapter.rebroadcastPreparedExact).toHaveBeenCalledWith(
      expect.objectContaining({ semanticKey: plan.semanticKey }),
      "110",
      "0xabc",
      "{}",
    );
    expect(adapter.simulateExact).not.toHaveBeenCalled();
    expect(adapter.signAndSubmitExact).not.toHaveBeenCalled();
  });

  it("recovers a submitted checkpoint after its time-bucket semantic key changes", async () => {
    const adapter = fakeAdapter();
    adapter.reconcileReceipt = vi
      .fn<StarknetRelayAdapter["reconcileReceipt"]>()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce(successfulReceipt());
    const budget = freshBudget();
    const beforeFreshExecution = vi.fn(async () => {});
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs, beforeFreshExecution)).rejects.toThrowError(
      new ExecutorError("receipt_unreconciled"),
    );
    const nextBucket: RelayPlan = { ...plan, semanticKey: "b".repeat(64) };
    await expect(executeRelayPlan(nextBucket, policy, adapter, budget, nowMs + 15_000, beforeFreshExecution)).resolves.toMatchObject({
      status: "accepted",
      transactionHash: "0xabc",
      actualFeeFri: "70",
    });
    expect(beforeFreshExecution).toHaveBeenCalledTimes(1);
    expect(adapter.simulateExact).toHaveBeenCalledTimes(1);
    expect(adapter.signAndSubmitExact).toHaveBeenCalledTimes(1);
    expect(adapter.reconcileReceipt).toHaveBeenCalledTimes(2);
  });

  it("commits gas from a definitive reverted receipt and reports failure", async () => {
    const adapter = fakeAdapter({
      receipt: {
        status: "accepted",
        execution: "reverted",
        transactionHash: "0xabc",
        callFingerprint: plan.fingerprint,
        actualFeeFri: "70",
      },
    });
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
      new ExecutorError("receipt_reverted"),
    );
    expect(await budget.snapshot(day)).toMatchObject({
      reservedTodayFri: "0",
      spentTodayFri: "70",
      revertedCount: 1,
    });
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).resolves.toEqual({
      status: "duplicate",
      state: "reverted",
      transactionHash: "0xabc",
    });
    expect(adapter.simulateExact).toHaveBeenCalledTimes(1);
  });

  it("records full over-cap receipt spend and freezes sponsorship", async () => {
    const adapter = fakeAdapter({
      receipt: {
        status: "accepted",
        execution: "succeeded",
        transactionHash: "0xabc",
        callFingerprint: plan.fingerprint,
        actualFeeFri: "120",
      },
    });
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).rejects.toThrowError(
      new ExecutorError("sponsorship_invariant_breach"),
    );
    expect(await budget.snapshot(day)).toMatchObject({
      reservedTodayFri: "0",
      spentTodayFri: "120",
      breachedCount: 1,
      sponsorshipFrozen: true,
    });
  });

  it("commits a matched receipt and suppresses duplicate submission", async () => {
    const adapter = fakeAdapter();
    const budget = freshBudget();
    await expect(executeRelayPlan(plan, policy, adapter, budget, nowMs)).resolves.toMatchObject({
      status: "accepted",
      transactionHash: "0xabc",
      actualFeeFri: "70",
    });
    const alternateExactPlan: RelayPlan = { ...plan, fingerprint: "f".repeat(64) };
    await expect(executeRelayPlan(alternateExactPlan, policy, adapter, budget, nowMs)).resolves.toEqual({
      status: "duplicate",
      state: "committed",
      transactionHash: "0xabc",
    });
    expect(adapter.simulateExact).toHaveBeenCalledTimes(1);
    expect(adapter.signAndSubmitExact).toHaveBeenCalledTimes(1);
  });

  it("exposes only readiness and balance threshold states in Phase A", () => {
    const readiness = executorReadiness(env);
    expect(readiness).toEqual({
      configurationReady: false,
      signerAdapterAvailable: true,
      executable: false,
    });
    expect(assessBalanceHealth(undefined, "100", true)).toEqual({
      status: "unavailable",
      alert: true,
    });
    expect(assessBalanceHealth("99", "100", true)).toEqual({ status: "low", alert: true });
    expect(assessBalanceHealth("100", "100", true)).toEqual({ status: "ok", alert: false });
    expect(assessBalanceHealth("100", "100", false)).toEqual({
      status: "disabled",
      alert: false,
    });
  });

  it("collapses the balance hook to a privacy-safe status", async () => {
    const adapter = fakeAdapter();
    await expect(readBalanceHealth(adapter, "900", true)).resolves.toEqual({
      status: "ok",
      alert: false,
    });
    adapter.readRelayerBalance = vi.fn(async () => {
      throw new Error("rpc detail must not escape");
    });
    await expect(readBalanceHealth(adapter, "900", true)).resolves.toEqual({
      status: "unavailable",
      alert: true,
    });
  });
});

function freshBudget(): BudgetCoordinator {
  return env.RELAY_BUDGET.getByName(crypto.randomUUID());
}

function successfulSimulation(quotedFeeFri = "100"): ExactSimulation {
  return {
    ok: true,
    callFingerprint: plan.fingerprint,
    quotedFeeFri,
    feeQuote: {
      nonce: "7",
      resourceBounds: {
        l1_gas: { max_amount: "10", max_price_per_unit: "10" },
        l1_data_gas: { max_amount: "0", max_price_per_unit: "0" },
        l2_gas: { max_amount: "0", max_price_per_unit: "0" },
      },
    },
  };
}

function fakeAdapter(overrides: {
  simulation?: ExactSimulation;
  submission?: ExactSubmission;
  submissionError?: unknown;
  receipt?: ExactReceipt;
} = {}): StarknetRelayAdapter & {
  simulateExact: ReturnType<typeof vi.fn<StarknetRelayAdapter["simulateExact"]>>;
  signAndSubmitExact: ReturnType<typeof vi.fn<StarknetRelayAdapter["signAndSubmitExact"]>>;
  rebroadcastPreparedExact: ReturnType<typeof vi.fn<StarknetRelayAdapter["rebroadcastPreparedExact"]>>;
} {
  return {
    simulateExact: vi.fn(async () => overrides.simulation ?? successfulSimulation()),
    signAndSubmitExact: vi.fn(async (_plan, _simulation, transactionMaxFeeFri, persistPrepared) => {
      await persistPrepared("0xabc", "{}");
      if (overrides.submissionError !== undefined) throw overrides.submissionError;
      return overrides.submission ?? {
        submitted: true,
        transactionHash: "0xabc",
        callFingerprint: plan.fingerprint,
        transactionMaxFeeFri,
      };
    }),
    rebroadcastPreparedExact: vi.fn(async () => {}),
    reconcileReceipt: vi.fn(async () => overrides.receipt ?? successfulReceipt()),
    readRelayerBalance: vi.fn(async () => "1000"),
  };
}

function successfulReceipt(): ExactReceipt {
  return {
    status: "accepted",
    execution: "succeeded",
    transactionHash: "0xabc",
    callFingerprint: plan.fingerprint,
    actualFeeFri: "70",
  };
}
