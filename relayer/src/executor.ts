import type {
  ActiveBudgetLookupResult,
  ActiveBudgetSnapshot,
  FundingAdmissionResult,
  BudgetMutationResult,
  BudgetReserveInput,
  BudgetReserveResult,
  BudgetSnapshot,
  BudgetLookupResult,
  ReservationState,
} from "./budget.js";
import { BudgetError } from "./budget.js";
import type { RelayPlan } from "./core.js";
import { StarknetV3RelayAdapter } from "./starknet-adapter.js";
import { SponsorshipError, authorizeSponsorship } from "./sponsorship.js";
import { classifyBroadcastFailure } from "./rpc-errors.js";

export type ExactFeeQuote = Readonly<{
  nonce: string;
  resourceBounds: Readonly<{
    l1_gas: Readonly<{ max_amount: string; max_price_per_unit: string }>;
    l1_data_gas: Readonly<{ max_amount: string; max_price_per_unit: string }>;
    l2_gas: Readonly<{ max_amount: string; max_price_per_unit: string }>;
  }>;
}>;

export type SuccessfulExactSimulation = Readonly<{
  ok: true;
  callFingerprint: string;
  quotedFeeFri: string;
  feeQuote: ExactFeeQuote;
}>;

export type ExactSimulation = Readonly<
  | SuccessfulExactSimulation
  | { ok: false }
>;

export type ExactSubmission = Readonly<
  | {
      submitted: true;
      transactionHash: string;
      callFingerprint: string;
      transactionMaxFeeFri: string;
    }
  | { submitted: false }
>;

export type ExactReceipt = Readonly<
  | {
      status: "accepted";
      execution: "succeeded" | "reverted";
      transactionHash: string;
      callFingerprint: string;
      actualFeeFri: string;
    }
  | { status: "pending" | "rejected" }
>;

/** The production signer/RPC implementation is intentionally not present in Phase A. */
export interface StarknetRelayAdapter {
  simulateExact(plan: RelayPlan): Promise<ExactSimulation>;
  signAndSubmitExact(
    plan: RelayPlan,
    simulation: SuccessfulExactSimulation,
    transactionMaxFeeFri: string,
    persistPrepared: (expectedTransactionHash: string, preparedPayload: string) => Promise<void>,
  ): Promise<ExactSubmission>;
  rebroadcastPreparedExact(
    plan: RelayPlan,
    transactionMaxFeeFri: string,
    expectedTransactionHash: string,
    preparedPayload: string,
  ): Promise<void>;
  reconcileReceipt(transactionHash: string, plan: RelayPlan): Promise<ExactReceipt>;
  readRelayerBalance(): Promise<string>;
}

export interface BudgetCoordinator {
  lookup(semanticKey: string): Promise<BudgetLookupResult>;
  findActiveByFingerprint?(exactFingerprint: string): Promise<ActiveBudgetLookupResult>;
  reserve(input: BudgetReserveInput): Promise<BudgetReserveResult>;
  markSubmitted(
    semanticKey: string,
    exactFingerprint: string,
    transactionHash: string,
    nowMs: number,
  ): Promise<BudgetMutationResult>;
  markPrepared(
    semanticKey: string,
    exactFingerprint: string,
    expectedTransactionHash: string,
    preparedPayload: string,
    ownerToken: string,
    nowMs: number,
  ): Promise<BudgetMutationResult>;
  release(
    semanticKey: string,
    exactFingerprint: string,
    ownerToken: string,
    nowMs: number,
  ): Promise<BudgetMutationResult>;
  takeoverHashless(
    semanticKey: string,
    exactFingerprint: string,
    newOwnerToken: string,
    nowMs: number,
    staleAfterMs: number,
  ): Promise<{ acquired: boolean }>;
  takeoverPrepared(
    semanticKey: string,
    exactFingerprint: string,
    newOwnerToken: string,
    nowMs: number,
    staleAfterMs: number,
  ): Promise<{ acquired: boolean }>;
  finalize(
    semanticKey: string,
    exactFingerprint: string,
    transactionHash: string,
    actualFeeFri: string,
    execution: "succeeded" | "reverted",
    nowMs: number,
  ): Promise<BudgetMutationResult>;
  snapshot(dayKey: string, budgetClass?: "control" | "exit"): Promise<BudgetSnapshot>;
  activeSnapshot(ignoredExactFingerprint?: string): Promise<ActiveBudgetSnapshot>;
  acquireFundingAdmission(nowMs: number, ttlMs: number, ownerToken: string): Promise<FundingAdmissionResult>;
  fundingAdmissionSnapshot(nowMs: number, ownerToken?: string): Promise<FundingAdmissionResult>;
  consumeFundingAdmission(nowMs: number): Promise<FundingAdmissionResult>;
}

