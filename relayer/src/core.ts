import {
  MAX_RELAY_PAYLOAD_BYTES,
  MAX_RELAY_TTL_SECONDS,
  serializeControl,
  validateRelayPayload,
  type RelayOperation,
  type RelayRequest,
} from "./schema.js";

export const RELAY_PATH = "/v1/relay";
export const CHECKPOINT_PATH = "/v1/checkpoint";
export const HEALTH_PATH = "/health";
export const RELAY_INTENT_HEADER = "relay-control";
export const CHECKPOINT_INTENT_HEADER = "funding-checkpoint";
export const CHECKPOINT_ADMISSION_HEADER = "x-afterlight-admission";
export type RelayPlanOperation = RelayOperation | "CHECKPOINT";

const EXPECTED_STATE: Readonly<Record<RelayOperation, bigint>> = Object.freeze({
  HEARTBEAT: 1n,
  REQUEST: 1n,
  VETO: 2n,
});

const ENTRYPOINT: Readonly<Record<RelayOperation, string>> = Object.freeze({
  HEARTBEAT: "heartbeat",
  REQUEST: "request_recovery",
  VETO: "veto",
});

export type RelayCall = Readonly<{
  contractAddress: string;
  entrypoint: string;
  calldata: readonly string[];
}>;

export type RelayPlan = Readonly<{
  schema: "afterlight-relay-plan/1";
  operation: RelayPlanOperation;
  chainId: string;
  /** Exact normalized call, including expiry and signature, for adapter reconciliation. */
  fingerprint: string;
  /** Signature/expiry-independent operation identity for deployment-wide idempotency. */
  semanticKey: string;
  call: RelayCall;
  requiresContractSimulation: true;
  contractVerificationAuthoritative: true;
  maxSponsoredFeeFri: string;
  dailySponsorBudgetFri: string;
}>;

export class RelayHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "RelayHttpError";
    this.status = status;
    this.code = code;
  }
}

/** Builds a payload-free checkpoint bound only to a fresh, opaque funding-attempt owner. */
export async function prepareCheckpointPlan(env: Env, nowMs: number, admissionToken: string): Promise<RelayPlan> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RelayHttpError(500, "invalid_checkpoint_time");
  }
  if (!/^[0-9a-f]{64}$/.test(admissionToken)) {
    throw new RelayHttpError(400, "invalid_admission_token");
  }
  const maxSponsoredFeeFri = parsePositiveDecimal(env.MAX_SPONSORED_FEE_FRI, "fee_cap");
  const dailySponsorBudgetFri = parsePositiveDecimal(
    env.DAILY_SPONSOR_BUDGET_FRI,
    "daily_budget",
  );
  if (dailySponsorBudgetFri < maxSponsoredFeeFri) {
    throw new RelayHttpError(503, "invalid_daily_budget");
  }
  const call = Object.freeze({
    contractAddress: normalizedConfiguredAddress(env.AFTERLIGHT_CONTRACT),
    entrypoint: "sync_funding_checkpoint",
    calldata: Object.freeze([]) as readonly string[],
  });
  const fingerprint = await sha256Hex(
    JSON.stringify({ chainId: env.STARKNET_CHAIN_ID, operation: "CHECKPOINT", call, admissionToken }),
  );
  // The opaque owner keeps exact retries idempotent without letting another
  // browser reuse the first caller's checkpoint admission or adding wallet,
  // note, vault, or signature material to the public call.
  const semanticKey = await sha256Hex(
    JSON.stringify({
      chainId: env.STARKNET_CHAIN_ID,
      contract: call.contractAddress,
      operation: "afterlight-checkpoint/1",
      admissionToken,
    }),
  );
  return Object.freeze({
    schema: "afterlight-relay-plan/1",
    operation: "CHECKPOINT",
    chainId: env.STARKNET_CHAIN_ID,
    fingerprint,
    semanticKey,
    call,
    requiresContractSimulation: true,
    contractVerificationAuthoritative: true,
    maxSponsoredFeeFri: maxSponsoredFeeFri.toString(),
    dailySponsorBudgetFri: dailySponsorBudgetFri.toString(),
  });
}

export async function rateLimitCheckpoint(env: Env): Promise<void> {
  const [globalOutcome, checkpointOutcome] = await Promise.all([
    env.RELAY_GLOBAL_LIMITER.limit({ key: "afterlight-relay-global-v1" }),
    env.CHECKPOINT_RATE_LIMITER.limit({ key: "afterlight-checkpoint-global-v1" }),
  ]);
  if (!globalOutcome.success || !checkpointOutcome.success) {
    throw new RelayHttpError(429, "rate_limited");
  }
}

export function parsePositiveDecimal(value: string, label: string, hardMax?: bigint): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new RelayHttpError(503, `invalid_${label}`);
  const parsed = BigInt(value);
  if (hardMax !== undefined && parsed > hardMax) {
    throw new RelayHttpError(503, `invalid_${label}`);
  }
  return parsed;
}

