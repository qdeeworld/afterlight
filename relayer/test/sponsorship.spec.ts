import { describe, expect, it } from "vitest";

import {
  SponsorshipError,
  authorizeSponsorship,
  type SponsorshipPolicy,
} from "../src/sponsorship.js";

const policy: SponsorshipPolicy = {
  perCallCapFri: 200_000_000_000_000_000n,
  dailyBudgetFri: 1_000_000_000_000_000_000n,
  feeMarginBps: 11_000n,
};

describe("exact sponsorship preflight", () => {
  it("reserves the transaction maximum, including the bounded fee margin", () => {
    const authorization = authorizeSponsorship(
      100_000_000_000_000_001n,
      { spentTodayFri: 200_000_000_000_000_000n, reservedTodayFri: 50_000_000_000_000_000n },
      policy,
    );
    expect(authorization.transactionMaxFeeFri).toBe(110_000_000_000_000_002n);
    expect(authorization.projectedDailyExposureFri).toBe(360_000_000_000_000_002n);
  });

  it("fails closed above the per-call cap or exact daily budget", () => {
    expect(() =>
      authorizeSponsorship(
        190_000_000_000_000_000n,
        { spentTodayFri: 0n, reservedTodayFri: 0n },
        policy,
      ),
    ).toThrowError(new SponsorshipError("per_call_cap"));

    expect(() =>
      authorizeSponsorship(
        100_000_000_000_000_000n,
        {
          spentTodayFri: 850_000_000_000_000_000n,
          reservedTodayFri: 50_000_000_000_000_000n,
        },
        policy,
      ),
    ).toThrowError(new SponsorshipError("daily_budget"));
  });

  it("rejects invalid quotes, snapshots and fee margins", () => {
    expect(() =>
      authorizeSponsorship(
        0n,
        { spentTodayFri: 0n, reservedTodayFri: 0n },
        policy,
      ),
    ).toThrowError(new SponsorshipError("invalid_quote"));
    expect(() =>
      authorizeSponsorship(
        1n,
        { spentTodayFri: -1n, reservedTodayFri: 0n },
        policy,
      ),
    ).toThrowError(new SponsorshipError("invalid_quote"));
    expect(() =>
      authorizeSponsorship(
        1n,
        { spentTodayFri: 0n, reservedTodayFri: 0n },
        { ...policy, feeMarginBps: 12_001n },
      ),
    ).toThrowError(new SponsorshipError("invalid_quote"));
  });
});