export type ExecutorPolicy = Readonly<{
  submitEnabled: boolean;
  perCallCapFri: bigint;
  dailyBudgetFri: bigint;
  feeMarginBps: bigint;
}>;

export type ExecutionResult = Readonly<
  | {
      status: "accepted";
      transactionHash: string;
      actualFeeFri: string;
      reservedTodayFri: string;
      spentTodayFri: string;
    }
  | {
      status: "duplicate";
      state: Exclude<ReservationState, "released">;
      transactionHash: string | null;
    }
>;

export class ExecutorError extends Error {
  readonly code:
    | "submission_disabled"
    | "simulation_failed"
    | "simulation_mismatch"
    | "fee_policy_rejected"
    | "sponsorship_frozen"
    | "sponsorship_invariant_breach"
    | "submission_not_started"
    | "submission_uncertain"
    | "submission_mismatch"
    | "receipt_unreconciled"
    | "receipt_reverted"
    | "signer_adapter_unavailable"
    | "executor_config_incomplete"
    | "relayer_busy";

  constructor(code: ExecutorError["code"]) {
    super(code);
    this.name = "ExecutorError";
    this.code = code;
  }
}

export async function executeRelayPlan(
  plan: RelayPlan,
  policy: ExecutorPolicy,
  adapter: StarknetRelayAdapter,
  budget: BudgetCoordinator,
  nowMs: number,
  beforeExecutionAdmission?: (ignoredActiveFingerprint?: string) => Promise<void>,
): Promise<ExecutionResult> {
  if (!policy.submitEnabled) throw new ExecutorError("submission_disabled");
  const dayKey = utcDayKey(nowMs);
  const ownerToken = reservationOwnerToken();
  let adoptedMaxFeeFri: string | null = null;
  const prior = await budget.lookup(plan.semanticKey);
  if (prior.outcome === "found" && prior.state !== "released") {
    if (
      prior.state === "submitted" &&
      prior.transactionHash !== null &&
      prior.exactFingerprint === plan.fingerprint
    ) {
      return reconcileSubmitted(
        prior.transactionHash,
        plan,
        adapter,
        budget,
        nowMs,
      );
    }
    if (
      prior.state === "reserved" &&
      prior.transactionHash !== null &&
      prior.preparedPayload !== null &&
      prior.exactFingerprint === plan.fingerprint
    ) {
      const takeover = await budget.takeoverPrepared(
        plan.semanticKey,
        plan.fingerprint,
        ownerToken,
        nowMs,
        120_000,
      );
      if (!takeover.acquired) return duplicateResult(prior.state, prior.transactionHash);
      return rebroadcastPreparedControl(plan, prior.maxFeeFri, adapter, budget, prior.transactionHash, prior.preparedPayload, nowMs);
    }
    if (
      prior.state === "reserved" &&
      prior.transactionHash === null &&
      prior.preparedPayload === null &&
      prior.exactFingerprint === plan.fingerprint
    ) {
      const takeover = await budget.takeoverHashless(
        plan.semanticKey,
        plan.fingerprint,
        ownerToken,
        nowMs,
        120_000,
      );
      if (!takeover.acquired) return duplicateResult(prior.state, prior.transactionHash);
      adoptedMaxFeeFri = prior.maxFeeFri;
    } else {
      return duplicateResult(prior.state, prior.transactionHash);
    }
  }
  if (prior.sponsorshipFrozen) throw new ExecutorError("sponsorship_frozen");

  // A Worker request can end after broadcast but before receipt reconciliation.
  // Recover the one serialized SUBMITTED exposure by its stable exact call
  // fingerprint before reserving a new time-bucket semantic key.
  const active = adoptedMaxFeeFri === null
    ? await budget.findActiveByFingerprint?.(plan.fingerprint)
    : undefined;
  if (active?.outcome === "found") {
    const activePlan = Object.freeze({ ...plan, semanticKey: active.semanticKey });
    if (active.state === "submitted" && active.transactionHash !== null) {
      return reconcileSubmitted(
        active.transactionHash,
        activePlan,
        adapter,
        budget,
        nowMs,
      );
    }
    if (active.state === "reserved" && active.transactionHash !== null && active.preparedPayload !== null) {
      const takeover = await budget.takeoverPrepared(
        active.semanticKey,
        plan.fingerprint,
        ownerToken,
        nowMs,
        120_000,
      );
      if (!takeover.acquired) return duplicateResult(active.state, active.transactionHash);
      return rebroadcastPreparedControl(
        activePlan,
        active.maxFeeFri,
        adapter,
        budget,
        active.transactionHash,
        active.preparedPayload,
        nowMs,
      );
    }
    if (active.state === "reserved" && active.transactionHash === null && active.preparedPayload === null) {
      const takeover = await budget.takeoverHashless(
        active.semanticKey,
        plan.fingerprint,
        ownerToken,
        nowMs,
        120_000,
      );
      if (!takeover.acquired) return duplicateResult(active.state, active.transactionHash);
      plan = activePlan;
      adoptedMaxFeeFri = active.maxFeeFri;
    } else {
      return duplicateResult(active.state, active.transactionHash);
    }
  }

  // Admission checks that would reject an already-submitted retry belong only
  // on the fresh path, after both semantic and fingerprint reconciliation.
  await beforeExecutionAdmission?.(
    adoptedMaxFeeFri === null ? undefined : plan.fingerprint,
  );

  const simulation = await adapter.simulateExact(plan);
  if (!simulation.ok) throw new ExecutorError("simulation_failed");
  if (simulation.callFingerprint !== plan.fingerprint) {
    throw new ExecutorError("simulation_mismatch");
  }

  let authorization;
  try {
    authorization = authorizeSponsorship(
      strictDecimal(simulation.quotedFeeFri),
      { spentTodayFri: 0n, reservedTodayFri: 0n },
      {
        perCallCapFri: policy.perCallCapFri,
        dailyBudgetFri: policy.dailyBudgetFri,
        feeMarginBps: policy.feeMarginBps,
      },
    );
  } catch (error) {
    if (error instanceof SponsorshipError) throw new ExecutorError("fee_policy_rejected");
    throw error;
  }

  const maxFeeFri = authorization.transactionMaxFeeFri.toString();
  if (adoptedMaxFeeFri !== null && BigInt(maxFeeFri) > BigInt(adoptedMaxFeeFri)) {
    throw new ExecutorError("fee_policy_rejected");
  }
  let reservation: BudgetReserveResult | undefined;
  if (adoptedMaxFeeFri === null) try {
    reservation = await budget.reserve({
      budgetClass: "control",
      dayKey,
      semanticKey: plan.semanticKey,
      exactFingerprint: plan.fingerprint,
      maxFeeFri,
      perCallCapFri: policy.perCallCapFri.toString(),
      dailyBudgetFri: policy.dailyBudgetFri.toString(),
      ownerToken,
      nowMs,
    });
  } catch (error) {
    if (error instanceof BudgetError && error.code === "relayer_busy") {
      throw new ExecutorError("relayer_busy");
    }
    throw error;
  }
  if (reservation !== undefined && reservation.outcome !== "reserved") {
    const raced = await budget.lookup(plan.semanticKey);
    if (raced.outcome === "found" && raced.state !== "released") {
      return duplicateResult(raced.state, raced.transactionHash);
    }
    return duplicateResult(stateFromDuplicate(reservation.outcome), null);
  }

  let submission: ExactSubmission;
  try {
    submission = await adapter.signAndSubmitExact(
      plan,
      simulation,
      maxFeeFri,
      async (expectedTransactionHash, preparedPayload) => {
        const prepared = await budget.markPrepared(
          plan.semanticKey,
          plan.fingerprint,
          expectedTransactionHash,
          preparedPayload,
          ownerToken,
          nowMs,
        );
        if (prepared.outcome !== "prepared" && prepared.outcome !== "already_prepared") {
          throw new ExecutorError("submission_not_started");
        }
      },
    );
  } catch (error) {
    if (classifyBroadcastFailure(error).definitiveReject) {
      try {
        const released = await budget.release(
          plan.semanticKey,
          plan.fingerprint,
          ownerToken,
          nowMs,
        );
        if (released.outcome === "released" || released.outcome === "already_released") {
          throw new ExecutorError("submission_not_started");
        }
      } catch (releaseError) {
        if (releaseError instanceof ExecutorError) throw releaseError;
        // A later owner may have atomically taken over a stale hashless row.
        // Never let the displaced request release or reclassify that row.
        throw new ExecutorError("submission_uncertain");
      }
    }
    // An unexpected transport failure may have occurred after broadcast. Keep
    // the reservation until an operator reconciles the account nonce/receipt.
    throw new ExecutorError("submission_uncertain");
  }
  if (!submission.submitted) {
    await budget.release(plan.semanticKey, plan.fingerprint, ownerToken, nowMs);
    throw new ExecutorError("submission_not_started");
  }
  if (
    submission.callFingerprint !== plan.fingerprint ||
    submission.transactionMaxFeeFri !== maxFeeFri ||
    !isTransactionHash(submission.transactionHash)
  ) {
    // The adapter claims it submitted, so the exposure remains reserved.
    throw new ExecutorError("submission_mismatch");
  }
  const submitted = await budget.markSubmitted(
    plan.semanticKey,
    plan.fingerprint,
    submission.transactionHash,
    nowMs,
  );
  if (submitted.outcome !== "submitted" && submitted.outcome !== "already_submitted") {
    throw new ExecutorError("submission_uncertain");
  }

  return reconcileSubmitted(
    submission.transactionHash,
    plan,
    adapter,
    budget,
    nowMs,
  );
}

