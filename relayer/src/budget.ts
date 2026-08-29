import { DurableObject } from "cloudflare:workers";

export type ReservationState =
  | "reserved"
  | "submitted"
  | "released"
  | "committed"
  | "reverted"
  | "breached";

export type BudgetReserveInput = Readonly<{
  budgetClass: "control" | "exit";
  dayKey: string;
  semanticKey: string;
  exactFingerprint: string;
  maxFeeFri: string;
  perCallCapFri: string;
  dailyBudgetFri: string;
  nowMs: number;
}>;

export type BudgetReserveResult = Readonly<{
  outcome:
    | "reserved"
    | "duplicate_reserved"
    | "duplicate_submitted"
    | "duplicate_committed"
    | "duplicate_reverted"
    | "duplicate_breached";
  reservedTodayFri: string;
  spentTodayFri: string;
  sponsorshipFrozen: boolean;
}>;

export type BudgetMutationResult = Readonly<{
  outcome:
    | "released"
    | "already_released"
    | "submitted"
    | "already_submitted"
    | "committed"
    | "already_committed"
    | "reverted"
    | "already_reverted"
    | "breached"
    | "already_breached";
  reservedTodayFri: string;
  spentTodayFri: string;
  sponsorshipFrozen: boolean;
}>;

export type BudgetLookupResult = Readonly<
  | { outcome: "missing"; sponsorshipFrozen: boolean }
  | {
      outcome: "found";
      state: ReservationState;
      dayKey: string;
      exactFingerprint: string;
      transactionHash: string | null;
      maxFeeFri: string;
      actualFeeFri: string | null;
      sponsorshipFrozen: boolean;
    }
>;

export type ActiveBudgetLookupResult = Readonly<
  | { outcome: "missing" }
  | {
      outcome: "found";
      semanticKey: string;
      state: "reserved" | "submitted";
      transactionHash: string | null;
    }
>;

export type BudgetSnapshot = Readonly<{
  dayKey: string;
  reservedTodayFri: string;
  spentTodayFri: string;
  reservedCount: number;
  submittedCount: number;
  committedCount: number;
  revertedCount: number;
  breachedCount: number;
  sponsorshipFrozen: boolean;
}>;

export class BudgetError extends Error {
  readonly code:
    | "invalid_budget_input"
    | "daily_budget"
    | "per_call_cap"
    | "relayer_busy"
    | "sponsorship_frozen"
    | "idempotency_conflict"
    | "reservation_missing"
    | "reservation_not_releasable"
    | "reservation_not_submitted"
    | "exact_fingerprint_mismatch";

  constructor(code: BudgetError["code"]) {
    super(code);
    this.name = "BudgetError";
    this.code = code;
  }
}

type ReservationRow = Readonly<{
  semantic_key: string;
  budget_class: "control" | "exit";
  exact_fingerprint: string;
  day_key: string;
  max_fee_fri: string;
  actual_fee_fri: string | null;
  status: "RESERVED" | "SUBMITTED" | "RELEASED" | "COMMITTED" | "REVERTED" | "BREACHED";
  transaction_hash: string | null;
}>;

type TotalsRow = Readonly<{
  reserved_fri: string;
  spent_fri: string;
}>;

/**
 * One instance coordinates the entire deployment. Operation identities remain
 * global across UTC rollover while financial exposure is bucketed by reserve day.
 */
