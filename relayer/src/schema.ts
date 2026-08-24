import type { RelayRequest as ClientRelayRequest } from "../../client/src/relay.js";

export const RELAY_SCHEMA = "afterlight-relay/1" as const;
export const MAX_RELAY_TTL_SECONDS = 900n;
export const MAX_RELAY_PAYLOAD_BYTES = 2_048;

const STARK_FIELD_PRIME =
  3618502788666131106986593281521497120414687020801267626233049502755974024771n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const HEX_FELT = /^0x[0-9a-fA-F]+$/;
const DECIMAL_FELT = /^(0|[1-9][0-9]*)$/;

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
  now_seconds: string | bigint;
  contract: string | bigint;
  token: string | bigint;
  amount: string | bigint;
  max_ttl_seconds: string | bigint;
}>;

type Equivalent<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A compile failure here means the client and relayer request types have drifted. */
export const CLIENT_SCHEMA_TYPE_COMPATIBLE: Equivalent<RelayRequest, ClientRelayRequest> = true;

export function buildRelayRequest(
  operation: RelayOperation,
  contract: string | bigint,
  args: RelayControlArgs,
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

/** Strict gas-payer preflight. Cairo signature and state checks remain authoritative. */
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
  const maxTtl = u64(policy.max_ttl_seconds, "maximum relay ttl");
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

export function serializeControl(args: RelayControlArgs): string[] {
  return [
    felt(args.vault_id, "vault id"),
    felt(args.token, "token"),
    felt(u128(args.amount, "amount")),
    felt(args.expected_state, "expected state"),
    felt(u64(args.expected_epoch, "expected epoch")),
    felt(u64(args.expected_nonce, "expected nonce")),
    felt(u64(args.valid_until, "valid until")),
    felt(args.sig_r, "signature r"),
    felt(args.sig_s, "signature s"),
  ];
}

function normalizeControlArgs(args: RelayControlArgs): RelayControlArgs {
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

function toBigInt(value: string | bigint, label: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (HEX_FELT.test(value) || DECIMAL_FELT.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${label} must be a non-negative hexadecimal or decimal integer`);
  }
  if (parsed < 0n || parsed >= STARK_FIELD_PRIME) {
    throw new RangeError(`${label} is outside the Stark field`);
  }
  return parsed;
}

function felt(value: string | bigint, label = "felt"): string {
  return `0x${toBigInt(value, label).toString(16)}`;
}

function address(value: string | bigint, label: string): string {
  return `0x${toBigInt(value, label).toString(16).padStart(64, "0")}`;
}

function u64(value: string | bigint, label: string): bigint {
  const parsed = toBigInt(value, label);
  if (parsed > U64_MAX) throw new RangeError(`${label} exceeds u64`);
  return parsed;
}

function u128(value: string | bigint, label: string): bigint {
  const parsed = toBigInt(value, label);
  if (parsed > U128_MAX) throw new RangeError(`${label} exceeds u128`);
  return parsed;
}

function deepFreeze<T extends object>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
