/**
 * Browser-build shim for the evidence-only exit preflight. It exposes only the
 * hash/curve primitives used by the imported client validators, preventing the
 * general Starknet account and transaction APIs from entering that bundle.
 */
import * as starkCurve from "@scure/starknet";

type HashInput = string | number | bigint;

const MASK_250 = (1n << 250n) - 1n;

export const constants = Object.freeze({
  PRIME: 2n ** 251n + 17n * 2n ** 192n + 1n,
  ADDR_BOUND: 2n ** 251n - 256n,
});

export const ec = Object.freeze({ starkCurve });

export const hash = Object.freeze({
  computePedersenHash(left: HashInput, right: HashInput): string {
    return starkCurve.pedersen(BigInt(left), BigInt(right));
  },
  computeHashOnElements(values: readonly HashInput[]): HashInput {
    return String(starkCurve.computeHashOnElements([...values]));
  },
  computePoseidonHashOnElements(values: readonly HashInput[]): string {
    return `0x${starkCurve.poseidonHashMany(values.map((value) => BigInt(value))).toString(16)}`;
  },
  starknetKeccak(value: string): bigint {
    return starkCurve.keccak(new TextEncoder().encode(value)) & MASK_250;
  },
});

export const shortString = Object.freeze({
  encodeShortString(value: string): string {
    if (!/^[\x00-\x7f]*$/.test(value)) throw new Error(`${value} is not an ASCII string`);
    if (value.length > 31) throw new Error(`${value} is too long`);
    return `0x${Array.from(value, (character) =>
      character.charCodeAt(0).toString(16).padStart(2, "0"),
    ).join("")}`;
  },
});
