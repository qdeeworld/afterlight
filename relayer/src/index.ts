import {
  HEALTH_PATH,
  RELAY_INTENT_HEADER,
  RELAY_PATH,
  RelayHttpError,
  corsHeaders,
  jsonResponse,
  parsePositiveDecimal,
  prepareRelayPlan,
  rateLimitRelay,
  readUtf8BodyLimited,
  requireRelayHeaders,
} from "./core.js";

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
      if (url.pathname !== RELAY_PATH) {
        return jsonResponse({ status: "error", code: "not_found" }, 404);
      }
      if (request.method !== "POST") {
        return jsonResponse({ status: "error", code: "method_not_allowed" }, 405, {
          allow: "POST, OPTIONS",
        });
      }

      requireRelayHeaders(request, env);
      if (env.SUBMIT_ENABLED !== "false") {
        throw new RelayHttpError(503, "phase_a_submit_must_remain_disabled");
      }
      const bodyLimit = Number(
        parsePositiveDecimal(env.MAX_RELAY_PAYLOAD_BYTES, "payload_limit", 2_048n),
      );
      const payload = await readUtf8BodyLimited(request, bodyLimit);
      const { request: normalized, plan } = await prepareRelayPlan(
        payload,
        env,
        BigInt(Math.floor(Date.now() / 1_000)),
      );
      await rateLimitRelay(normalized, env);

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

function health(env: Env): Response {
  const submitDisabled = env.SUBMIT_ENABLED === "false";
  return jsonResponse(
    {
      status: submitDisabled ? "ok" : "degraded",
      service: "afterlight-neutral-relayer",
      stage: env.DEPLOYMENT_STAGE,
      schema: "afterlight-relay/1",
      chainId: env.STARKNET_CHAIN_ID,
      submission: "disabled",
      contractConfigured:
        env.DEPLOYMENT_STAGE !== "phase-a-local" && !/^0x0*$/i.test(env.AFTERLIGHT_CONTRACT),
      tokenConfigured: !/^0x0*$/i.test(env.STRK_TOKEN),
      limits: {
        maxPayloadBytes: env.MAX_RELAY_PAYLOAD_BYTES,
        maxTtlSeconds: env.MAX_RELAY_TTL_SECONDS,
        maxSponsoredFeeFri: env.MAX_SPONSORED_FEE_FRI,
        dailySponsorBudgetFri: env.DAILY_SPONSOR_BUDGET_FRI,
      },
      privacy: {
        payloadLogging: false,
        appKeysHeld: false,
        walletAddressesRequired: false,
      },
    },
    submitDisabled ? 200 : 503,
  );
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
      "x-afterlight-intent": RELAY_INTENT_HEADER,
    },
  });
}
