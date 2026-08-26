import type { STRK20_ACTION } from "@starknet-io/types-js";
import { ec } from "starknet";

import {
  buildCancelRefundActions,
  buildClaimActions,
  CANONICAL_STRK20_POOL,
  OPEN_NOTE_PLACEHOLDER,
  PREPARE_SIGNATURE,
  PrivateAction,
  resolveSimulatedPreparedExitNoteId,
  validatePreparedExitProofEnvelope,
  type ExitArgs,
  type PreparedCallAndProof,
} from "./actions.js";
import { address, felt, toBigInt, u64, u128, unixSeconds, type FeltInput } from "./encoding.js";
import type { StarkSignature } from "./keys.js";
import { authorizationHash, type Authorization } from "./messages.js";

export const STARKNET_MAINNET_CHAIN_ID = "0x534e5f4d41494e" as const;
export const PRIVATE_EXIT_EVIDENCE_LEVEL = "E1" as const;
export const MAX_EXIT_AUTH_WINDOW_SECONDS = 900n;

const STATE_ACTIVE = 1n;
const STATE_GRACE = 2n;

export type ExitPreflightMode = "e1-unfunded" | "live-funded";

export type WalletBoundary = Readonly<{
  account: FeltInput;
  chainId: FeltInput;
}>;

/** The only wallet capabilities accepted by the core preflight. */
export type PrepareExitPort = Readonly<{
  /** A direct, silent Wallet API boundary read; never a cached app connection. */
  readBoundary(): Promise<WalletBoundary>;
  prepare(
    actions: readonly STRK20_ACTION[],
    simulate: boolean,
  ): Promise<PreparedCallAndProof>;
}>;

export type AcceptedMainnetBlock = Readonly<{
  chainId: FeltInput;
  number: FeltInput;
  hash: FeltInput;
  status: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
}>;

/** A reader may only retrieve one exact, already-accepted Mainnet block. */
export type ReadMainnetBlockPort = Readonly<{
  providerId: string;
  /** Normalized URL endpoint identity. */
  endpointId: string;
  /** Explicit operator identity recorded in the private configuration. */
  operatorId: string;
  readAcceptedBlock(number: string): Promise<AcceptedMainnetBlock>;
}>;

type ExitPreflightBase = Readonly<{
  mode: ExitPreflightMode;
  expectedReadyAccount: FeltInput;
  openNoteRecipient: FeltInput;
  chainId: FeltInput;
  pool: FeltInput;
  contract: FeltInput;
  vaultId: FeltInput;
  token: FeltInput;
  amount: FeltInput;
  expectedState: FeltInput;
  expectedEpoch: FeltInput;
  expectedNonce: FeltInput;
  rolePublicKey: FeltInput;
  validUntil: FeltInput;
}>;

export type CancelExitPreflightInput = ExitPreflightBase &
  Readonly<{ kind: PrivateAction.CancelRefund }>;

export type ClaimExitPreflightInput = ExitPreflightBase &
  Readonly<{
    kind: PrivateAction.Claim;
    requestedAt: FeltInput;
    claimAfter: FeltInput;
  }>;

export type ExitPreflightInput = CancelExitPreflightInput | ClaimExitPreflightInput;

export type ExitSentinelMetadata = Readonly<{
  evidenceLevel: typeof PRIVATE_EXIT_EVIDENCE_LEVEL;
  operation: "CANCEL_REFUND" | "CLAIM";
  mode: ExitPreflightMode;
  readyAccount: string;
  authorizationHash: string;
  noteIdDigest: string;
  sentinelSimulated: true;
  applicationSignatureVerified: false;
  walletTransactionSigned: false;
  submitted: false;
}>;

export type ExitPreflightMetadata = Readonly<{
  evidence: "AFTERLIGHT_PRIVATE_EXIT_PREFLIGHT_E1";
  evidenceLevel: typeof PRIVATE_EXIT_EVIDENCE_LEVEL;
  operation: "CANCEL_REFUND" | "CLAIM";
  mode: ExitPreflightMode;
  readyAccount: string;
  authorizationHash: string;
  noteIdDigest: string;
  preparedDigest: string;
  proofFactsCount: 9;
  proofBaseBlock: Readonly<{ number: string; hash: string }>;
  rpcProviders: readonly string[];
  rpcOperators: readonly string[];
  applicationSignatureVerified: true;
  walletTransactionSigned: false;
  submitted: false;
  retainedPreparedResponse: false;
}>;

