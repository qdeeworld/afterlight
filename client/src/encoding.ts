import { constants } from "starknet";

export type FeltInput = string | bigint;

export const STARK_FIELD_PRIME = constants.PRIME;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

const HEX_FELT = /^0x[0-9a-fA-F]+$/;
const DECIMAL_FELT = /^(0|[1-9][0-9]*)$/;

export function toBigInt(value: FeltInput, label = "felt"): bigint {
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

export function felt(value: FeltInput, label = "felt"): string {
  return `0x${toBigInt(value, label).toString(16)}`;
}

export function address(value: FeltInput, label = "address"): string {
  return `0x${toBigInt(value, label).toString(16).padStart(64, "0")}`;
}

export function u64(value: FeltInput, label: string): bigint {
  const parsed = toBigInt(value, label);
  if (parsed > U64_MAX) throw new RangeError(`${label} exceeds u64`);
  return parsed;
}

export function u128(value: FeltInput, label: string): bigint {
  const parsed = toBigInt(value, label);
  if (parsed > U128_MAX) throw new RangeError(`${label} exceeds u128`);
  return parsed;
}

/** Unix time in whole seconds. Millisecond timestamps never enter signed payloads. */
export function unixSeconds(nowMs = Date.now()): bigint {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError("nowMs must be a non-negative safe integer");
  }
  return BigInt(Math.floor(nowMs / 1_000));
}
