import {
  HEALTH_PATH,
  CHECKPOINT_INTENT_HEADER,
  CHECKPOINT_PATH,
  RELAY_INTENT_HEADER,
  RELAY_PATH,
  RelayHttpError,
  corsHeaders,
  jsonResponse,
  isAllowedOrigin,
  parsePositiveDecimal,
  prepareCheckpointPlan,
  prepareRelayPlan,
  rateLimitCheckpoint,
  rateLimitRelay,
  readUtf8BodyLimited,
  requireRelayHeaders,
  requireCheckpointHeaders,
  type RelayPlan,
} from "./core.js";
import {
  assessBalanceHealth,
  budgetObjectName,
  createStarknetRelayAdapter,
  executeRelayPlan,
  executorReadiness,
  ExecutorError,
  readBalanceHealth,
  type BudgetCoordinator,
} from "./executor.js";
import { executePreparedExit, ExitExecutorError, readClaimCapacity, validatePreparedExitPayload } from "./exit-executor.js";

export { RelayBudget } from "./budget.js";

const EXIT_PATH = "/v1/exit";
const EXIT_INTENT_HEADER = "claim-exit";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get("origin") ?? "";
    try {
      if (request.method === "GET" && url.pathname === HEALTH_PATH) {
        return health(request, env);
      }
      if (request.method === "OPTIONS" && url.pathname === RELAY_PATH) {
        return preflight(request, env);
      }
      if (request.method === "OPTIONS" && url.pathname === CHECKPOINT_PATH) {
        return preflight(request, env);
      }
      if (request.method === "OPTIONS" && url.pathname === EXIT_PATH) {
        return preflight(request, env);
      }
      if (url.pathname !== RELAY_PATH && url.pathname !== CHECKPOINT_PATH && url.pathname !== EXIT_PATH) {
        return jsonResponse({ status: "error", code: "not_found" }, 404);
      }
      if (request.method !== "POST") {
        return jsonResponse({ status: "error", code: "method_not_allowed" }, 405, {
          allow: "POST, OPTIONS",
        });
      }

      let plan: RelayPlan;
      let estimateOnly = false;
      let beforeExecutionAdmission: ((ignoredActiveFingerprint?: string) => Promise<void>) | undefined;
      if (url.pathname === EXIT_PATH) {
        requireExitHeaders(request, env);
        await rateLimitExitIngress(env);
        const payload = await readUtf8BodyLimited(request, Number(parsePositiveDecimal(env.MAX_EXIT_PAYLOAD_BYTES, "exit_payload_limit", 2_097_152n)));
        const validated = validatePreparedExitPayload(payload);
        const readiness = executorReadiness(env);
        if (!readiness.executable) throw new RelayHttpError(503, "executor_unavailable");
        const budget: BudgetCoordinator = env.RELAY_BUDGET.getByName(budgetObjectName(env));
        const result = await executePreparedExit(payload, env, budget, validated, async () => {
          await rateLimitValidatedExit(env, await exitRateLimitIdentity(validated.action, validated.metadata.vaultId));
        });
        return jsonResponse({ status: "relayed", result }, 200, corsHeaders(requestOrigin));
      } else if (url.pathname === CHECKPOINT_PATH) {
        const admissionToken = await requireCheckpointHeaders(request, env);
        await rateLimitCheckpoint(env);
        plan = await prepareCheckpointPlan(env, Date.now(), admissionToken);
        if (isSubmissionEnabled(env.SUBMIT_ENABLED)) {
          beforeExecutionAdmission = async (ignoredActiveFingerprint) => {
            const budget: BudgetCoordinator = env.RELAY_BUDGET.getByName(budgetObjectName(env));
            requireFundingAdmission(await readClaimCapacity(
              env,
              budget,
              admissionToken,
              ignoredActiveFingerprint,
            ));
            const ttlMs = parsePositiveDecimal(env.FUNDING_ADMISSION_TTL_MS, "funding_admission_ttl", 900_000n);
            if (ttlMs !== 600_000n) throw new RelayHttpError(503, "invalid_funding_admission_ttl");
            const admission = await budget.acquireFundingAdmission(
              Date.now(),
              Number(ttlMs),
              admissionToken,
            );
            if (!admission.acquired) throw new RelayHttpError(503, "funding_unavailable");
          };
        }
      } else {
        requireRelayHeaders(request, env);
        estimateOnly = url.searchParams.get("mode") === "estimate";
        if (url.searchParams.size !== (estimateOnly ? 1 : 0)) {
          throw new RelayHttpError(400, "invalid_query");
        }
        const bodyLimit = Number(
          parsePositiveDecimal(env.MAX_RELAY_PAYLOAD_BYTES, "payload_limit", 2_048n),
        );
        const payload = await readUtf8BodyLimited(request, bodyLimit);
        const prepared = await prepareRelayPlan(
          payload,
          env,
          BigInt(Math.floor(Date.now() / 1_000)),
        );
        plan = prepared.plan;
        await rateLimitRelay(prepared.request, env);
      }

      if (estimateOnly) {
        const readiness = executorReadiness(env);
        if (!readiness.executable) throw new RelayHttpError(503, "executor_unavailable");
        const simulation = await createStarknetRelayAdapter(env).simulateExact(plan);
        if (!simulation.ok) throw new RelayHttpError(422, "estimate_rejected");
        return jsonResponse(
          {
            status: "estimated",
            submission: "not_attempted",
            plan: {
              fingerprint: plan.fingerprint,
              semanticKey: plan.semanticKey,
              call: plan.call,
            },
            estimate: simulation,
          },
          200,
          corsHeaders(requestOrigin),
        );
      }

      if (isSubmissionEnabled(env.SUBMIT_ENABLED)) {
        const readiness = executorReadiness(env);
        if (!readiness.executable) throw new RelayHttpError(503, "executor_unavailable");
        const nowMs = Date.now();
        const budget: BudgetCoordinator = env.RELAY_BUDGET.getByName(
          budgetObjectName(env),
        );
        const result = await executeRelayPlan(
          plan,
          {
            submitEnabled: true,
            perCallCapFri: parsePositiveDecimal(env.MAX_SPONSORED_FEE_FRI, "fee_cap"),
            dailyBudgetFri: parsePositiveDecimal(env.DAILY_SPONSOR_BUDGET_FRI, "daily_budget"),
            feeMarginBps: parsePositiveDecimal(env.SPONSOR_FEE_MARGIN_BPS, "fee_margin", 12_000n),
          },
          createStarknetRelayAdapter(env),
          budget,
          nowMs,
          beforeExecutionAdmission,
        );
        return jsonResponse(
          { status: "relayed", result },
          200,
          corsHeaders(requestOrigin),
        );
      }

      return jsonResponse(
        {
          status: "preflight_passed",
          submission: "disabled",
          plan,
        },
        202,
        corsHeaders(requestOrigin),
      );
    } catch (error) {
      const executorCode = executorErrorCode(error);
      const handled =
        error instanceof RelayHttpError
          ? error
          : error instanceof ExitExecutorError
            ? new RelayHttpError(
                error.code === "invalid_exit"
                  ? 422
                  : error.code === "exit_busy" || error.code === "exit_unavailable"
                    ? 503
                    : 502,
                error.code,
              )
          : executorCode !== undefined
            ? new RelayHttpError(executorCode === "relayer_busy" ? 503 : 502, executorCode)
          : new RelayHttpError(500, "internal_error");
      // Never log payloads, signatures, IPs, vault IDs, wallet addresses, or request headers.
      console.error(
        JSON.stringify({
          event: "relay_request_rejected",
          code: handled.code,
          method: request.method,
          path: url.pathname,
        }),
      );
      return jsonResponse(
        { status: "error", code: handled.code },
        handled.status,
        isAllowedOrigin(request.headers.get("origin"), env.ALLOWED_ORIGIN)
          ? corsHeaders(requestOrigin)
          : undefined,
      );
    }
  },
} satisfies ExportedHandler<Env>;