type NormalizedBase = Readonly<{
  mode: ExitPreflightMode;
  expectedReadyAccount: string;
  openNoteRecipient: string;
  chainId: string;
  pool: string;
  contract: string;
  vaultId: string;
  token: string;
  amount: string;
  expectedState: string;
  expectedEpoch: string;
  expectedNonce: string;
  rolePublicKey: string;
  validUntil: string;
}>;

type NormalizedExitInput =
  | (NormalizedBase & Readonly<{ kind: PrivateAction.CancelRefund }>)
  | (NormalizedBase &
      Readonly<{
        kind: PrivateAction.Claim;
        requestedAt: string;
        claimAfter: string;
      }>);

type SentinelState = Readonly<{
  input: NormalizedExitInput;
  boundary: Readonly<{ account: string; chainId: string }>;
  sentinelArgs: ExitArgs;
  sentinelPrepared: PreparedCallAndProof;
  noteId: string;
  noteIdDigest: string;
  authorizationHash: string;
}>;

/**
 * In-memory, evidence-only exit preflight. It deliberately has no transaction
 * signer, account executor, broadcast port, serialization method, or prepared
 * submission getter.
 */
export class PrivateExitPreflight {
  readonly #preparePort: PrepareExitPort;
  readonly #blockReaders: readonly ReadMainnetBlockPort[];
  readonly #nowSeconds: () => bigint;
  #sentinel: SentinelState | undefined;
  #revision = 0;
  #busy = false;

  constructor(
    preparePort: PrepareExitPort,
    blockReaders: readonly ReadMainnetBlockPort[],
    nowSeconds: () => bigint = () => unixSeconds(),
  ) {
    if (blockReaders.length === 0) {
      throw new Error("at least one independent Mainnet block reader is required");
    }
    const providerIds = new Set<string>();
    const endpointIds = new Set<string>();
    const operatorIds = new Set<string>();
    for (const reader of blockReaders) {
      const providerId = reader.providerId.trim();
      const endpointId = reader.endpointId.trim().toLowerCase();
      const operatorId = reader.operatorId.trim().toLowerCase();
      if (!providerId || !endpointId || !operatorId) {
        throw new Error("Mainnet block readers require provider, endpoint, and operator identities");
      }
      if (
        providerIds.has(providerId) ||
        endpointIds.has(endpointId) ||
        operatorIds.has(operatorId)
      ) {
        throw new Error("Mainnet block readers must have distinct endpoint and operator identities");
      }
      providerIds.add(providerId);
      endpointIds.add(endpointId);
      operatorIds.add(operatorId);
    }
    this.#preparePort = preparePort;
    this.#blockReaders = Object.freeze([...blockReaders]);
    this.#nowSeconds = nowSeconds;
  }

  get hasActiveSentinel(): boolean {
    return this.#sentinel !== undefined;
  }

  /** Call for every wallet-standard account or network change notification. */
  invalidateWalletBoundary(): void {
    this.#invalidate();
  }