export function reservationOwnerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function rebroadcastPreparedControl(
  plan: RelayPlan,
  transactionMaxFeeFri: string,
  adapter: StarknetRelayAdapter,
  budget: BudgetCoordinator,
  expectedTransactionHash: string,
  preparedPayload: string,
  nowMs: number,
): Promise<ExecutionResult> {
  try {
    await adapter.rebroadcastPreparedExact(
      plan,
      transactionMaxFeeFri,
      expectedTransactionHash,
      preparedPayload,
    );
  } catch {
    // The exact stored transaction is idempotent. A duplicate response or a
    // transport loss may mean either broadcast landed, so the receipt remains
    // authoritative and the reservation must stay locked.
  }
  await budget.markSubmitted(
    plan.semanticKey,
    plan.fingerprint,
    expectedTransactionHash,
    nowMs,
  );
  return reconcileSubmitted(expectedTransactionHash, plan, adapter, budget, nowMs);
}

async function reconcileSubmitted(
  transactionHash: string,
  plan: RelayPlan,
  adapter: StarknetRelayAdapter,
  budget: BudgetCoordinator,
  nowMs: number,
): Promise<ExecutionResult> {
  let receipt: ExactReceipt;
  try {
    receipt = await adapter.reconcileReceipt(transactionHash, plan);
  } catch {
    throw new ExecutorError("receipt_unreconciled");
  }
  if (receipt.status !== "accepted") {
    throw new ExecutorError("receipt_unreconciled");
  }
  if (
    receipt.transactionHash !== transactionHash ||
    receipt.callFingerprint !== plan.fingerprint
  ) {
    throw new ExecutorError("receipt_unreconciled");
  }

  let actualFee: bigint;
  try {
    actualFee = strictDecimal(receipt.actualFeeFri, true);
  } catch {
    throw new ExecutorError("receipt_unreconciled");
  }
  const finalized = await budget.finalize(
    plan.semanticKey,
    plan.fingerprint,
    transactionHash,
    actualFee.toString(),
    receipt.execution,
    nowMs,
  );
  if (finalized.outcome === "breached" || finalized.outcome === "already_breached") {
    throw new ExecutorError("sponsorship_invariant_breach");
  }
  if (receipt.execution === "reverted") throw new ExecutorError("receipt_reverted");
  if (finalized.outcome !== "committed" && finalized.outcome !== "already_committed") {
    throw new ExecutorError("receipt_unreconciled");
  }
  return {
    status: "accepted",
    transactionHash,
    actualFeeFri: actualFee.toString(),
    reservedTodayFri: finalized.reservedTodayFri,
    spentTodayFri: finalized.spentTodayFri,
  };
}

