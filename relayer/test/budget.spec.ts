import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { RelayBudget } from "../src/budget.js";

const dayOne = "2026-08-24";
const dayTwo = "2026-08-25";
const semantic = "a".repeat(64);
const exact = "b".repeat(64);
const alternateExact = "c".repeat(64);
const owner = "d".repeat(64);
const alternateOwner = "e".repeat(64);

describe("deployment-wide sponsorship coordinator", () => {
  it("reserves, deduplicates, releases, records SUBMITTED, and commits exactly once", async () => {
    const budget = freshBudget();
    expect(await budget.lookup(semantic)).toEqual({
      outcome: "missing",
      sponsorshipFrozen: false,
    });

    expect((await budget.reserve(reserveInput())).outcome).toBe("reserved");
    expect((await budget.reserve(reserveInput(semantic, alternateExact))).outcome).toBe(
      "duplicate_reserved",
    );
    expect((await budget.release(semantic, exact, owner, 2)).outcome).toBe("released");
    expect((await budget.release(semantic, exact, owner, 3)).outcome).toBe("already_released");

    expect((await budget.reserve(reserveInput(semantic, alternateExact, "100", dayOne, 4))).outcome)
      .toBe("reserved");
    expect((await budget.markSubmitted(semantic, alternateExact, "0xabc", 5)).outcome).toBe(
      "submitted",
    );
    expect(await budget.lookup(semantic)).toMatchObject({
      outcome: "found",
      state: "submitted",
      exactFingerprint: alternateExact,
      transactionHash: "0xabc",
    });
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() => instance.release(semantic, alternateExact, owner, 6)).toThrowError(
        "reservation_not_releasable",
      );
    });

    expect(
      (await budget.finalize(semantic, alternateExact, "0xabc", "70", "succeeded", 7)).outcome,
    ).toBe("committed");
    expect(
      (await budget.finalize(semantic, alternateExact, "0xabc", "70", "succeeded", 8)).outcome,
    ).toBe("already_committed");
    expect((await budget.reserve(reserveInput(semantic, exact, "99", dayTwo, 9))).outcome).toBe(
      "duplicate_committed",
    );
    expect(await budget.snapshot(dayOne)).toMatchObject({
      reservedTodayFri: "0",
      spentTodayFri: "70",
      submittedCount: 0,
      committedCount: 1,
      sponsorshipFrozen: false,
    });
  });

  it("persists a recoverable expected hash before broadcast and releases a definitive reject", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput());
    const prepared = JSON.stringify({ signed: "exact-artifact" });
    expect((await budget.markPrepared(semantic, exact, "0xabc", prepared, owner, 2)).outcome).toBe("prepared");
    expect((await budget.markPrepared(semantic, exact, "0xabc", prepared, owner, 3)).outcome).toBe("already_prepared");
    expect(await budget.lookup(semantic)).toMatchObject({
      state: "reserved",
      transactionHash: "0xabc",
      preparedPayload: prepared,
    });
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() => instance.markSubmitted(semantic, exact, "0xdef", 4)).toThrowError(
        "idempotency_conflict",
      );
    });
    expect((await budget.release(semantic, exact, owner, 5)).outcome).toBe("released");
    expect(await budget.snapshot(dayOne)).toMatchObject({ reservedTodayFri: "0" });
  });

  it("holds one admission until its exact onchain checkpoint marker is consumed", async () => {
    const budget = freshBudget();
    expect(await budget.fundingAdmissionSnapshot(1_000)).toEqual({
      acquired: false,
      active: false,
      expiresAtMs: null,
    });
    expect(await budget.acquireFundingAdmission(1_000, 600_000, owner)).toEqual({
      acquired: true,
      active: true,
      expiresAtMs: 601_000,
    });
    expect(await budget.acquireFundingAdmission(2_000, 600_000, owner)).toEqual({
      acquired: true,
      active: true,
      expiresAtMs: 601_000,
    });
    expect(await budget.fundingAdmissionSnapshot(2_000, owner)).toEqual({
      acquired: false,
      active: false,
      expiresAtMs: null,
    });
    expect(await budget.fundingAdmissionSnapshot(2_000, alternateOwner)).toEqual({
      acquired: false,
      active: true,
      expiresAtMs: 601_000,
    });
    expect(await budget.fundingAdmissionSnapshot(2_000)).toEqual({
      acquired: false,
      active: true,
      expiresAtMs: 601_000,
    });
    expect(await budget.acquireFundingAdmission(2_000, 600_000, alternateOwner)).toEqual({
      acquired: false,
      active: true,
      expiresAtMs: 601_000,
    });
    expect((await budget.acquireFundingAdmission(601_000, 600_000, alternateOwner)).acquired).toBe(true);
    expect(await budget.consumeFundingAdmission(601_001, 1, 0, "0x1", true)).toEqual({
      acquired: false,
      active: true,
      expiresAtMs: 1_201_000,
    });
    expect(await budget.bindFundingAdmissionCheckpoint(601_002, alternateOwner, 123, 4, "0x1c8")).toEqual({
      acquired: true,
      active: true,
      expiresAtMs: 1_201_000,
    });
    expect(await budget.fundingAdmissionCheckpoint(601_003)).toEqual({ blockNumber: 123, transactionIndex: 4, transactionHash: "456" });
    expect(await budget.consumeFundingAdmission(601_003, 123, 4, "0x1c8", false)).toEqual({
      acquired: false,
      active: true,
      expiresAtMs: 1_201_000,
    });
    expect(await budget.consumeFundingAdmission(601_004, 123, 4, "0x1c8", false)).toEqual({
      acquired: false,
      active: true,
      expiresAtMs: 1_201_000,
    });
    expect(await budget.consumeFundingAdmission(601_005, 123, 4, "0x1c8", true)).toEqual({
      acquired: false,
      active: false,
      expiresAtMs: 1_201_000,
    });
    expect((await budget.fundingAdmissionSnapshot(601_006)).active).toBe(false);
    expect(await budget.fundingAdmissionCheckpoint(601_006)).toBeNull();
  });

  it("cannot consume a newer admission with evidence sampled from an older checkpoint", async () => {
    const budget = freshBudget();
    await budget.acquireFundingAdmission(1_000, 600_000, owner);
    await budget.bindFundingAdmissionCheckpoint(1_001, owner, 100, 1, "0x64");
    const staleCursor = await budget.fundingAdmissionCheckpoint(1_002);
    expect(staleCursor).toEqual({ blockNumber: 100, transactionIndex: 1, transactionHash: "100" });

    await budget.bindFundingAdmissionCheckpoint(1_003, owner, 101, 0, "0x65");
    expect(await budget.bindFundingAdmissionCheckpoint(1_003, owner, 100, 1, "0x64")).toMatchObject({
      acquired: true,
      active: true,
    });
    expect(await budget.fundingAdmissionCheckpoint(1_003)).toEqual({
      blockNumber: 101,
      transactionIndex: 0,
      transactionHash: "101",
    });
    expect(await budget.consumeFundingAdmission(1_004, 100, 1, "0x64", true)).toMatchObject({
      active: true,
    });
    expect(await budget.fundingAdmissionCheckpoint(1_005)).toEqual({
      blockNumber: 101,
      transactionIndex: 0,
      transactionHash: "101",
    });
    expect(await budget.consumeFundingAdmission(1_006, 101, 0, "0x65", true)).toMatchObject({
      active: false,
    });

    await budget.acquireFundingAdmission(601_000, 600_000, alternateOwner);
    await budget.bindFundingAdmissionCheckpoint(601_001, alternateOwner, 200, 2, "0xc8");
    expect(await budget.consumeFundingAdmission(601_002, 100, 1, "0x64", true)).toMatchObject({
      active: true,
    });
    expect(await budget.fundingAdmissionCheckpoint(601_003)).toEqual({
      blockNumber: 200,
      transactionIndex: 2,
      transactionHash: "200",
    });
  });

  it("keeps the latest same-block checkpoint when bind responses arrive in reverse order", async () => {
    const budget = freshBudget();
    await budget.acquireFundingAdmission(1_000, 600_000, owner);
    await budget.bindFundingAdmissionCheckpoint(1_001, owner, 300, 8, "0x12c8");
    await budget.bindFundingAdmissionCheckpoint(1_002, owner, 300, 7, "0x12c7");
    expect(await budget.fundingAdmissionCheckpoint(1_003)).toEqual({
      blockNumber: 300,
      transactionIndex: 8,
      transactionHash: BigInt("0x12c8").toString(),
    });
  });

  it("enforces per-call and daily exposure inside the atomic reservation", async () => {
    const budget = freshBudget();
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() =>
        instance.reserve({ ...reserveInput("d".repeat(64), exact, "101"), perCallCapFri: "100" }),
      ).toThrowError("per_call_cap");
    });

    await budget.reserve(reserveInput("e".repeat(64), exact, "60"));
    await budget.markSubmitted("e".repeat(64), exact, "0xdef", 2);
    await budget.finalize("e".repeat(64), exact, "0xdef", "60", "succeeded", 3);
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() =>
        instance.reserve({
          ...reserveInput("f".repeat(64), alternateExact, "50"),
          dailyBudgetFri: "100",
        }),
      ).toThrowError("daily_budget");
    });
    expect(await budget.snapshot(dayOne)).toMatchObject({
      reservedTodayFri: "0",
      spentTodayFri: "60",
    });
  });

  it("keeps control and exit daily totals separate while sharing one nonce lane", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput(semantic, exact, "60", dayOne, 1, "exit"));
    await budget.markSubmitted(semantic, exact, "0xabc", 2);
    await budget.finalize(semantic, exact, "0xabc", "60", "succeeded", 3);

    const controlSemantic = "d".repeat(64);
    expect((await budget.reserve(reserveInput(controlSemantic, alternateExact, "20", dayOne, 4, "control"))).outcome).toBe("reserved");
    expect(await budget.snapshot(dayOne, "exit")).toMatchObject({ reservedTodayFri: "0", spentTodayFri: "60" });
    expect(await budget.snapshot(dayOne, "control")).toMatchObject({ reservedTodayFri: "20", spentTodayFri: "0" });
  });

  it("preserves an unclassified legacy day's exposure against both class ceilings", async () => {
    const budget = freshBudget();
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      const internal = instance as unknown as {
        ctx: DurableObjectState;
        migrateLegacyTotals: () => void;
      };
      internal.ctx.storage.sql.exec(
        "INSERT INTO daily_totals (day_key, reserved_fri, spent_fri) VALUES (?, ?, ?)",
        dayOne,
        "0",
        "70",
      );
      internal.ctx.storage.sql.exec(
        "DELETE FROM class_daily_totals WHERE day_key = ?",
        dayOne,
      );
      internal.migrateLegacyTotals();
      expect(instance.snapshot(dayOne, "control")).toMatchObject({ spentTodayFri: "70" });
      expect(instance.snapshot(dayOne, "exit")).toMatchObject({ spentTodayFri: "70" });
      expect(() => instance.reserve({
        ...reserveInput(semantic, exact, "40", dayOne, 2, "exit"),
        dailyBudgetFri: "100",
      })).toThrowError("daily_budget");
    });
  });

  it("admits only one active Starknet nonce lane at a time", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput());
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() =>
        instance.reserve(reserveInput("d".repeat(64), alternateExact, "10", dayOne, 2)),
      ).toThrowError("relayer_busy");
    });
    await budget.release(semantic, exact, owner, 3);
    expect(
      (await budget.reserve(reserveInput("d".repeat(64), alternateExact, "10", dayOne, 4)))
        .outcome,
    ).toBe("reserved");
  });

  it("reports the active nonce lane globally across class and UTC rollover", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput(semantic, exact, "60", dayOne, 1, "control"));
    expect(await budget.snapshot(dayTwo, "exit")).toMatchObject({
      reservedCount: 0,
      submittedCount: 0,
    });
    expect(await budget.activeSnapshot()).toEqual({
      reservedCount: 1,
      submittedCount: 0,
      sponsorshipFrozen: false,
    });
    await budget.markSubmitted(semantic, exact, "0xabc", 2);
    expect(await budget.activeSnapshot()).toMatchObject({
      reservedCount: 0,
      submittedCount: 1,
    });
    expect(await budget.activeSnapshot(exact)).toMatchObject({
      reservedCount: 0,
      submittedCount: 0,
      sponsorshipFrozen: false,
    });
    expect(await budget.activeSnapshot(alternateExact)).toMatchObject({
      reservedCount: 0,
      submittedCount: 1,
    });
  });

  it("allows only an expired hashless owner lease to be taken over", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput());
    expect(await budget.takeoverHashless(semantic, exact, alternateOwner, 120_000, 120_000)).toEqual({ acquired: false });
    expect(await budget.takeoverHashless(semantic, exact, alternateOwner, 120_001, 120_000)).toEqual({ acquired: true });
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() => instance.markPrepared(semantic, exact, "0xabc", "{}", owner, 120_002)).toThrowError(
        "reservation_owner_mismatch",
      );
      expect(() => instance.release(semantic, exact, owner, 120_002)).toThrowError(
        "reservation_owner_mismatch",
      );
    });
    expect((await budget.markPrepared(semantic, exact, "0xabc", "{}", alternateOwner, 120_003)).outcome).toBe("prepared");
  });

  it("fences prepared rebroadcasts until the live owner lease expires", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput());
    await budget.markPrepared(semantic, exact, "0xabc", "{}", owner, 1);
    expect(await budget.takeoverPrepared(semantic, exact, alternateOwner, 120_000, 120_000)).toEqual({ acquired: false });
    expect(await budget.takeoverPrepared(semantic, exact, alternateOwner, 120_001, 120_000)).toEqual({ acquired: true });
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() => instance.release(semantic, exact, owner, 120_002)).toThrowError(
        "reservation_owner_mismatch",
      );
    });
    expect((await budget.markSubmitted(semantic, exact, "0xabc", 120_003)).outcome).toBe("submitted");
  });

  it("keeps semantic idempotency global while UTC totals roll over", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput(semantic, exact, "100", dayOne));
    await budget.markSubmitted(semantic, exact, "0xabc", 2);
    await budget.finalize(semantic, exact, "0xabc", "70", "succeeded", 3);

    const nextSemantic = "d".repeat(64);
    await budget.reserve(reserveInput(nextSemantic, alternateExact, "60", dayTwo, 4));
    expect((await budget.reserve(reserveInput(semantic, alternateExact, "60", dayTwo, 5))).outcome)
      .toBe("duplicate_committed");
    expect(await budget.snapshot(dayOne)).toMatchObject({
      reservedTodayFri: "0",
      spentTodayFri: "70",
    });
    expect(await budget.snapshot(dayTwo)).toMatchObject({
      reservedTodayFri: "60",
      spentTodayFri: "0",
    });
  });

  it("records the full accepted over-cap spend and freezes new sponsorship", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput());
    await budget.markSubmitted(semantic, exact, "0xabc", 2);
    expect(
      (await budget.finalize(semantic, exact, "0xabc", "140", "succeeded", 3)).outcome,
    ).toBe("breached");
    expect(await budget.lookup(semantic)).toMatchObject({
      outcome: "found",
      state: "breached",
      actualFeeFri: "140",
      sponsorshipFrozen: true,
    });
    expect(await budget.snapshot(dayOne)).toMatchObject({
      reservedTodayFri: "0",
      spentTodayFri: "140",
      breachedCount: 1,
      sponsorshipFrozen: true,
    });
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() =>
        instance.reserve(reserveInput("d".repeat(64), alternateExact, "10")),
      ).toThrowError("sponsorship_frozen");
    });
  });

  it("persists a reverted receipt as terminal and never re-reserves it", async () => {
    const budget = freshBudget();
    await budget.reserve(reserveInput());
    await budget.markSubmitted(semantic, exact, "0xabc", 2);
    expect(
      (await budget.finalize(semantic, exact, "0xabc", "70", "reverted", 3)).outcome,
    ).toBe("reverted");
    expect(await budget.lookup(semantic)).toMatchObject({
      outcome: "found",
      state: "reverted",
      transactionHash: "0xabc",
      actualFeeFri: "70",
    });
    expect((await budget.reserve(reserveInput(semantic, alternateExact, "100", dayTwo))).outcome)
      .toBe("duplicate_reverted");
    expect(await budget.snapshot(dayOne)).toMatchObject({
      reservedTodayFri: "0",
      spentTodayFri: "70",
      revertedCount: 1,
    });
  });
});

function freshBudget() {
  return env.RELAY_BUDGET.getByName(crypto.randomUUID());
}

function reserveInput(
  semanticKey = semantic,
  exactFingerprint = exact,
  maxFeeFri = "100",
  dayKey = dayOne,
  nowMs = 1,
  budgetClass: "control" | "exit" = "control",
) {
  return {
    budgetClass,
    dayKey,
    semanticKey,
    exactFingerprint,
    maxFeeFri,
    perCallCapFri: "200",
    dailyBudgetFri: "1000",
    ownerToken: owner,
    nowMs,
  } as const;
}