  /** A changed observed boundary invalidates the sentinel before any final prepare. */
  observeWalletBoundary(boundary: WalletBoundary): boolean {
    if (!this.#sentinel) return true;
    const normalized = normalizeBoundary(boundary);
    if (!sameBoundary(this.#sentinel.boundary, normalized)) {
      this.#invalidate();
      return false;
    }
    return true;
  }

  async prepareSentinel(
    input: ExitPreflightInput,
  ): Promise<ExitSentinelMetadata> {
    this.#assertIdle();
    this.#busy = true;
    this.#invalidate();
    const revision = this.#revision;
    try {
      const normalizedInput = normalizeInput(input);
      assertFreshAuthorization(normalizedInput, this.#nowSeconds());
      this.#assertReaderPolicy(normalizedInput.mode);
      const normalizedBoundary = await this.#readWalletBoundary(revision);
      assertInputBoundary(normalizedInput, normalizedBoundary);

      const sentinelArgs = buildExitArgs(normalizedInput, PREPARE_SIGNATURE);
      const actions = buildExitActions(normalizedInput, sentinelArgs);
      const sentinelPrepared = await this.#preparePort.prepare(actions, true);
      this.#assertRevision(revision);
      await this.#assertWalletBoundary(revision, normalizedBoundary, normalizedInput);
      assertSimulatedProof(sentinelPrepared);

      const noteId = resolveSimulatedPreparedExitNoteId(
        sentinelPrepared,
        normalizedInput.pool,
        normalizedInput.contract,
        normalizedInput.kind,
        sentinelArgs,
      );
      const exactAuthorizationHash = authorizationHash(
        buildAuthorization(normalizedInput, noteId),
      );
      const noteIdDigest = await sha256Digest(felt(noteId, "resolved note id"));
      this.#assertRevision(revision);

      this.#sentinel = Object.freeze({
        input: normalizedInput,
        boundary: normalizedBoundary,
        sentinelArgs,
        sentinelPrepared,
        noteId,
        noteIdDigest,
        authorizationHash: exactAuthorizationHash,
      });
      return Object.freeze({
        evidenceLevel: PRIVATE_EXIT_EVIDENCE_LEVEL,
        operation: operationName(normalizedInput.kind),
        mode: normalizedInput.mode,
        readyAccount: redactAddress(normalizedInput.expectedReadyAccount),
        authorizationHash: exactAuthorizationHash,
        noteIdDigest,
        sentinelSimulated: true,
        applicationSignatureVerified: false,
        walletTransactionSigned: false,
        submitted: false,
      });
    } catch (error) {
      if (this.#revision === revision) this.#invalidate();
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async complete(
    signature: StarkSignature,
  ): Promise<ExitPreflightMetadata> {
    this.#assertIdle();
    const sentinel = this.#sentinel;
    if (!sentinel) throw new Error("no active exit sentinel; prepare a new sentinel first");
    this.#busy = true;
    const revision = this.#revision;
    let finalPrepareStarted = false;
    try {
      assertFreshAuthorization(sentinel.input, this.#nowSeconds());
      await this.#assertWalletBoundary(revision, sentinel.boundary, sentinel.input);
      if (!verifyRoleSignature(sentinel.authorizationHash, sentinel.input.rolePublicKey, signature)) {
        throw new Error("application signature does not verify against the required role key");
      }

      const signedArgs = buildExitArgs(sentinel.input, signature);
      const actions = buildExitActions(sentinel.input, signedArgs);
      finalPrepareStarted = true;
      const signedPrepared = await this.#preparePort.prepare(actions, false);
      this.#assertRevision(revision);
      await this.#assertWalletBoundary(revision, sentinel.boundary, sentinel.input);
      assertFreshAuthorization(sentinel.input, this.#nowSeconds());

      const proofFacts = signedPrepared.proof?.proof_facts;
      if (!Array.isArray(proofFacts) || proofFacts.length !== 9) {
        throw new Error("final STRK20 proof must contain exactly nine canonical proof facts");
      }
      const proofBlockNumber = felt(proofFacts[4]!, "proof base block number");
      const proofBlockHash = felt(proofFacts[5]!, "proof base block hash");
      const blockReads = await Promise.all(
        this.#blockReaders.map((reader) => reader.readAcceptedBlock(proofBlockNumber)),
      );
      this.#assertRevision(revision);
      for (const block of blockReads) {
        assertAcceptedMainnetBlock(block, proofBlockNumber, proofBlockHash);
      }
      await this.#assertWalletBoundary(revision, sentinel.boundary, sentinel.input);
      assertFreshAuthorization(sentinel.input, this.#nowSeconds());
      const acceptedBlock = blockReads[0]!;
      const acceptedBlockNumber = felt(acceptedBlock.number, "accepted RPC block number");
      const acceptedBlockHash = felt(acceptedBlock.hash, "accepted RPC block hash");

      const envelope = validatePreparedExitProofEnvelope({
        pool: sentinel.input.pool,
        contract: sentinel.input.contract,
        proofBaseBlock: { number: acceptedBlockNumber, hash: acceptedBlockHash },
        kind: sentinel.input.kind,
        sentinelArgs: sentinel.sentinelArgs,
        sentinelPrepared: sentinel.sentinelPrepared,
        signedNoteId: sentinel.noteId,
        signedArgs,
        signedPrepared,
      });
      const preparedDigest = await sha256Digest(canonicalPreparedJson(envelope.prepared));
      this.#assertRevision(revision);

      const metadata: ExitPreflightMetadata = Object.freeze({
        evidence: "AFTERLIGHT_PRIVATE_EXIT_PREFLIGHT_E1",
        evidenceLevel: PRIVATE_EXIT_EVIDENCE_LEVEL,
        operation: operationName(sentinel.input.kind),
        mode: sentinel.input.mode,
        readyAccount: redactAddress(sentinel.input.expectedReadyAccount),
        authorizationHash: sentinel.authorizationHash,
        noteIdDigest: sentinel.noteIdDigest,
        preparedDigest,
        proofFactsCount: 9,
        proofBaseBlock: Object.freeze({
          number: acceptedBlockNumber,
          hash: acceptedBlockHash,
        }),
        rpcProviders: Object.freeze(this.#blockReaders.map((reader) => reader.providerId)),
        rpcOperators: Object.freeze(this.#blockReaders.map((reader) => reader.operatorId)),
        applicationSignatureVerified: true,
        walletTransactionSigned: false,
        submitted: false,
        retainedPreparedResponse: false,
      });
      this.#invalidate();
      return metadata;
    } catch (error) {
      if (finalPrepareStarted && this.#revision === revision) this.#invalidate();
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  #assertReaderPolicy(mode: ExitPreflightMode): void {
    if (mode === "live-funded" && this.#blockReaders.length < 2) {
      throw new Error("live/funded preflight requires two declared-independent Mainnet RPC operators");
    }
  }

  async #readWalletBoundary(
    revision: number,
  ): Promise<Readonly<{ account: string; chainId: string }>> {
    const boundary = normalizeBoundary(await this.#preparePort.readBoundary());
    this.#assertRevision(revision);
    return boundary;
  }

  async #assertWalletBoundary(
    revision: number,
    expected: Readonly<{ account: string; chainId: string }>,
    input: NormalizedExitInput,
  ): Promise<void> {
    const observed = await this.#readWalletBoundary(revision);
    if (!sameBoundary(expected, observed)) {
      this.#invalidate();
      throw new Error("Ready account or network changed; the exit sentinel was invalidated");
    }
    assertInputBoundary(input, observed);
  }

  #assertIdle(): void {
    if (this.#busy) throw new Error("another exit preflight operation is still running");
  }

  #assertRevision(expected: number): void {
    if (this.#revision !== expected) {
      throw new Error("Ready account or network changed during exit preparation");
    }
  }

  #invalidate(): void {
    this.#sentinel = undefined;
    this.#revision += 1;
  }
}

function normalizeInput(input: ExitPreflightInput): NormalizedExitInput {
  const mode = input.mode;
  if (mode !== "e1-unfunded" && mode !== "live-funded") {
    throw new Error("unsupported exit preflight mode");
  }
  if (input.kind !== PrivateAction.CancelRefund && input.kind !== PrivateAction.Claim) {
    throw new Error("private exit preflight supports CANCEL_REFUND or CLAIM only");
  }
  const base: NormalizedBase = Object.freeze({
    mode,
    expectedReadyAccount: address(input.expectedReadyAccount, "expected Ready account"),
    openNoteRecipient: address(input.openNoteRecipient, "open-note recipient"),
    chainId: felt(input.chainId, "chain id"),
    pool: address(input.pool, "privacy pool"),
    contract: address(input.contract, "Afterlight contract"),
    vaultId: felt(input.vaultId, "vault id"),
    token: address(input.token, "token"),
    amount: felt(u128(input.amount, "amount")),
    expectedState: felt(input.expectedState, "expected state"),
    expectedEpoch: felt(u64(input.expectedEpoch, "expected epoch")),
    expectedNonce: felt(u64(input.expectedNonce, "expected nonce")),
    rolePublicKey: felt(input.rolePublicKey, "role public key"),
    validUntil: felt(u64(input.validUntil, "valid until")),
  });
  if (base.chainId !== felt(STARKNET_MAINNET_CHAIN_ID)) {
    throw new Error("private exit preflight is locked to Starknet Mainnet");
  }
  if (base.pool !== CANONICAL_STRK20_POOL) {
    throw new Error("private exit preflight is locked to the canonical STRK20 pool");
  }
  if (base.expectedReadyAccount !== base.openNoteRecipient) {
    throw new Error("expected Ready account must equal the open-note recipient");
  }
  if (toBigInt(base.rolePublicKey) === 0n) {
    throw new Error("role public key cannot be zero");
  }
  if (input.kind === PrivateAction.CancelRefund) {
    if (toBigInt(base.expectedState) !== STATE_ACTIVE) {
      throw new Error("CANCEL_REFUND preflight requires expected ACTIVE state");
    }
    if (toBigInt(base.expectedEpoch) === 0n || toBigInt(base.expectedNonce) === 0n) {
      throw new Error("CANCEL_REFUND preflight requires a funded vault epoch and owner nonce");
    }
    return Object.freeze({ ...base, kind: input.kind });
  }
  if (toBigInt(base.expectedState) !== STATE_GRACE) {
    throw new Error("CLAIM preflight requires expected GRACE state");
  }
  if (toBigInt(base.expectedEpoch) === 0n || toBigInt(base.expectedNonce) === 0n) {
    throw new Error("CLAIM preflight requires a requested vault epoch and successor nonce");
  }
  const requestedAt = felt(u64(input.requestedAt, "requested at"));
  const claimAfter = felt(u64(input.claimAfter, "claim after"));
  if (toBigInt(claimAfter) < toBigInt(requestedAt)) {
    throw new Error("claim-after timestamp cannot precede the request timestamp");
  }
  return Object.freeze({ ...base, kind: input.kind, requestedAt, claimAfter });
}

function assertFreshAuthorization(input: NormalizedExitInput, now: bigint): void {
  const normalizedNow = u64(now, "current Unix time");
  const validUntil = u64(input.validUntil, "valid until");
  if (validUntil <= normalizedNow) {
    throw new Error("exit authorization must remain valid after the current second");
  }
  if (validUntil - normalizedNow > MAX_EXIT_AUTH_WINDOW_SECONDS) {
    throw new Error("exit authorization exceeds the locked 900-second deployment window");
  }
}

function normalizeBoundary(boundary: WalletBoundary): Readonly<{ account: string; chainId: string }> {
  return Object.freeze({
    account: address(boundary.account, "observed Ready account"),
    chainId: felt(boundary.chainId, "observed chain id"),
  });
}

function sameBoundary(
  left: Readonly<{ account: string; chainId: string }>,
  right: Readonly<{ account: string; chainId: string }>,
): boolean {
  return left.account === right.account && left.chainId === right.chainId;
}

function assertInputBoundary(
  input: NormalizedExitInput,
  boundary: Readonly<{ account: string; chainId: string }>,
): void {
  if (boundary.account !== input.expectedReadyAccount) {
    throw new Error("connected Ready account is not the expected open-note recipient");
  }
  if (boundary.chainId !== input.chainId || boundary.chainId !== felt(STARKNET_MAINNET_CHAIN_ID)) {
    throw new Error("connected Ready wallet is not on Starknet Mainnet");
  }
}

function buildExitArgs(input: NormalizedExitInput, signature: StarkSignature): ExitArgs {
  return Object.freeze({
    vault_id: input.vaultId,
    token: input.token,
    amount: input.amount,
    expected_state: input.expectedState,
    expected_epoch: input.expectedEpoch,
    expected_nonce: input.expectedNonce,
    note_id: OPEN_NOTE_PLACEHOLDER,
    valid_until: input.validUntil,
    sig_r: felt(signature.sig_r, "signature r"),
    sig_s: felt(signature.sig_s, "signature s"),
  });
}

function buildExitActions(
  input: NormalizedExitInput,
  args: ExitArgs,
): readonly STRK20_ACTION[] {
  return input.kind === PrivateAction.CancelRefund
    ? buildCancelRefundActions(input.contract, input.openNoteRecipient, args)
    : buildClaimActions(input.contract, input.openNoteRecipient, args);
}

function buildAuthorization(input: NormalizedExitInput, noteId: string): Authorization {
  const base = Object.freeze({
    chain_id: input.chainId,
    contract: input.contract,
    vault_id: input.vaultId,
    token: input.token,
    amount: input.amount,
    expected_state: input.expectedState,
    epoch: input.expectedEpoch,
    nonce: input.expectedNonce,
    signer_key: input.rolePublicKey,
    note_id: noteId,
    valid_until: input.validUntil,
  });
  return input.kind === PrivateAction.CancelRefund
    ? Object.freeze({ operation: "CANCEL_REFUND", base })
    : Object.freeze({
        operation: "CLAIM",
        base,
        requested_at: input.requestedAt,
        claim_after: input.claimAfter,
      });
}

function assertSimulatedProof(prepared: PreparedCallAndProof): void {
  if (
    prepared.proof?.data !== "" ||
    !Array.isArray(prepared.proof.output) ||
    prepared.proof.output.length !== 0 ||
    !Array.isArray(prepared.proof.proof_facts) ||
    prepared.proof.proof_facts.length !== 0
  ) {
    throw new Error("sentinel prepare did not return an empty simulate=true proof");
  }
}

function assertAcceptedMainnetBlock(
  block: AcceptedMainnetBlock,
  expectedNumber: string,
  expectedHash: string,
): void {
  if (felt(block.chainId, "RPC chain id") !== felt(STARKNET_MAINNET_CHAIN_ID)) {
    throw new Error("independent block reader is not connected to Starknet Mainnet");
  }
  if (felt(block.number, "RPC block number") !== expectedNumber) {
    throw new Error("independent RPC returned a different proof base block number");
  }
  if (felt(block.hash, "RPC block hash") !== expectedHash) {
    throw new Error("independent RPC returned a different proof base block hash");
  }
  if (block.status !== "ACCEPTED_ON_L1" && block.status !== "ACCEPTED_ON_L2") {
    throw new Error("proof base block is not accepted on Starknet Mainnet");
  }
}

/** Verify a Cairo x-coordinate by trying both valid compressed-y candidates. */
export function verifyRoleSignature(
  messageHash: FeltInput,
  rolePublicKey: FeltInput,
  signature: StarkSignature,
): boolean {
  try {
    const message = felt(messageHash, "authorization hash");
    const publicX = toBigInt(rolePublicKey, "role public key");
    const r = toBigInt(signature.sig_r, "signature r");
    const s = toBigInt(signature.sig_s, "signature s");
    if (publicX === 0n || r === 0n || s === 0n || (r === 1n && s === 1n)) return false;
    const compact = ec.starkCurve.Signature.fromCompact(
      `${r.toString(16).padStart(64, "0")}${s.toString(16).padStart(64, "0")}`,
    );
    const x = bigintTo32Bytes(publicX);
    for (const parity of [0x02, 0x03] as const) {
      const compressed = new Uint8Array(33);
      compressed[0] = parity;
      compressed.set(x, 1);
      try {
        if (ec.starkCurve.verify(compact, message, compressed)) return true;
      } catch {
        // One or both parity encodings may be invalid for a malformed x-coordinate.
      }
    }
    return false;
  } catch {
    return false;
  }
}

function bigintTo32Bytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function canonicalPreparedJson(prepared: PreparedCallAndProof): string {
  return JSON.stringify({
    call: {
      contractAddress: prepared.call.contractAddress,
      entrypoint: prepared.call.entrypoint,
      calldata: prepared.call.calldata ?? [],
    },
    proof: {
      data: prepared.proof.data,
      output: prepared.proof.output,
      proof_facts: prepared.proof.proof_facts,
    },
  });
}

async function sha256Digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function redactAddress(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function operationName(
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
): "CANCEL_REFUND" | "CLAIM" {
  return kind === PrivateAction.CancelRefund ? "CANCEL_REFUND" : "CLAIM";
}
