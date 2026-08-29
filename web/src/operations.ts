import { num } from "starknet";
import {
  OPEN_NOTE_PLACEHOLDER,
  PREPARE_SIGNATURE,
  PrivateAction,
  bindDappSubmittedPreparedExit,
  buildCancelRefundActions,
  buildClaimActions,
  buildFundActions,
  resolveSimulatedPreparedExitNoteId,
  serializeControl,
  type ControlArgs,
} from "../../client/src/actions.ts";
import { LocalStarkKey, BACKUP_CONFIRMATION } from "../../client/src/keys.ts";
import { authorizationHash, type Authorization } from "../../client/src/messages.ts";
import { buildRelayRequest, encodeRelayRequest, RelayOperation } from "../../client/src/relay.ts";
import {
  AMOUNT_FRI,
  AUTH_TTL_SECONDS,
  CHAIN_ID,
  CONTRACT,
  FAST_GRACE_SECONDS,
  FAST_INACTIVITY_SECONDS,
  NORMAL_GRACE_SECONDS,
  NORMAL_INACTIVITY_SECONDS,
  POOL,
  RELAYER_URL,
  STRK,
} from "./config.ts";
import type { RecoveryInvitation, VaultSnapshot } from "./model.ts";
import type { ReadySession } from "./wallet.ts";
import { waitForSuccess } from "./chain.ts";
import { provider } from "./chain.ts";

const CHECKPOINT_SELECTOR = "0x680f3f85ab85ad72c372d5d99610c8c5ffd7ebf3a1f26fbd21fa999346525d";

export function generateKey(): LocalStarkKey {
  return LocalStarkKey.generate();
}

export function restoreKey(serialized: string): LocalStarkKey {
  return LocalStarkKey.restore(serialized);
}

export function exportKey(key: LocalStarkKey): string {
  return key.serializeBackup(BACKUP_CONFIRMATION);
}

