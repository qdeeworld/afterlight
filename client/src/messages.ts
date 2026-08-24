import { hash, shortString } from "starknet";

import { felt, toBigInt, u64, u128, type FeltInput } from "./encoding.js";

export const AuthorizationOperation = Object.freeze({
  Fund: "FUND",
  CancelRefund: "CANCEL_REFUND",
  Claim: "CLAIM",
  Heartbeat: "HEARTBEAT",
  Request: "REQUEST",
  Veto: "VETO",
} as const);

export type AuthorizationOperation =
  (typeof AuthorizationOperation)[keyof typeof AuthorizationOperation];

export const OPERATION_TAG = Object.freeze({
  FUND: "AFTERLIGHT_FUND_V1",
  CANCEL_REFUND: "AFTERLIGHT_CANCEL_V1",
  CLAIM: "AFTERLIGHT_CLAIM_V1",
  HEARTBEAT: "AFTERLIGHT_HEARTBEAT_V1",
  REQUEST: "AFTERLIGHT_REQUEST_V1",
  VETO: "AFTERLIGHT_VETO_V1",
} satisfies Record<AuthorizationOperation, string>);

export type AuthorizationBase = Readonly<{
  chain_id: FeltInput;
  contract: FeltInput;
  vault_id: FeltInput;
  token: FeltInput;
  amount: FeltInput;
  expected_state: FeltInput;
  epoch: FeltInput;
  nonce: FeltInput;
  signer_key: FeltInput;
  note_id: FeltInput;
  valid_until: FeltInput;
}>;

export type FundAuthorization = Readonly<{
  operation: "FUND";
  base: AuthorizationBase;
  mode: FeltInput;
  successor_key: FeltInput;
  inactivity_seconds: FeltInput;
  grace_seconds: FeltInput;
}>;

export type CancelAuthorization = Readonly<{
  operation: "CANCEL_REFUND";
  base: AuthorizationBase;
}>;

export type ClaimAuthorization = Readonly<{
  operation: "CLAIM";
  base: AuthorizationBase;
  requested_at: FeltInput;
  claim_after: FeltInput;
}>;

export type HeartbeatAuthorization = Readonly<{
  operation: "HEARTBEAT";
  base: AuthorizationBase;
  last_heartbeat: FeltInput;
}>;

export type RequestAuthorization = Readonly<{
  operation: "REQUEST";
  base: AuthorizationBase;
  last_heartbeat: FeltInput;
}>;

export type VetoAuthorization = Readonly<{
  operation: "VETO";
  base: AuthorizationBase;
  requested_at: FeltInput;
  claim_after: FeltInput;
}>;

export type Authorization =
  | FundAuthorization
  | CancelAuthorization
  | ClaimAuthorization
  | HeartbeatAuthorization
  | RequestAuthorization
  | VetoAuthorization;

/** Exact span consumed by Cairo's poseidon_hash_span. */
export function authorizationElements(auth: Authorization): readonly bigint[] {
  const base = checkedBase(auth.base);
  const elements = [
    BigInt(shortString.encodeShortString(OPERATION_TAG[auth.operation])),
    base.chain_id,
    base.contract,
    base.vault_id,
    base.token,
    base.amount,
    base.expected_state,
    base.epoch,
    base.nonce,
    base.signer_key,
    base.note_id,
    base.valid_until,
  ];

  switch (auth.operation) {
    case "FUND":
      elements.push(
        toBigInt(auth.mode, "mode"),
        toBigInt(auth.successor_key, "successor key"),
        u64(auth.inactivity_seconds, "inactivity seconds"),
        u64(auth.grace_seconds, "grace seconds"),
      );
      break;
    case "HEARTBEAT":
    case "REQUEST":
      elements.push(u64(auth.last_heartbeat, "last heartbeat"));
      break;
    case "VETO":
    case "CLAIM":
      elements.push(
        u64(auth.requested_at, "requested at"),
        u64(auth.claim_after, "claim after"),
      );
      break;
    case "CANCEL_REFUND":
      break;
  }
  return Object.freeze(elements);
}

export function authorizationHash(auth: Authorization): string {
  return felt(
    hash.computePoseidonHashOnElements([...authorizationElements(auth)]),
    "authorization hash",
  );
}

function checkedBase(base: AuthorizationBase): Record<keyof AuthorizationBase, bigint> {
  return {
    chain_id: toBigInt(base.chain_id, "chain id"),
    contract: toBigInt(base.contract, "contract"),
    vault_id: toBigInt(base.vault_id, "vault id"),
    token: toBigInt(base.token, "token"),
    amount: u128(base.amount, "amount"),
    expected_state: toBigInt(base.expected_state, "expected state"),
    epoch: u64(base.epoch, "epoch"),
    nonce: u64(base.nonce, "nonce"),
    signer_key: toBigInt(base.signer_key, "signer key"),
    note_id: toBigInt(base.note_id, "note id"),
    valid_until: u64(base.valid_until, "valid until"),
  };
}
