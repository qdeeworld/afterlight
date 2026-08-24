import {
  HEALTH_PATH,
  CHECKPOINT_INTENT_HEADER,
  CHECKPOINT_PATH,
  RELAY_INTENT_HEADER,
  RELAY_PATH,
  RelayHttpError,
  corsHeaders,
  jsonResponse,
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

export { RelayBudget } from "./budget.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === HEALTH_PATH) {
        return health(env);
      }
      if (request.method === "OPTIONS" && url.pathname === RELAY_PATH) {
        return preflight(request, env);
      }
      if (request.method === "OPTIONS" && url.pathname === CHECKPOINT_PATH) {
        return preflight(request, env);
      }
      if (url.pathname !== RELAY_PATH && url.pathname !== CHECKPOINT_PATH) {
        return jsonResponse({ status: "error", code: "not_found" }, 404);
      }
      if (request.method !== "POST") {
        return jsonResponse({ status: "error", code: "method_not_allowed" }, 405, {
          allow: "POST, OPTIONS",
        });
      }

      let plan: RelayPlan;
      if (url.pathname === CHECKPOINT_PATH) {
        requireCheckpointHeaders(request, env);
        await rateLimitCheckpoint(env);
        plan = await prepareCheckpointPlan(env, Date.now());
      } else {
        requireRelayHeaders(request, env);
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
        );
        return jsonResponse(
          { status: "relayed", result },
          200,
          corsHeaders(env.ALLOWED_ORIGIN),
        );
      }

      return jsonResponse(
        {
          status: "preflight_passed",
          submission: "disabled",
          plan,
        },
        202,
        corsHeaders(env.ALLOWED_ORIGIN),
      );
    } catch (error) {
      const handled =
        error instanceof RelayHttpError
          ? error
          : error instanceof ExecutorError
            ? new RelayHttpError(error.code === "relayer_busy" ? 503 : 502, error.code)
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
        request.headers.get("origin") === env.ALLOWED_ORIGIN
          ? corsHeaders(env.ALLOWED_ORIGIN)
          : undefined,
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function health(env: Env): Promise<Response> {
  const submitDisabled = !isSubmissionEnabled(env.SUBMIT_ENABLED);
  const readiness = executorReadiness(env);
  const balance =
    submitDisabled || !readiness.executable
      ? assessBalanceHealth(undefined, env.MIN_RELAYER_BALANCE_FRI, !submitDisabled)
      : await readBalanceHealth(
          createStarknetRelayAdapter(env),
          env.MIN_RELAYER_BALANCE_FRI,
          true,
        );
  const ready = !submitDisabled && readiness.executable && balance.status === "ok";
  return jsonResponse(
    {
      status: submitDisabled ? "ok" : ready ? "ok" : "degraded",
      service: "afterlight-neutral-relayer",
      schema: "afterlight-relay/1",
      submission: submitDisabled ? "disabled" : "enabled",
      executor: readiness,
      balance,
      privacy: {
        payloadLogging: false,
        appKeysHeld: false,
        walletAddressesRequired: false,
      },
    },
    submitDisabled || ready ? 200 : 503,
  );
}

function isSubmissionEnabled(value: string): boolean {
  return value === "true";
}

function preflight(request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  const intent = request.headers.get("access-control-request-headers")?.toLowerCase() ?? "";
  if (origin !== env.ALLOWED_ORIGIN || !intent.includes("x-afterlight-intent")) {
    throw new RelayHttpError(403, "origin_not_allowed");
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(env.ALLOWED_ORIGIN),
      "cache-control": "no-store",
      "x-afterlight-intent":
        new URL(request.url).pathname === CHECKPOINT_PATH
          ? CHECKPOINT_INTENT_HEADER
          : RELAY_INTENT_HEADER,
    },
  });
}