export type ExecutorReadiness = Readonly<{
  configurationReady: boolean;
  signerAdapterAvailable: true;
  executable: boolean;
}>;

/** Aggregates readiness without exposing which deployment secret or field is absent. */
export function executorReadiness(env: Env): ExecutorReadiness {
  const configurationReady =
    configuredDeploymentStage(env.DEPLOYMENT_STAGE) &&
    configuredDeploymentId(env.DEPLOYMENT_ID) &&
    /^0x[0-9a-f]{1,64}$/i.test(env.RELAYER_ACCOUNT_ADDRESS) &&
    !/^0x0+$/i.test(env.RELAYER_ACCOUNT_ADDRESS) &&
    ["0", "1"].includes(env.RELAYER_ACCOUNT_CAIRO_VERSION as string) &&
    isProductionRpcUrl(env.STARKNET_RPC_URL) &&
    isConfiguredSecret(env.RELAYER_ACCOUNT_PRIVATE_KEY) &&
    isConfiguredSecret(env.STARKNET_RPC_AUTH_TOKEN);
  return {
    configurationReady,
    signerAdapterAvailable: true,
    executable: configurationReady,
  };
}

export type BalanceHealth = Readonly<{
  status: "disabled" | "unavailable" | "low" | "ok";
  alert: boolean;
}>;

