import { address, felt, toBigInt, u64, u128, type FeltInput } from "./encoding.js";
import type { ControlArgs } from "./actions.js";

export const RELAY_SCHEMA = "afterlight-relay/1" as const;
export const MAX_RELAY_TTL_SECONDS = 900n;
export const MAX_RELAY_PAYLOAD_BYTES = 2_048;

export const RelayOperation = Object.freeze({
  Heartbeat: "HEARTBEAT",
  Request: "REQUEST",
  Veto: "VETO",
} as const);

export type RelayOperation = (typeof RelayOperation)[keyof typeof RelayOperation];

export type RelayControlArgs = Readonly<{
  vault_id: string;
  token: string;
  amount: string;
  expected_state: string;
  expected_epoch: string;
  expected_nonce: string;
  valid_until: string;
  sig_r: string;
  sig_s: string;
}>;

export type RelayRequest = Readonly<{
  schema: typeof RELAY_SCHEMA;
  operation: RelayOperation;
  contract: string;
  args: RelayControlArgs;
}>;

export type RelayPolicy = Readonly<{
  now_seconds: FeltInput;
  contract: FeltInput;
  token: FeltInput;
  amount: FeltInput;
  max_ttl_seconds?: FeltInput;
}>;

export function buildRelayRequest(
  operation: RelayOperation,
  contract: FeltInput,
  args: ControlArgs,
): RelayRequest {
  if (!Object.values(RelayOperation).includes(operation)) {
    throw new TypeError("unsupported relay operation");
  }
  return deepFreeze({
    schema: RELAY_SCHEMA,
    operation,
    contract: address(contract, "Afterlight contract"),
    args: normalizeControlArgs(args),
  });
}

export function encodeRelayRequest(request: RelayRequest): string {
  const json = JSON.stringify(request);
  if (utf8Bytes(json) > MAX_RELAY_PAYLOAD_BYTES) {
    throw new RangeError("relay request exceeds the payload limit");
  }
  return json;
}

/** Strict preflight for the neutral gas payer. The Cairo contract stays authoritative. */
export function validateRelayPayload(payload: string, policy: RelayPolicy): RelayRequest {
  if (utf8Bytes(payload) > MAX_RELAY_PAYLOAD_BYTES) {
    throw new RangeError("relay request exceeds the payload limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new TypeError("relay payload is not valid JSON");
  }
  if (!isExactRelayRequest(parsed)) throw new TypeError("relay payload does not match schema");

  const normalized = buildRelayRequest(parsed.operation, parsed.contract, parsed.args);
  const now = u64(policy.now_seconds, "policy time");
  const validUntil = u64(normalized.args.valid_until, "valid until");
  const maxTtl = u64(policy.max_ttl_seconds ?? MAX_RELAY_TTL_SECONDS, "maximum relay ttl");
  if (maxTtl === 0n || maxTtl > MAX_RELAY_TTL_SECONDS) {
    throw new RangeError("relay ttl policy exceeds the hard maximum");
  }
  if (validUntil < now) throw new Error("relay authorization expired");
  if (validUntil > now + maxTtl) throw new Error("relay authorization expiry is unbounded");
  if (normalized.contract !== address(policy.contract, "policy contract")) {
    throw new Error("relay contract is not allowlisted");
  }
  if (normalized.args.token !== felt(policy.token, "policy token")) {
    throw new Error("relay token is not allowlisted");
  }
  if (toBigInt(normalized.args.amount, "relay amount") !== u128(policy.amount, "policy amount")) {
    throw new Error("relay amount is not allowlisted");
  }
  return normalized;
}

function normalizeControlArgs(args: ControlArgs): RelayControlArgs {
  return {
    vault_id: felt(args.vault_id, "vault id"),
    token: felt(args.token, "token"),
    amount: felt(u128(args.amount, "amount")),
    expected_state: felt(args.expected_state, "expected state"),
    expected_epoch: felt(u64(args.expected_epoch, "expected epoch")),
    expected_nonce: felt(u64(args.expected_nonce, "expected nonce")),
    valid_until: felt(u64(args.valid_until, "valid until")),
    sig_r: felt(args.sig_r, "signature r"),
    sig_s: felt(args.sig_s, "signature s"),
  };
}

function isExactRelayRequest(value: unknown): value is RelayRequest {
  if (!isExactRecord(value, ["schema", "operation", "contract", "args"])) return false;
  if (value.schema !== RELAY_SCHEMA) return false;
  if (
    typeof value.operation !== "string" ||
    !Object.values(RelayOperation).includes(value.operation as RelayOperation)
  ) {
    return false;
  }
  if (typeof value.contract !== "string") return false;
  if (
    !isExactRecord(value.args, [
      "vault_id",
      "token",
      "amount",
      "expected_state",
      "expected_epoch",
      "expected_nonce",
      "valid_until",
      "sig_r",
      "sig_s",
    ])
  ) {
    return false;
  }
  return Object.values(value.args).every((entry) => typeof entry === "string");
}

function isExactRecord<T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function deepFreeze<T extends object>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
