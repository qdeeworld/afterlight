export type SponsorshipPolicy = Readonly<{
  perCallCapFri: bigint;
  dailyBudgetFri: bigint;
  feeMarginBps: bigint;
}>;

export type SponsorshipSnapshot = Readonly<{
  spentTodayFri: bigint;
  reservedTodayFri: bigint;
}>;

export type SponsorshipAuthorization = Readonly<{
  quotedFeeFri: bigint;
  transactionMaxFeeFri: bigint;
  projectedDailyExposureFri: bigint;
}>;

export class SponsorshipError extends Error {
  readonly code: "invalid_quote" | "per_call_cap" | "daily_budget";

  constructor(code: SponsorshipError["code"]) {
    super(code);
    this.name = "SponsorshipError";
    this.code = code;
  }
}

/**
 * Deterministic preflight for the exact-quota adapter used by the funded executor.
 * The adapter must atomically reserve transactionMaxFeeFri before signing.
 */
export function authorizeSponsorship(
  quotedFeeFri: bigint,
  snapshot: SponsorshipSnapshot,
  policy: SponsorshipPolicy,
): SponsorshipAuthorization {
  if (
    quotedFeeFri <= 0n ||
    snapshot.spentTodayFri < 0n ||
    snapshot.reservedTodayFri < 0n ||
    policy.perCallCapFri <= 0n ||
    policy.dailyBudgetFri <= 0n ||
    policy.feeMarginBps < 10_000n ||
    policy.feeMarginBps > 12_000n
  ) {
    throw new SponsorshipError("invalid_quote");
  }

  const transactionMaxFeeFri = ceilDiv(quotedFeeFri * policy.feeMarginBps, 10_000n);
  if (transactionMaxFeeFri > policy.perCallCapFri) {
    throw new SponsorshipError("per_call_cap");
  }

  const projectedDailyExposureFri =
    snapshot.spentTodayFri + snapshot.reservedTodayFri + transactionMaxFeeFri;
  if (projectedDailyExposureFri > policy.dailyBudgetFri) {
    throw new SponsorshipError("daily_budget");
  }

  return Object.freeze({ quotedFeeFri, transactionMaxFeeFri, projectedDailyExposureFri });
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