/** Deliberately reports only a threshold state, never an address or exact balance. */
export function assessBalanceHealth(
  balanceFri: string | undefined,
  minimumFri: string,
  submissionEnabled: boolean,
): BalanceHealth {
  if (!submissionEnabled) return { status: "disabled", alert: false };
  if (balanceFri === undefined) return { status: "unavailable", alert: true };
  try {
    const balance = strictDecimal(balanceFri, true);
    const minimum = strictDecimal(minimumFri);
    return balance < minimum ? { status: "low", alert: true } : { status: "ok", alert: false };
  } catch {
    return { status: "unavailable", alert: true };
  }
}

export async function readBalanceHealth(
  adapter: StarknetRelayAdapter,
  minimumFri: string,
  submissionEnabled: boolean,
): Promise<BalanceHealth> {
  if (!submissionEnabled) return assessBalanceHealth(undefined, minimumFri, false);
  try {
    return assessBalanceHealth(await adapter.readRelayerBalance(), minimumFri, true);
  } catch {
    return { status: "unavailable", alert: true };
  }
}

/** Instantiated only after the request path has passed the explicit readiness gate. */
export function createStarknetRelayAdapter(env: Env): StarknetRelayAdapter {
  if (!executorReadiness(env).executable) {
    throw new ExecutorError("executor_config_incomplete");
  }
  return new StarknetV3RelayAdapter(env);
}

export function budgetObjectName(env: Env): string {
  if (!configuredDeploymentId(env.DEPLOYMENT_ID)) {
    throw new ExecutorError("executor_config_incomplete");
  }
  return `afterlight-budget:${env.DEPLOYMENT_ID}`;
}

export function utcDayKey(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new ExecutorError("executor_config_incomplete");
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function strictDecimal(value: string, allowZero = false): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ExecutorError("fee_policy_rejected");
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) throw new ExecutorError("fee_policy_rejected");
  return parsed;
}

function isTransactionHash(value: string): boolean {
  return /^0x[0-9a-f]{1,64}$/.test(value);
}

function isProductionRpcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.hostname.endsWith(".invalid");
  } catch {
    return false;
  }
}

function isConfiguredSecret(value: string | undefined): boolean {
  return typeof value === "string" && value.length >= 16;
}

function configuredDeploymentStage(value: string): boolean {
  return value !== "" && value !== "phase-a-local";
}

function configuredDeploymentId(value: string): boolean {
  return value !== "" && value !== "phase-a-local";
}

function duplicateResult(
  state: Exclude<ReservationState, "released">,
  transactionHash: string | null,
): ExecutionResult {
  return { status: "duplicate", state, transactionHash };
}

function stateFromDuplicate(
  outcome: Exclude<BudgetReserveResult["outcome"], "reserved">,
): Exclude<ReservationState, "released"> {
  if (outcome === "duplicate_reserved") return "reserved";
  if (outcome === "duplicate_submitted") return "submitted";
  if (outcome === "duplicate_committed") return "committed";
  if (outcome === "duplicate_reverted") return "reverted";
  return "breached";
}