function executorErrorCode(error: unknown): ExecutorError["code"] | undefined {
  if (error instanceof ExecutorError) return error.code;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  const allowed: readonly ExecutorError["code"][] = [
    "submission_disabled", "simulation_failed", "simulation_mismatch",
    "fee_policy_rejected", "sponsorship_frozen", "sponsorship_invariant_breach",
    "submission_not_started", "submission_uncertain", "submission_mismatch",
    "receipt_unreconciled", "receipt_reverted", "signer_adapter_unavailable",
    "executor_config_incomplete", "relayer_busy",
  ];
  return typeof code === "string" && allowed.includes(code as ExecutorError["code"])
    ? code as ExecutorError["code"]
    : undefined;
}

async function health(request: Request, env: Env): Promise<Response> {
  const submitDisabled = !isSubmissionEnabled(env.SUBMIT_ENABLED);
  const readiness = executorReadiness(env);
  const [balance, claimCapacity] = await Promise.all([
    submitDisabled || !readiness.executable
      ? assessBalanceHealth(undefined, env.MIN_RELAYER_BALANCE_FRI, !submitDisabled)
      : await readBalanceHealth(
          createStarknetRelayAdapter(env),
          env.MIN_RELAYER_BALANCE_FRI,
          true,
        ),
    submitDisabled || !readiness.executable
      ? Promise.resolve({ status: "unknown" as const, reason: "configuration" as const, fundingStatus: "unknown" as const, fundingReason: "configuration" as const })
      : readClaimCapacity(env, env.RELAY_BUDGET.getByName(budgetObjectName(env))),
  ]);
  const ready = !submitDisabled && readiness.executable && balance.status === "ok";
  const origin = request.headers.get("origin");
  return jsonResponse(
    {
      status: submitDisabled ? "ok" : ready ? "ok" : "degraded",
      service: "afterlight-neutral-relayer",
      schema: "afterlight-relay/1",
      submission: submitDisabled ? "disabled" : "enabled",
      executor: readiness,
      balance,
      claimCapacity,
      privacy: {
        payloadLogging: false,
        appKeysHeld: false,
        walletAddressesRequired: false,
      },
    },
    submitDisabled || ready ? 200 : 503,
    isAllowedOrigin(origin, env.ALLOWED_ORIGIN) ? corsHeaders(origin ?? "") : undefined,
  );
}

