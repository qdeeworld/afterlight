import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { RelayBudget } from "../src/budget.js";

const dayOne = "2026-08-24";
const dayTwo = "2026-08-25";
const semantic = "a".repeat(64);
const exact = "b".repeat(64);
const alternateExact = "c".repeat(64);

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
    expect((await budget.release(semantic, exact, 2)).outcome).toBe("released");
    expect((await budget.release(semantic, exact, 3)).outcome).toBe("already_released");

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
      expect(() => instance.release(semantic, alternateExact, 6)).toThrowError(
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

  it("enforces per-call and daily exposure inside the atomic reservation", async () => {
    const budget = freshBudget();
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() =>
        instance.reserve({ ...reserveInput("d".repeat(64), exact, "101"), perCallCapFri: "100" }),
      ).toThrowError("per_call_cap");
    });

    await budget.reserve(reserveInput("e".repeat(64), exact, "60"));
    await runInDurableObject(budget, async (instance: RelayBudget) => {
      expect(() =>
        instance.reserve({
          ...reserveInput("f".repeat(64), alternateExact, "50"),
          dailyBudgetFri: "100",
        }),
      ).toThrowError("daily_budget");
    });
    expect(await budget.snapshot(dayOne)).toMatchObject({
      reservedTodayFri: "60",
      spentTodayFri: "0",
    });
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
) {
  return {
    dayKey,
    semanticKey,
    exactFingerprint,
    maxFeeFri,
    perCallCapFri: "200",
    dailyBudgetFri: "1000",
    nowMs,
  } as const;
}
