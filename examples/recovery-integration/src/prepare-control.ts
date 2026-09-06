import {
  authorizationHash,
  type Authorization,
  type LocalStarkKey,
} from "@afterlight/recovery";
import { type FeltInput } from "@afterlight/recovery/encoding";
import {
  buildRelayRequest,
  encodeRelayRequest,
  validateRelayPayload,
  type RelayOperation,
  type RelayPolicy,
} from "@afterlight/recovery/relay";

/** Supply one consistent, accepted contract snapshot in a real integration. */
export type VaultSnapshot = Readonly<{
  chainId: FeltInput;
  contract: FeltInput;
  vaultId: FeltInput;
  token: FeltInput;
  amount: FeltInput;
  state: FeltInput;
  epoch: FeltInput;
  ownerKey: FeltInput;
  successorKey: FeltInput;
  ownerNonce: FeltInput;
  successorNonce: FeltInput;
  lastHeartbeat: FeltInput;
  requestedAt: FeltInput;
  claimAfter: FeltInput;
}>;

/**
 * Build a signed public payload without sending it anywhere.
 * Snapshot authenticity, action eligibility and live service admission are
 * separate integration responsibilities; the deployed contract is authoritative.
 */
export function prepareControl(
  operation: RelayOperation,
  snapshot: VaultSnapshot,
  key: LocalStarkKey,
  nowSeconds: bigint,
) {
  const ownerRole = operation !== "REQUEST";
  const roleKey = ownerRole ? snapshot.ownerKey : snapshot.successorKey;
  if (BigInt(roleKey) !== BigInt(key.publicKey)) {
    throw new Error("application key does not match the selected vault role");
  }

  const base = {
    chain_id: snapshot.chainId,
    contract: snapshot.contract,
    vault_id: snapshot.vaultId,
    token: snapshot.token,
    amount: snapshot.amount,
    expected_state: snapshot.state,
    epoch: snapshot.epoch,
    nonce: ownerRole ? snapshot.ownerNonce : snapshot.successorNonce,
    signer_key: roleKey,
    note_id: 0n,
    valid_until: nowSeconds + 600n,
  };
  const authorization: Authorization = operation === "VETO"
    ? { operation, base, requested_at: snapshot.requestedAt, claim_after: snapshot.claimAfter }
    : { operation, base, last_heartbeat: snapshot.lastHeartbeat };
  const messageHash = authorizationHash(authorization);
  const signature = key.sign(messageHash);
  const request = buildRelayRequest(operation, snapshot.contract, {
    vault_id: base.vault_id,
    token: base.token,
    amount: base.amount,
    expected_state: base.expected_state,
    expected_epoch: base.epoch,
    expected_nonce: base.nonce,
    valid_until: base.valid_until,
    ...signature,
  });
  const policy: RelayPolicy = {
    now_seconds: nowSeconds,
    contract: snapshot.contract,
    token: snapshot.token,
    amount: snapshot.amount,
  };
  const payload = encodeRelayRequest(request);
  validateRelayPayload(payload, policy);
  return { authorization, messageHash, signature, request, payload, policy };
}