export function freshVaultId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  bytes[0] = (bytes[0] ?? 0) & 0x03;
  const value = BigInt(`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  return num.toHex(value === 0n ? 1n : value);
}

function validUntil(): string {
  return String(Math.floor(Date.now() / 1000) + AUTH_TTL_SECONDS);
}

function base(vaultId: string, signerKey: string, state: string, epoch: string, nonce: string, expiry: string) {
  return {
    chain_id: CHAIN_ID,
    contract: CONTRACT,
    vault_id: vaultId,
    token: STRK,
    amount: AMOUNT_FRI,
    expected_state: state,
    epoch,
    nonce,
    signer_key: signerKey,
    note_id: "0",
    valid_until: expiry,
  };
}

async function checkpoint(): Promise<string> {
  const startedBlock = await provider.getBlockNumber();
  const startedAt = Math.floor(Date.now() / 1_000);
  let returnedHash: string | undefined;
  let responseLost = false;
  let responseReceived = false;
  try {
    const response = await fetch(`${RELAYER_URL}/v1/checkpoint`, {
      method: "POST",
      headers: { "x-afterlight-intent": "funding-checkpoint" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    responseReceived = true;
    const body = await response.json() as { status?: string; result?: { status?: string; transactionHash?: string } };
    if (response.ok && body.status === "relayed" && body.result?.transactionHash && ["accepted", "duplicate"].includes(String(body.result.status))) {
      returnedHash = num.toHex(BigInt(body.result.transactionHash));
    } else {
      throw new Error("The neutral funding checkpoint was rejected. No private funds moved.");
    }
  } catch (error) {
    if (responseReceived) {
      throw new Error("The neutral funding checkpoint was rejected. No private funds moved.", { cause: error });
    }
    responseLost = true;
    // A Worker response may be lost after its single broadcast. Reconcile the
    // public, payload-free checkpoint event before declaring the attempt dead.
  }
  if (!returnedHash && !responseLost) {
    throw new Error("The neutral funding checkpoint is unavailable. No private funds moved.");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await provider.getEvents({
      from_block: { block_number: startedBlock },
      to_block: "latest",
      address: CONTRACT,
      keys: [[CHECKPOINT_SELECTOR]],
      chunk_size: 10,
    });
    const event = result.events
      .filter((candidate) => {
        if (!candidate.transaction_hash || candidate.data.length < 3) return false;
        const hash = num.toHex(BigInt(candidate.transaction_hash));
        const syncedAt = Number(BigInt(candidate.data[2] ?? "0"));
        return (!returnedHash || hash === returnedHash) && syncedAt >= startedAt - 30;
      })
      .at(-1);
    if (event?.transaction_hash) {
      const transactionHash = num.toHex(BigInt(event.transaction_hash));
      await waitForSuccess(transactionHash);
      return transactionHash;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("The neutral funding checkpoint is unavailable. No private funds moved.");
}

export async function fundRecoveryReserve(input: {
  ready: ReadySession;
  ownerKey: LocalStarkKey;
  successorKey: string;
  mode: "NORMAL" | "FAST_DEMO";
  onCheckpoint?: (hash: string) => void;
  onSubmitted?: (hash: string) => void;
}): Promise<{ invitation: RecoveryInvitation; transactionHash: string }> {
  const vaultId = freshVaultId();
  const expiry = validUntil();
  const normal = input.mode === "NORMAL";
  const mode = normal ? "0" : "1";
  const inactivitySeconds = normal ? NORMAL_INACTIVITY_SECONDS : FAST_INACTIVITY_SECONDS;
  const graceSeconds = normal ? NORMAL_GRACE_SECONDS : FAST_GRACE_SECONDS;
  const auth: Authorization = {
    operation: "FUND",
    base: base(vaultId, input.ownerKey.publicKey, "0", "0", "0", expiry),
    mode,
    successor_key: input.successorKey,
    inactivity_seconds: inactivitySeconds,
    grace_seconds: graceSeconds,
  };
  const signature = input.ownerKey.sign(authorizationHash(auth));
  const actions = buildFundActions(CONTRACT, {
    vault_id: vaultId,
    token: STRK,
    amount: AMOUNT_FRI,
    mode,
    owner_key: input.ownerKey.publicKey,
    successor_key: input.successorKey,
    inactivity_seconds: inactivitySeconds,
    grace_seconds: graceSeconds,
    valid_until: expiry,
    ...signature,
  });
  const checkpointHash = await checkpoint();
  input.onCheckpoint?.(checkpointHash);
  const transactionHash = await input.ready.invoke(actions);
  input.onSubmitted?.(transactionHash);
  await waitForSuccess(transactionHash);
  return {
    transactionHash,
    invitation: {
      version: 1,
      chain: "SN_MAIN",
      contract: CONTRACT,
      vaultId,
      ownerKey: input.ownerKey.publicKey,
      successorKey: num.toHex(BigInt(input.successorKey)),
      token: "STRK",
      amount: "1",
      mode: input.mode,
      inactivitySeconds,
      graceSeconds,
    },
  };
}

export async function relayControl(operation: "HEARTBEAT" | "REQUEST" | "VETO", invitation: RecoveryInvitation, vault: VaultSnapshot, key: LocalStarkKey): Promise<string> {
  const expiry = validUntil();
  const owner = operation !== "REQUEST";
  const nonce = owner ? vault.ownerNonce : vault.successorNonce;
  const signerKey = owner ? invitation.ownerKey : invitation.successorKey;
  if (num.toHex(BigInt(key.publicKey)) !== num.toHex(BigInt(signerKey))) throw new Error(`This is not the designated ${owner ? "owner" : "successor"} key.`);
  const authBase = base(invitation.vaultId, signerKey, vault.state, vault.epoch, nonce, expiry);
  const auth: Authorization = operation === "HEARTBEAT"
    ? { operation, base: authBase, last_heartbeat: vault.lastHeartbeat }
    : operation === "REQUEST"
      ? { operation, base: authBase, last_heartbeat: vault.lastHeartbeat }
      : { operation, base: authBase, requested_at: vault.requestedAt, claim_after: vault.claimAfter };
  const signature = key.sign(authorizationHash(auth));
  const args: ControlArgs = {
    vault_id: invitation.vaultId,
    token: STRK,
    amount: AMOUNT_FRI,
    expected_state: vault.state,
    expected_epoch: vault.epoch,
    expected_nonce: nonce,
    valid_until: expiry,
    ...signature,
  };
  // Keep this explicit serialization check beside the user action so frontend
  // and Cairo calldata cannot silently drift.
  serializeControl(args);
  const relayOperation = operation === "HEARTBEAT" ? RelayOperation.Heartbeat : operation === "REQUEST" ? RelayOperation.Request : RelayOperation.Veto;
  const payload = encodeRelayRequest(buildRelayRequest(relayOperation, CONTRACT, args));
  const response = await fetch(`${RELAYER_URL}/v1/relay`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-afterlight-intent": "relay-control" },
    body: payload,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const body = await response.json() as { status?: string; result?: { transactionHash?: string } };
  if (!response.ok || body.status !== "relayed" || !body.result?.transactionHash) throw new Error("The neutral relay did not accept this authorization.");
  const transactionHash = num.toHex(BigInt(body.result.transactionHash));
  await waitForSuccess(transactionHash);
  return transactionHash;
}

async function sha256Canonical(value: unknown): Promise<string> {
  const canonical = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (typeof item === "object" && item !== null) return Object.fromEntries(Object.keys(item as object).sort().map((key) => [key, canonical((item as Record<string, unknown>)[key])]));
    throw new Error("Prepared package contains a noncanonical value.");
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256ProofData(base64: string): Promise<string> {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareExitPackage(input: {
  ready: ReadySession;
  invitation: RecoveryInvitation;
  vault: VaultSnapshot;
  roleKey: LocalStarkKey;
  action: "CANCEL_REFUND" | "CLAIM";
}): Promise<Readonly<Record<string, unknown>>> {
  const { ready, invitation, vault, roleKey, action } = input;
  const cancel = action === "CANCEL_REFUND";
  const expectedState = cancel ? "1" : "2";
  const expectedNonce = cancel ? vault.ownerNonce : vault.successorNonce;
  const expectedKey = cancel ? invitation.ownerKey : invitation.successorKey;
  const kind = cancel ? PrivateAction.CancelRefund : PrivateAction.Claim;
  if (!vault.exists || vault.state !== expectedState) throw new Error(cancel ? "Only an ACTIVE reserve can be cancelled." : "The vault is not in GRACE.");
  if (!cancel && Math.floor(Date.now() / 1000) < Number(vault.claimAfter)) throw new Error("The grace period has not finished.");
  if (num.toHex(BigInt(roleKey.publicKey)) !== num.toHex(BigInt(expectedKey))) throw new Error(`This is not the designated ${cancel ? "owner" : "successor"} key.`);
  const expiry = validUntil();
  const sentinelArgs = {
    vault_id: invitation.vaultId, token: STRK, amount: AMOUNT_FRI, expected_state: expectedState,
    expected_epoch: vault.epoch, expected_nonce: expectedNonce, note_id: OPEN_NOTE_PLACEHOLDER,
    valid_until: expiry, ...PREPARE_SIGNATURE,
  };
  const actionBuilder = cancel ? buildCancelRefundActions : buildClaimActions;
  const sentinelActions = actionBuilder(CONTRACT, ready.address, sentinelArgs);
  const sentinelPrepared = await ready.prepare(sentinelActions, true);
  const noteId = resolveSimulatedPreparedExitNoteId(sentinelPrepared, POOL, CONTRACT, kind, sentinelArgs);
  const auth: Authorization = cancel
    ? { operation: "CANCEL_REFUND", base: { ...base(invitation.vaultId, invitation.ownerKey, expectedState, vault.epoch, expectedNonce, expiry), note_id: noteId } }
    : { operation: "CLAIM", base: { ...base(invitation.vaultId, invitation.successorKey, expectedState, vault.epoch, expectedNonce, expiry), note_id: noteId }, requested_at: vault.requestedAt, claim_after: vault.claimAfter };
  const signature = roleKey.sign(authorizationHash(auth));
  const signedArgs = { ...sentinelArgs, ...signature };
  const signedPrepared = await ready.prepare(actionBuilder(CONTRACT, ready.address, signedArgs), false);
  const facts = signedPrepared.proof.proof_facts;
  if (!Array.isArray(facts) || facts.length < 6) throw new Error("Ready returned incomplete proof facts.");
  const proofBlockNumber = BigInt(facts[4]!);
  if (proofBlockNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Proof block is not safely addressable.");
  const proofBlock = await provider.getBlockWithTxHashes(Number(proofBlockNumber));
  if (!("block_hash" in proofBlock) || proofBlock.block_hash === undefined || num.toHex(BigInt(proofBlock.block_hash)) !== num.toHex(BigInt(facts[5]!))) throw new Error("Ready proof facts do not match the canonical Mainnet block.");
  const bound = bindDappSubmittedPreparedExit({
    pool: POOL,
    contract: CONTRACT,
    proofBaseBlock: { number: facts[4]!, hash: facts[5]! },
    kind,
    sentinelArgs,
    sentinelPrepared,
    signedNoteId: noteId,
    signedArgs,
    signedPrepared,
  });
  const preparedAtBlock = String(await provider.getBlockNumber());
  const body: Record<string, unknown> = {
    schema: "afterlight-prepared-neutral-exit/1",
    evidence: "APPLICATION_AUTHORIZED_OUTER_UNSIGNED_NOT_SUBMITTED",
    action,
    chainId: CHAIN_ID,
    neutralAddress: "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46",
    afterlightAddress: CONTRACT,
    poolAddress: POOL,
    tokenAddress: STRK,
    amountFri: AMOUNT_FRI,
    vaultId: invitation.vaultId,
    expectedState,
    expectedEpoch: vault.epoch,
    expectedRoleNonce: expectedNonce,
    destinationNoteId: noteId,
    validUntil: expiry,
    preparedAtBlock,
    prepared: bound.prepared,
  };
  const prepared = bound.prepared as unknown as { call: unknown; proof: { data: string; output: unknown; proof_facts: unknown } };
  const locks = {
    callSha256: await sha256Canonical(prepared.call),
    proofDataSha256: await sha256ProofData(prepared.proof.data),
    proofOutputSha256: await sha256Canonical(prepared.proof.output),
    proofFactsSha256: await sha256Canonical(prepared.proof.proof_facts),
    bindingSha256: await sha256Canonical(body),
  };
  return Object.freeze({ ...body, locks: Object.freeze(locks) });
}

export async function submitExitPackage(
  exitPackage: Readonly<Record<string, unknown>>,
): Promise<{ transactionHash: string; actualFeeFri?: string }> {
  const response = await fetch(`${RELAYER_URL}/v1/exit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-afterlight-intent": "claim-exit",
    },
    body: JSON.stringify(exitPackage),
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const body = await response.json() as {
    status?: string;
    code?: string;
    result?: { transactionHash?: string | null; actualFeeFri?: string };
  };
  if (!response.ok || body.status !== "relayed" || !body.result?.transactionHash) {
    const reason = body.code === "exit_unavailable"
      ? "The neutral private-exit sponsor is temporarily unavailable. No settlement was submitted."
      : body.code === "exit_busy"
        ? "A private exit is already being processed. Refresh the vault before trying again."
      : body.code === "exit_reverted"
          ? "The private exit was refused by the Afterlight contract. Refresh the vault state."
          : body.code === "exit_uncertain"
            ? "The private exit needs receipt reconciliation. Do not retry yet."
            : "The exact-note private exit was rejected. No settlement was submitted.";
    throw new Error(reason);
  }
  return {
    transactionHash: num.toHex(BigInt(body.result.transactionHash)),
    actualFeeFri: body.result.actualFeeFri,
  };
}