function isSubmissionEnabled(value: string): boolean {
  return value === "true";
}

export function requireFundingAdmission(capacity: Awaited<ReturnType<typeof readClaimCapacity>>): void {
  if (capacity.fundingStatus !== "ready") {
    throw new RelayHttpError(503, "funding_unavailable");
  }
}

function preflight(request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  const intent = request.headers.get("access-control-request-headers")?.toLowerCase() ?? "";
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGIN) || !intent.includes("x-afterlight-intent")) {
    throw new RelayHttpError(403, "origin_not_allowed");
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "cache-control": "no-store",
      "x-afterlight-intent":
        new URL(request.url).pathname === CHECKPOINT_PATH
          ? CHECKPOINT_INTENT_HEADER
          : new URL(request.url).pathname === EXIT_PATH
            ? EXIT_INTENT_HEADER
            : RELAY_INTENT_HEADER,
    },
  });
}

function requireExitHeaders(request: Request, env: Env): void {
  if (!isAllowedOrigin(request.headers.get("origin"), env.ALLOWED_ORIGIN)) throw new RelayHttpError(403, "origin_not_allowed");
  if (request.headers.get("x-afterlight-intent") !== EXIT_INTENT_HEADER) throw new RelayHttpError(400, "invalid_exit_intent");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new RelayHttpError(415, "invalid_content_type");
}

async function rateLimitExitIngress(env: Env): Promise<void> {
  const outcome = await env.RELAY_GLOBAL_LIMITER.limit({ key: "afterlight-relay-global-v1" });
  if (!outcome.success) throw new RelayHttpError(429, "rate_limited");
}

async function rateLimitValidatedExit(env: Env, bindingSha256: string): Promise<void> {
  const outcome = await env.EXIT_RATE_LIMITER.limit({ key: bindingSha256 });
  if (!outcome.success) throw new RelayHttpError(429, "rate_limited");
}

/** Stable across signatures, proofs, expiries, and destination variants. */
export async function exitRateLimitIdentity(action: string, vaultId: string): Promise<string> {
  if (action !== "CLAIM" && action !== "CANCEL_REFUND") throw new RelayHttpError(422, "invalid_exit");
  const canonicalVault = `0x${BigInt(vaultId).toString(16)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`afterlight-exit-rate-limit-v1:${action}:${canonicalVault}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