export class RelayBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sponsorship_control (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        frozen INTEGER NOT NULL CHECK (frozen IN (0, 1)),
        frozen_at_ms INTEGER
      );
      INSERT OR IGNORE INTO sponsorship_control (singleton, frozen, frozen_at_ms)
      VALUES (1, 0, NULL);

      CREATE TABLE IF NOT EXISTS daily_totals (
        day_key TEXT PRIMARY KEY,
        reserved_fri TEXT NOT NULL,
        spent_fri TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reservations (
        semantic_key TEXT PRIMARY KEY,
        exact_fingerprint TEXT NOT NULL,
        day_key TEXT NOT NULL,
        max_fee_fri TEXT NOT NULL,
        actual_fee_fri TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('RESERVED', 'SUBMITTED', 'RELEASED', 'COMMITTED', 'REVERTED', 'BREACHED')
        ),
        transaction_hash TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reservations_day_status
      ON reservations (day_key, status);

      CREATE TABLE IF NOT EXISTS class_daily_totals (
        budget_class TEXT NOT NULL CHECK (budget_class IN ('control', 'exit')),
        day_key TEXT NOT NULL,
        reserved_fri TEXT NOT NULL,
        spent_fri TEXT NOT NULL,
        PRIMARY KEY (budget_class, day_key)
      );
    `);
    const reservationColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(reservations)")
      .toArray();
    if (!reservationColumns.some(({ name }) => name === "budget_class")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE reservations ADD COLUMN budget_class TEXT NOT NULL DEFAULT 'control' CHECK (budget_class IN ('control', 'exit'))",
      );
    }
    // The legacy ledger did not identify whether a reservation paid for a
    // control or exit transaction. Preserve its aggregate against both class
    // ceilings until UTC rollover. Double-counting across independent class
    // ceilings is deliberately conservative and prevents an in-place upgrade
    // from resetting either kind of same-day exposure.
    this.migrateLegacyTotals();
  }

  private migrateLegacyTotals(): void {
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO class_daily_totals (budget_class, day_key, reserved_fri, spent_fri)
      SELECT 'control', day_key, reserved_fri, spent_fri FROM daily_totals
      UNION ALL
      SELECT 'exit', day_key, reserved_fri, spent_fri FROM daily_totals
    `);
  }

  lookup(semanticKey: string): BudgetLookupResult {
    const row = this.readReservation(validKey(semanticKey));
    const frozen = this.isFrozen();
    if (row === undefined) return { outcome: "missing", sponsorshipFrozen: frozen };
    return {
      outcome: "found",
      state: externalState(row.status),
      dayKey: row.day_key,
      exactFingerprint: row.exact_fingerprint,
      transactionHash: row.transaction_hash,
      maxFeeFri: row.max_fee_fri,
      actualFeeFri: row.actual_fee_fri,
      sponsorshipFrozen: frozen,
    };
  }

  findActiveByFingerprint(exactFingerprint: string): ActiveBudgetLookupResult {
    const exact = validKey(exactFingerprint);
    const rows = this.ctx.storage.sql
      .exec<ReservationRow>(
        `SELECT semantic_key, budget_class, exact_fingerprint, day_key, max_fee_fri, actual_fee_fri,
                status, transaction_hash
         FROM reservations
         WHERE exact_fingerprint = ? AND status IN ('RESERVED', 'SUBMITTED')`,
        exact,
      )
      .toArray();
    if (rows.length === 0) return { outcome: "missing" };
    if (rows.length !== 1) throw new BudgetError("idempotency_conflict");
    const row = rows[0]!;
    return {
      outcome: "found",
      semanticKey: row.semantic_key,
      state: row.status === "SUBMITTED" ? "submitted" : "reserved",
      transactionHash: row.transaction_hash,
    };
  }

  reserve(input: BudgetReserveInput): BudgetReserveResult {
    const normalized = validateReserveInput(input);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.readReservation(normalized.semanticKey);
      if (existing !== undefined && existing.status !== "RELEASED") {
        return reserveResult(
          duplicateOutcome(existing.status),
          this.readTotals(existing.budget_class, existing.day_key),
          this.isFrozen(),
        );
      }
      if (this.isFrozen()) throw new BudgetError("sponsorship_frozen");
      const active = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM reservations WHERE status IN ('RESERVED', 'SUBMITTED')",
        )
        .one().count;
      // One funded Starknet account has one nonce lane. Serializing sponsored
      // exposure prevents two requests from signing the same pending nonce.
      if (active !== 0) throw new BudgetError("relayer_busy");

      const totals = this.readTotals(normalized.budgetClass, normalized.dayKey);
      const maximum = BigInt(normalized.maxFeeFri);
      if (maximum > BigInt(normalized.perCallCapFri)) throw new BudgetError("per_call_cap");
      const projected = BigInt(totals.reserved_fri) + BigInt(totals.spent_fri) + maximum;
      if (projected > BigInt(normalized.dailyBudgetFri)) throw new BudgetError("daily_budget");

      if (existing === undefined) {
        this.ctx.storage.sql.exec(
          `INSERT INTO reservations
             (semantic_key, budget_class, exact_fingerprint, day_key, max_fee_fri, actual_fee_fri,
              status, transaction_hash, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, NULL, 'RESERVED', NULL, ?)`,
          normalized.semanticKey,
          normalized.budgetClass,
          normalized.exactFingerprint,
          normalized.dayKey,
          normalized.maxFeeFri,
          normalized.nowMs,
        );
      } else {
        this.ctx.storage.sql.exec(
          `UPDATE reservations
           SET budget_class = ?, exact_fingerprint = ?, day_key = ?, max_fee_fri = ?, actual_fee_fri = NULL,
               status = 'RESERVED', transaction_hash = NULL, updated_at_ms = ?
           WHERE semantic_key = ?`,
          normalized.budgetClass,
          normalized.exactFingerprint,
          normalized.dayKey,
          normalized.maxFeeFri,
          normalized.nowMs,
          normalized.semanticKey,
        );
      }
      const next: TotalsRow = {
        reserved_fri: (BigInt(totals.reserved_fri) + maximum).toString(),
        spent_fri: totals.spent_fri,
      };
      this.writeTotals(normalized.budgetClass, normalized.dayKey, next);
      return reserveResult("reserved", next, false);
    });
  }

  markSubmitted(
    semanticKey: string,
    exactFingerprint: string,
    transactionHash: string,
    nowMs: number,
  ): BudgetMutationResult {
    const semantic = validKey(semanticKey);
    const exact = validKey(exactFingerprint);
    const hash = validTransactionHash(transactionHash);
    const timestamp = validTimestamp(nowMs);
    return this.ctx.storage.transactionSync(() => {
      const row = this.requiredReservation(semantic);
      const totals = this.readTotals(row.budget_class, row.day_key);
      if (row.exact_fingerprint !== exact) throw new BudgetError("exact_fingerprint_mismatch");
      if (row.status === "SUBMITTED") {
        if (row.transaction_hash !== hash) throw new BudgetError("idempotency_conflict");
        return mutationResult("already_submitted", totals, this.isFrozen());
      }
      const terminal = terminalMutationOutcome(row.status);
      if (terminal !== undefined) return mutationResult(terminal, totals, this.isFrozen());
      if (row.status !== "RESERVED") throw new BudgetError("reservation_not_submitted");
      this.ctx.storage.sql.exec(
        `UPDATE reservations
         SET status = 'SUBMITTED', transaction_hash = ?, updated_at_ms = ?
         WHERE semantic_key = ?`,
        hash,
        timestamp,
        semantic,
      );
      return mutationResult("submitted", totals, this.isFrozen());
    });
  }

  release(semanticKey: string, exactFingerprint: string, nowMs: number): BudgetMutationResult {
    const semantic = validKey(semanticKey);
    const exact = validKey(exactFingerprint);
    const timestamp = validTimestamp(nowMs);
    return this.ctx.storage.transactionSync(() => {
      const row = this.requiredReservation(semantic);
      const totals = this.readTotals(row.budget_class, row.day_key);
      if (row.exact_fingerprint !== exact) throw new BudgetError("exact_fingerprint_mismatch");
      if (row.status === "RELEASED") return mutationResult("already_released", totals, this.isFrozen());
      const terminal = terminalMutationOutcome(row.status);
      if (terminal !== undefined) return mutationResult(terminal, totals, this.isFrozen());
      if (row.status !== "RESERVED") throw new BudgetError("reservation_not_releasable");

      const next = removeReservation(totals, row.max_fee_fri);
      this.ctx.storage.sql.exec(
        "UPDATE reservations SET status = 'RELEASED', updated_at_ms = ? WHERE semantic_key = ?",
        timestamp,
        semantic,
      );
      this.writeTotals(row.budget_class, row.day_key, next);
      return mutationResult("released", next, this.isFrozen());
    });
  }

  finalize(
    semanticKey: string,
    exactFingerprint: string,
    transactionHash: string,
    actualFeeFri: string,
    execution: "succeeded" | "reverted",
    nowMs: number,
  ): BudgetMutationResult {
    const semantic = validKey(semanticKey);
    const exact = validKey(exactFingerprint);
    const hash = validTransactionHash(transactionHash);
    const actualFee = decimal(actualFeeFri, true);
    const timestamp = validTimestamp(nowMs);
    if (execution !== "succeeded" && execution !== "reverted") {
      throw new BudgetError("invalid_budget_input");
    }
    return this.ctx.storage.transactionSync(() => {
      const row = this.requiredReservation(semantic);
      const totals = this.readTotals(row.budget_class, row.day_key);
      if (row.exact_fingerprint !== exact) throw new BudgetError("exact_fingerprint_mismatch");
      if (row.status === "COMMITTED" || row.status === "REVERTED" || row.status === "BREACHED") {
        if (row.transaction_hash !== hash || row.actual_fee_fri !== actualFee.toString()) {
          throw new BudgetError("idempotency_conflict");
        }
        if (
          (row.status === "COMMITTED" && execution !== "succeeded") ||
          (row.status === "REVERTED" && execution !== "reverted")
        ) {
          throw new BudgetError("idempotency_conflict");
        }
        const terminal = terminalMutationOutcome(row.status);
        if (terminal === undefined) throw new BudgetError("invalid_budget_input");
        return mutationResult(terminal, totals, this.isFrozen());
      }
      if (row.status !== "SUBMITTED" || row.transaction_hash !== hash) {
        throw new BudgetError("reservation_not_submitted");
      }

      const withoutReservation = removeReservation(totals, row.max_fee_fri);
      const next: TotalsRow = {
        reserved_fri: withoutReservation.reserved_fri,
        spent_fri: (BigInt(withoutReservation.spent_fri) + actualFee).toString(),
      };
      const breached = actualFee > BigInt(row.max_fee_fri);
      const terminalStatus = breached ? "BREACHED" : execution === "reverted" ? "REVERTED" : "COMMITTED";
      this.ctx.storage.sql.exec(
        `UPDATE reservations
         SET actual_fee_fri = ?, status = ?, updated_at_ms = ?
         WHERE semantic_key = ?`,
        actualFee.toString(),
        terminalStatus,
        timestamp,
        semantic,
      );
      this.writeTotals(row.budget_class, row.day_key, next);
      if (breached) {
        this.ctx.storage.sql.exec(
          "UPDATE sponsorship_control SET frozen = 1, frozen_at_ms = ? WHERE singleton = 1",
          timestamp,
        );
      }
      return mutationResult(
        breached ? "breached" : execution === "reverted" ? "reverted" : "committed",
        next,
        breached || this.isFrozen(),
      );
    });
  }

  snapshot(dayKey: string, budgetClass: "control" | "exit" = "control"): BudgetSnapshot {
    const day = validDay(dayKey);
    const kind = validBudgetClass(budgetClass);
    const totals = this.readTotals(kind, day);
    const counts = this.ctx.storage.sql
      .exec<{ status: string; count: number }>(
        "SELECT status, COUNT(*) AS count FROM reservations WHERE budget_class = ? AND day_key = ? GROUP BY status",
        kind,
        day,
      )
      .toArray();
    const count = (status: ReservationRow["status"]): number =>
      counts.find((row) => row.status === status)?.count ?? 0;
    return {
      dayKey: day,
      reservedTodayFri: totals.reserved_fri,
      spentTodayFri: totals.spent_fri,
      reservedCount: count("RESERVED"),
      submittedCount: count("SUBMITTED"),
      committedCount: count("COMMITTED"),
      revertedCount: count("REVERTED"),
      breachedCount: count("BREACHED"),
      sponsorshipFrozen: this.isFrozen(),
    };
  }

  private readTotals(budgetClass: "control" | "exit", dayKey: string): TotalsRow {
    return this.ctx.storage.sql
      .exec<TotalsRow>(
        "SELECT reserved_fri, spent_fri FROM class_daily_totals WHERE budget_class = ? AND day_key = ?",
        budgetClass,
        dayKey,
      )
      .toArray()[0] ?? { reserved_fri: "0", spent_fri: "0" };
  }

  private writeTotals(budgetClass: "control" | "exit", dayKey: string, totals: TotalsRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO class_daily_totals (budget_class, day_key, reserved_fri, spent_fri)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(budget_class, day_key) DO UPDATE
       SET reserved_fri = excluded.reserved_fri, spent_fri = excluded.spent_fri`,
      budgetClass,
      dayKey,
      totals.reserved_fri,
      totals.spent_fri,
    );
  }

  private readReservation(semanticKey: string): ReservationRow | undefined {
    return this.ctx.storage.sql
      .exec<ReservationRow>(
        `SELECT semantic_key, budget_class, exact_fingerprint, day_key, max_fee_fri, actual_fee_fri,
                status, transaction_hash
         FROM reservations WHERE semantic_key = ?`,
        semanticKey,
      )
      .toArray()[0];
  }

  private requiredReservation(semanticKey: string): ReservationRow {
    const row = this.readReservation(semanticKey);
    if (row === undefined) throw new BudgetError("reservation_missing");
    return row;
  }

  private isFrozen(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ frozen: number }>(
          "SELECT frozen FROM sponsorship_control WHERE singleton = 1",
        )
        .one().frozen === 1
    );
  }
}

function validateReserveInput(input: BudgetReserveInput): BudgetReserveInput {
  return {
    budgetClass: validBudgetClass(input.budgetClass),
    dayKey: validDay(input.dayKey),
    semanticKey: validKey(input.semanticKey),
    exactFingerprint: validKey(input.exactFingerprint),
    maxFeeFri: decimal(input.maxFeeFri).toString(),
    perCallCapFri: decimal(input.perCallCapFri).toString(),
    dailyBudgetFri: decimal(input.dailyBudgetFri).toString(),
    nowMs: validTimestamp(input.nowMs),
  };
}

function validBudgetClass(value: string): "control" | "exit" {
  if (value !== "control" && value !== "exit") throw new BudgetError("invalid_budget_input");
  return value;
}

function externalState(status: ReservationRow["status"]): ReservationState {
  if (status === "RESERVED") return "reserved";
  if (status === "SUBMITTED") return "submitted";
  if (status === "RELEASED") return "released";
  if (status === "COMMITTED") return "committed";
  if (status === "REVERTED") return "reverted";
  return "breached";
}

function duplicateOutcome(status: Exclude<ReservationRow["status"], "RELEASED">): BudgetReserveResult["outcome"] {
  if (status === "RESERVED") return "duplicate_reserved";
  if (status === "SUBMITTED") return "duplicate_submitted";
  if (status === "COMMITTED") return "duplicate_committed";
  if (status === "REVERTED") return "duplicate_reverted";
  return "duplicate_breached";
}

function terminalMutationOutcome(
  status: ReservationRow["status"],
): BudgetMutationResult["outcome"] | undefined {
  if (status === "COMMITTED") return "already_committed";
  if (status === "REVERTED") return "already_reverted";
  if (status === "BREACHED") return "already_breached";
  return undefined;
}

function removeReservation(totals: TotalsRow, amountFri: string): TotalsRow {
  const next = BigInt(totals.reserved_fri) - BigInt(amountFri);
  if (next < 0n) throw new BudgetError("invalid_budget_input");
  return { reserved_fri: next.toString(), spent_fri: totals.spent_fri };
}

function validDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BudgetError("invalid_budget_input");
  return value;
}

function validKey(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new BudgetError("invalid_budget_input");
  return value;
}

function validTransactionHash(value: string): string {
  if (!/^0x[0-9a-f]{1,64}$/.test(value)) throw new BudgetError("invalid_budget_input");
  return value;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new BudgetError("invalid_budget_input");
  return value;
}

function decimal(value: string, allowZero = false): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new BudgetError("invalid_budget_input");
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) throw new BudgetError("invalid_budget_input");
  return parsed;
}

function reserveResult(
  outcome: BudgetReserveResult["outcome"],
  totals: TotalsRow,
  sponsorshipFrozen: boolean,
): BudgetReserveResult {
  return {
    outcome,
    reservedTodayFri: totals.reserved_fri,
    spentTodayFri: totals.spent_fri,
    sponsorshipFrozen,
  };
}

function mutationResult(
  outcome: BudgetMutationResult["outcome"],
  totals: TotalsRow,
  sponsorshipFrozen: boolean,
): BudgetMutationResult {
  return {
    outcome,
    reservedTodayFri: totals.reserved_fri,
    spentTodayFri: totals.spent_fri,
    sponsorshipFrozen,
  };
}