export async function prepareRelayPlan(
  payload: string,
  env: Env,
  nowSeconds: bigint,
): Promise<{ request: RelayRequest; plan: RelayPlan }> {
  const configuredPayloadLimit = parsePositiveDecimal(
    env.MAX_RELAY_PAYLOAD_BYTES,
    "payload_limit",
    BigInt(MAX_RELAY_PAYLOAD_BYTES),
  );
  const configuredTtl = parsePositiveDecimal(
    env.MAX_RELAY_TTL_SECONDS,
    "ttl_limit",
    MAX_RELAY_TTL_SECONDS,
  );
  const maxSponsoredFeeFri = parsePositiveDecimal(env.MAX_SPONSORED_FEE_FRI, "fee_cap");
  const dailySponsorBudgetFri = parsePositiveDecimal(
    env.DAILY_SPONSOR_BUDGET_FRI,
    "daily_budget",
  );
  if (dailySponsorBudgetFri < maxSponsoredFeeFri) {
    throw new RelayHttpError(503, "invalid_daily_budget");
  }

  if (new TextEncoder().encode(payload).byteLength > Number(configuredPayloadLimit)) {
    throw new RelayHttpError(413, "payload_too_large");
  }

  let normalized: RelayRequest;
  try {
    normalized = validateRelayPayload(payload, {
      now_seconds: nowSeconds,
      contract: env.AFTERLIGHT_CONTRACT,
      token: env.STRK_TOKEN,
      amount: env.RESERVE_AMOUNT_FRI,
      max_ttl_seconds: configuredTtl,
    });
  } catch {
    throw new RelayHttpError(422, "invalid_relay_payload");
  }

  if (BigInt(normalized.args.expected_state) !== EXPECTED_STATE[normalized.operation]) {
    throw new RelayHttpError(422, "invalid_expected_state");
  }

  // Exactness and idempotency are deliberately separate. A fresh expiry or a
  // different valid signature must not create a second operation for one nonce.
  const fingerprint = await sha256Hex(
    JSON.stringify({ chainId: env.STARKNET_CHAIN_ID, request: normalized }),
  );
  const semanticKey = await sha256Hex(
    JSON.stringify({
      chainId: env.STARKNET_CHAIN_ID,
      contract: normalized.contract,
      vault: normalized.args.vault_id,
      operation: `${normalized.schema}:${normalized.operation}`,
      expectedState: normalized.args.expected_state,
      expectedEpoch: normalized.args.expected_epoch,
      expectedNonce: normalized.args.expected_nonce,
      token: normalized.args.token,
      amount: normalized.args.amount,
      // Add an exact destination-note field here before relaying an operation
      // whose authorization domain contains one.
    }),
  );
  const plan: RelayPlan = Object.freeze({
    schema: "afterlight-relay-plan/1",
    operation: normalized.operation,
    chainId: env.STARKNET_CHAIN_ID,
    fingerprint,
    semanticKey,
    call: Object.freeze({
      contractAddress: normalized.contract,
      entrypoint: ENTRYPOINT[normalized.operation],
      calldata: Object.freeze(serializeControl(normalized.args)),
    }),
    requiresContractSimulation: true,
    contractVerificationAuthoritative: true,
    maxSponsoredFeeFri: maxSponsoredFeeFri.toString(),
    dailySponsorBudgetFri: dailySponsorBudgetFri.toString(),
  });
  return { request: normalized, plan };
}

export async function rateLimitRelay(request: RelayRequest, env: Env): Promise<void> {
  const keyMaterial = `${request.operation}:${request.args.vault_id}`;
  const vaultKey = await sha256Hex(keyMaterial);
  const [globalOutcome, vaultOutcome] = await Promise.all([
    env.RELAY_GLOBAL_LIMITER.limit({ key: "afterlight-relay-global-v1" }),
    env.RELAY_RATE_LIMITER.limit({ key: vaultKey }),
  ]);
  if (!globalOutcome.success || !vaultOutcome.success) {
    throw new RelayHttpError(429, "rate_limited");
  }
}

export async function readUtf8BodyLimited(request: Request, byteLimit: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > byteLimit) {
      throw new RelayHttpError(413, "payload_too_large");
    }
  }
  if (request.body === null) throw new RelayHttpError(400, "missing_body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > byteLimit) {
        await reader.cancel("payload limit exceeded");
        throw new RelayHttpError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(joined);
  } catch {
    throw new RelayHttpError(400, "invalid_utf8");
  }
}

export function requireRelayHeaders(request: Request, env: Env): void {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) throw new RelayHttpError(403, "origin_not_allowed");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RelayHttpError(415, "content_type_required");
  }
  if (request.headers.get("x-afterlight-intent") !== RELAY_INTENT_HEADER) {
    throw new RelayHttpError(400, "intent_header_required");
  }
}

export async function requireCheckpointHeaders(request: Request, env: Env): Promise<string> {
  if (!isAllowedOrigin(request.headers.get("origin"), env.ALLOWED_ORIGIN)) {
    throw new RelayHttpError(403, "origin_not_allowed");
  }
  if (request.headers.get("x-afterlight-intent") !== CHECKPOINT_INTENT_HEADER) {
    throw new RelayHttpError(400, "intent_header_required");
  }
  const admissionToken = request.headers.get(CHECKPOINT_ADMISSION_HEADER);
  if (admissionToken === null || !/^[0-9a-f]{64}$/.test(admissionToken)) {
    throw new RelayHttpError(400, "invalid_admission_token");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || contentLength !== "0")) {
    throw new RelayHttpError(400, "checkpoint_payload_forbidden");
  }
  if (request.body === null) return admissionToken;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return admissionToken;
      if (value.byteLength > 0) {
        await reader.cancel("checkpoint payload forbidden");
        throw new RelayHttpError(400, "checkpoint_payload_forbidden");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function corsHeaders(origin: string): HeadersInit {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-afterlight-intent, x-afterlight-admission",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function isAllowedOrigin(origin: string | null, configuredOrigins: string): origin is string {
  if (origin === null) return false;
  return configuredOrigins.split(",").some((allowed) => allowed === origin);
}

export function jsonResponse(
  value: Readonly<Record<string, unknown>>,
  status: number,
  headers?: HeadersInit,
): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedConfiguredAddress(value: string): string {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new RelayHttpError(503, "invalid_contract");
  const parsed = BigInt(value);
  if (parsed === 0n) throw new RelayHttpError(503, "invalid_contract");
  return `0x${parsed.toString(16).padStart(64, "0")}`;
}
