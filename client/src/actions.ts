import type { STRK20_ACTION } from "@starknet-io/types-js";
import { constants, ec, hash, shortString, type STRK20_CALL_AND_PROOF } from "starknet";

import { address, felt, toBigInt, u64, u128, type FeltInput } from "./encoding.js";

/** Cairo enum discriminants. Changing this order is a breaking ABI change. */
export enum PrivateAction {
  Fund = 0,
  CancelRefund = 1,
  Claim = 2,
}

export const OPEN_NOTE_PLACEHOLDER = "${openNoteIds[0]}" as const;
export const PREPARE_SIGNATURE = Object.freeze({ sig_r: "0x1", sig_s: "0x1" });

/** Mainnet protocol locks. A pool class change requires a reviewed client release. */
export const CANONICAL_STRK20_POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
export const PINNED_STRK20_POOL_CLASS_HASH =
  "0x067dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d";
/** Empirical Ready X 5.33.9 Mainnet sponsor envelope, independently observed onchain. */
export const LOCKED_READY_SPONSOR_FORWARDER =
  "0x0127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f";
export const LOCKED_READY_SPONSOR_SELECTOR =
  "0x03bd4b5033e788e9cc450fefa99ea20e3bed0fa358c8b280c0488f0c4647472e";

const OPEN_NOTE_PACKED_VALUE = 1n << 128n;
const VIRTUAL_SNOS = toBigInt(shortString.encodeShortString("VIRTUAL_SNOS"));
const VIRTUAL_SNOS0 = toBigInt(shortString.encodeShortString("VIRTUAL_SNOS0"));

/** The wallet API may expose its prepared call in wire or Starknet.js form. */
export type PreparedPoolCall =
  | STRK20_CALL_AND_PROOF["call"]
  | Readonly<{
      contract_address: FeltInput;
      entry_point: string;
      calldata?: readonly FeltInput[];
    }>;

/** The official Starknet.js response from `strk20PrepareInvoke`. */
export type PreparedCallAndProof = STRK20_CALL_AND_PROOF;

export type FundArgs = Readonly<{
  vault_id: FeltInput;
  token: FeltInput;
  amount: FeltInput;
  mode: FeltInput;
  owner_key: FeltInput;
  successor_key: FeltInput;
  inactivity_seconds: FeltInput;
  grace_seconds: FeltInput;
  valid_until: FeltInput;
  sig_r: FeltInput;
  sig_s: FeltInput;
}>;

export type ExitArgs = Readonly<{
  vault_id: FeltInput;
  token: FeltInput;
  amount: FeltInput;
  expected_state: FeltInput;
  expected_epoch: FeltInput;
  expected_nonce: FeltInput;
  note_id: FeltInput | typeof OPEN_NOTE_PLACEHOLDER;
  valid_until: FeltInput;
  sig_r: FeltInput;
  sig_s: FeltInput;
}>;

export type ControlArgs = Readonly<{
  vault_id: FeltInput;
  token: FeltInput;
  amount: FeltInput;
  expected_state: FeltInput;
  expected_epoch: FeltInput;
  expected_nonce: FeltInput;
  valid_until: FeltInput;
  sig_r: FeltInput;
  sig_s: FeltInput;
}>;

export function buildFundActions(contract: FeltInput, args: FundArgs): readonly STRK20_ACTION[] {
  const target = address(contract, "Afterlight contract");
  const token = address(args.token, "token");
  const actions: STRK20_ACTION[] = [
    {
      type: "withdraw",
      token,
      amount: felt(u128(args.amount, "amount")),
      recipient: target,
    },
    {
      type: "invoke",
      contract: target,
      calldata: serializeFund(args),
    },
  ];
  return Object.freeze(actions);
}

export function buildCancelRefundActions(
  contract: FeltInput,
  noteRecipient: FeltInput,
  args: ExitArgs,
): readonly STRK20_ACTION[] {
  return buildExitActions(PrivateAction.CancelRefund, contract, noteRecipient, args);
}

export function buildClaimActions(
  contract: FeltInput,
  noteRecipient: FeltInput,
  args: ExitArgs,
): readonly STRK20_ACTION[] {
  return buildExitActions(PrivateAction.Claim, contract, noteRecipient, args);
}

/**
 * Rebuild a Ready-managed exit after a sentinel prepare has resolved the exact
 * open-note ID and the role key has signed it. Ready still creates the OPEN
 * note, while the helper calldata carries the literal signed destination.
 * Ready's private paymaster appends and sponsors its fee action; the dApp must
 * reconcile that outer envelope and the exact note from the mainnet receipt.
 */
export function buildManagedCancelRefundActions(
  contract: FeltInput,
  noteRecipient: FeltInput,
  args: ExitArgs,
): readonly STRK20_ACTION[] {
  return buildManagedExitActions(PrivateAction.CancelRefund, contract, noteRecipient, args);
}

export function buildManagedClaimActions(
  contract: FeltInput,
  noteRecipient: FeltInput,
  args: ExitArgs,
): readonly STRK20_ACTION[] {
  return buildManagedExitActions(PrivateAction.Claim, contract, noteRecipient, args);
}

export type ManagedReadyExitTransaction = Readonly<{
  transactionHash: FeltInput;
  senderAddress: FeltInput;
  calldata: readonly FeltInput[];
}>;

export type ManagedReadyExitReceipt = Readonly<{
  transactionHash: FeltInput;
  finalityStatus: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  executionStatus: "SUCCEEDED" | "REVERTED";
  poolEventCount: number;
  afterlightEventCount: number;
  openNoteCreatedEventCount: number;
  poolFeeWithdrawalCount: number;
  poolFeeCollectorTransferCount: number;
}>;

export type ManagedReadyExitEvidence = Readonly<{
  transaction: ManagedReadyExitTransaction;
  receipt: ManagedReadyExitReceipt;
  readyAccounts: readonly FeltInput[];
  contract: FeltInput;
  kind: PrivateAction.CancelRefund | PrivateAction.Claim;
  signedArgs: ExitArgs;
  poolFee: FeltInput;
  shieldedBalanceBefore: FeltInput;
  shieldedBalanceAfter: FeltInput;
  lockedLiabilityBefore: FeltInput;
  lockedLiabilityAfter: FeltInput;
}>;

/**
 * Post-receipt kill gate for a Ready-managed exact-note exit. This parses the
 * actual outer transaction independently of the action builder, rejects a
 * Ready account as sender, and reconciles the successful receipt plus value
 * deltas. It is deliberately unusable as pre-sign proof: only an accepted
 * Mainnet receipt can satisfy it.
 */
export function assertManagedReadyExitEvidence(input: ManagedReadyExitEvidence): void {
  const transactionHash = felt(input.transaction.transactionHash, "managed exit transaction hash");
  if (transactionHash === "0x0" || felt(input.receipt.transactionHash, "managed exit receipt hash") !== transactionHash) {
    throw new Error("managed exit transaction and receipt hashes differ");
  }
  if (
    input.receipt.executionStatus !== "SUCCEEDED" ||
    (input.receipt.finalityStatus !== "ACCEPTED_ON_L1" &&
      input.receipt.finalityStatus !== "ACCEPTED_ON_L2")
  ) {
    throw new Error("managed exit receipt is not accepted and succeeded");
  }
  if (
    input.receipt.poolEventCount < 1 ||
    input.receipt.afterlightEventCount !== 1 ||
    input.receipt.openNoteCreatedEventCount !== 1 ||
    input.receipt.poolFeeWithdrawalCount !== 1 ||
    input.receipt.poolFeeCollectorTransferCount !== 1
  ) {
    throw new Error("managed exit receipt does not prove the exact pool/helper/note/fee result");
  }

  const sender = address(input.transaction.senderAddress, "managed exit outer sender");
  if (toBigInt(sender, "managed exit outer sender") === 0n) {
    throw new Error("managed exit outer sender is zero");
  }
  if (input.readyAccounts.some((candidate) => address(candidate, "Ready account") === sender)) {
    throw new Error("managed exit exposed a Ready account as outer sender");
  }

  const poolFee = u128(input.poolFee, "managed exit pool fee");
  const amount = u128(input.signedArgs.amount, "managed exit amount");
  const shieldedBefore = u128(input.shieldedBalanceBefore, "managed exit shielded balance before");
  const shieldedAfter = u128(input.shieldedBalanceAfter, "managed exit shielded balance after");
  const lockedBefore = u128(input.lockedLiabilityBefore, "managed exit liability before");
  const lockedAfter = u128(input.lockedLiabilityAfter, "managed exit liability after");
  if (shieldedBefore + amount !== shieldedAfter + poolFee) {
    throw new Error("managed exit shielded-balance delta is not reserve minus fee");
  }
  if (lockedBefore !== lockedAfter + amount) {
    throw new Error("managed exit liability did not decrease by the exact reserve");
  }

  assertManagedReadyExitRelayEnvelope(
    input.transaction.calldata,
    input.contract,
    input.kind,
    input.signedArgs,
    poolFee,
  );
}

/** Parse the one Afterlight exit in a prepared `pool.apply_actions` call. */
export function resolvePreparedExitNoteId(
  preparedCall: PreparedPoolCall,
  pool: FeltInput,
  contract: FeltInput,
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  args: ExitArgs,
): string {
  return validatePreparedExit(preparedCall, pool, contract, kind, args).noteId;
}

/** Resolve a simulate=true sentinel, whose empty proof may omit the screening suffix. */
export function resolveSimulatedPreparedExitNoteId(
  prepared: PreparedCallAndProof,
  pool: FeltInput,
  contract: FeltInput,
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  args: ExitArgs,
): string {
  assertSimulatedPreparedProof(prepared);
  return validatePreparedExit(
    prepared.call,
    pool,
    contract,
    kind,
    args,
    "simulated-may-omit-screening-suffix",
  ).noteId;
}

function validatePreparedExit(
  preparedCall: PreparedPoolCall,
  pool: FeltInput,
  contract: FeltInput,
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  args: ExitArgs,
  screeningPolicy: "strict-none-suffix" | "simulated-may-omit-screening-suffix" =
    "strict-none-suffix",
): ValidatedPreparedExit {
  if (args.note_id !== OPEN_NOTE_PLACEHOLDER) {
    throw new Error("prepared exit validation requires the open-note placeholder");
  }

  const normalized = normalizePreparedPoolCall(preparedCall);
  const requestedPool = address(pool, "privacy pool");
  if (requestedPool !== CANONICAL_STRK20_POOL) {
    throw new Error("prepared exits require the locked canonical mainnet privacy pool");
  }
  if (normalized.pool !== requestedPool) {
    throw new Error("prepared call targets the wrong privacy pool");
  }
  if (normalized.entrypoint !== "apply_actions") {
    throw new Error("prepared pool call must use apply_actions");
  }

  const parsed = parseServerInvokes(normalized.calldata, screeningPolicy);
  const exactVariants = [0n, 7n, 10n];
  if (
    parsed.actions.length !== exactVariants.length ||
    parsed.actions.some((action, index) => action.variant !== exactVariants[index])
  ) {
    // Report discriminants only: never include calldata, note IDs, or proof material.
    const variants = parsed.actions.slice(0, 24).map((action) => action.variant.toString()).join(", ");
    throw new Error(
      `prepared exit must contain exactly WriteOnce, EmitOpenNoteCreated, Invoke; received ${parsed.actions.length} action(s), types [${variants}${parsed.actions.length > 24 ? ", …" : ""}] (expected [0, 7, 10]). No claim was submitted.`,
    );
  }
  if (parsed.writeOnceActions.length !== 1) {
    throw new Error(`expected one prepared note WriteOnce, found ${parsed.writeOnceActions.length}`);
  }
  if (parsed.openNotes.length !== 1) {
    throw new Error(`expected one prepared open note, found ${parsed.openNotes.length}`);
  }
  if (parsed.invokes.length !== 1) {
    throw new Error(`expected one prepared pool Invoke action, found ${parsed.invokes.length}`);
  }
  if (parsed.actions.at(-1)?.variant !== 10n) {
    throw new Error("prepared Afterlight Invoke must be the final ServerAction");
  }
  const invoke = parsed.invokes[0]!;
  if (invoke.target !== address(contract, "Afterlight contract")) {
    throw new Error("prepared pool Invoke targets the wrong Afterlight contract");
  }

  const expected = serializeExit(kind, args);
  const raw = invoke.calldata;
  if (raw.length !== expected.length) {
    throw new Error("prepared Afterlight exit calldata has the wrong length");
  }
  const known = expected.map((entry, index) =>
    index === 7 ? undefined : toBigInt(entry, `expected calldata[${index}]`),
  );
  for (let index = 0; index < expected.length; index += 1) {
    if (index !== 7 && raw[index] !== known[index]) {
      throw new Error(`prepared Afterlight exit differs at calldata[${index}]`);
    }
  }
  const openNote = parsed.openNotes[0]!;
  if (openNote.actionIndex >= invoke.actionIndex) {
    throw new Error("prepared open note must precede the Afterlight Invoke");
  }
  if (openNote.token !== address(args.token, "open-note token")) {
    throw new Error("prepared open-note token differs from the signed exit token");
  }
  if (openNote.noteId !== felt(raw[7]!, "resolved note id")) {
    throw new Error("prepared open-note ID differs from the signed helper destination");
  }
  const writeOnce = parsed.writeOnceActions[0]!;
  const noteId = toBigInt(openNote.noteId, "prepared open-note ID");
  if (writeOnce.storageAddress !== notesStorageAddress(noteId)) {
    throw new Error("prepared note WriteOnce targets the wrong storage address");
  }
  if (
    writeOnce.value.length !== 2 ||
    writeOnce.value[0] !== OPEN_NOTE_PACKED_VALUE ||
    writeOnce.value[1] !== toBigInt(openNote.token, "prepared open-note token")
  ) {
    throw new Error("prepared note WriteOnce has the wrong open-note value");
  }
  return {
    noteId: felt(noteId, "resolved note id"),
    normalized,
    invoke,
    openNote,
    writeOnce,
    actions: parsed.actions,
    actionsEnd: parsed.actionsEnd,
  };
}

export type PreparedExitProofEnvelope = Readonly<{
  noteId: string;
  prepared: PreparedCallAndProof;
}>;

export type ValidatePreparedExitProofEnvelopeArgs = Readonly<{
  pool: FeltInput;
  contract: FeltInput;
  proofBaseBlock: Readonly<{ number: FeltInput; hash: FeltInput }>;
  kind: PrivateAction.CancelRefund | PrivateAction.Claim;
  sentinelArgs: ExitArgs;
  sentinelPrepared: PreparedCallAndProof;
  signedNoteId: FeltInput;
  signedArgs: ExitArgs;
  signedPrepared: PreparedCallAndProof;
}>;

/**
 * Structurally validate the real prepared proof envelope against the note
 * signed after the sentinel prepare. Both action sets retain
 * OPEN_NOTE_PLACEHOLDER; only the prepared calls contain the concrete note id.
 * Ready recompiles CreateOpenNote with fresh encryption randomness, so the two
 * calls are compared semantically. The caller must prevent any intervening
 * wallet action that could advance the recipient channel's token note index and
 * therefore change the note id. `proofBaseBlock` must come from
 * an independent mainnet RPC lookup of the block identified by the proof facts;
 * copying those two fields out of the proof does not establish canonicality.
 *
 * This validator does not submit or execute anything. Normal Ready
 * `wallet_strk20InvokeTransaction` recompiles a fee-bearing proof from actions
 * and does not consume this prepared response.
 */
export function validatePreparedExitProofEnvelope(
  input: ValidatePreparedExitProofEnvelopeArgs,
): PreparedExitProofEnvelope {
  assertSimulatedPreparedProof(input.sentinelPrepared);
  if (
    toBigInt(input.sentinelArgs.sig_r, "sentinel signature r") !== 1n ||
    toBigInt(input.sentinelArgs.sig_s, "sentinel signature s") !== 1n
  ) {
    throw new Error("initial exit prepare must use the prepare signature sentinel");
  }
  if (
    toBigInt(input.signedArgs.sig_r, "signed signature r") === 1n &&
    toBigInt(input.signedArgs.sig_s, "signed signature s") === 1n
  ) {
    throw new Error("final exit prepare must contain the real application signature");
  }

  const signedNoteId = felt(input.signedNoteId, "signed note id");
  const sentinelExit = validatePreparedExit(
    input.sentinelPrepared.call,
    input.pool,
    input.contract,
    input.kind,
    input.sentinelArgs,
    "simulated-may-omit-screening-suffix",
  );
  if (sentinelExit.noteId !== signedNoteId) {
    throw new Error("sentinel prepared note does not match the signed note");
  }

  const signedExit = validatePreparedExit(
    input.signedPrepared.call,
    input.pool,
    input.contract,
    input.kind,
    input.signedArgs,
  );
  if (signedExit.noteId !== signedNoteId) {
    throw new Error("final prepared note drifted from the signed note");
  }
  assertEquivalentPreparedExitCalls(sentinelExit, signedExit);
  assertOptionalProofOutputMatchesCall(input.sentinelPrepared, sentinelExit);
  assertCompletePreparedProofEnvelope(input.signedPrepared, signedExit, input.proofBaseBlock);
  freezePreparedResponse(input.signedPrepared);

  return Object.freeze({
    noteId: signedNoteId,
    prepared: input.signedPrepared,
  });
}

const exactDappSubmittedPreparedExit = Symbol(
  "exact PrepareInvoke response retained for dApp/paymaster submission",
);

export type DappSubmittedPreparedExit = PreparedExitProofEnvelope &
  Readonly<{
    [exactDappSubmittedPreparedExit]: Readonly<{
      pool: FeltInput;
      contract: FeltInput;
      kind: PrivateAction.CancelRefund | PrivateAction.Claim;
      args: ExitArgs;
    }>;
  }>;

export type BindDappSubmittedPreparedExitArgs = ValidatePreparedExitProofEnvelopeArgs;

/**
 * Retain the exact prepared response only for the alternative route where a
 * dApp/paymaster submits `wallet_strk20PrepareInvoke` output itself. This
 * primitive does not apply to normal Ready `wallet_strk20InvokeTransaction`,
 * which accepts actions and generates a separate fee-bearing proof.
 */
export function bindDappSubmittedPreparedExit(
  input: BindDappSubmittedPreparedExitArgs,
): DappSubmittedPreparedExit {
  const envelope = validatePreparedExitProofEnvelope(input);
  return Object.freeze({
    noteId: envelope.noteId,
    prepared: envelope.prepared,
    [exactDappSubmittedPreparedExit]: Object.freeze({
      pool: input.pool,
      contract: input.contract,
      kind: input.kind,
      args: input.signedArgs,
    }),
  });
}

/** Refuse any object other than the exact response retained for dApp submission. */
export function assertExactDappSubmittedPreparedExit(
  submission: DappSubmittedPreparedExit,
  candidate: PreparedCallAndProof,
): PreparedCallAndProof {
  if (candidate !== submission.prepared) {
    throw new Error("a rebuilt response cannot replace the exact dApp-submitted prepared exit");
  }
  const binding = submission[exactDappSubmittedPreparedExit];
  const noteId = resolvePreparedExitNoteId(
    candidate.call,
    binding.pool,
    binding.contract,
    binding.kind,
    binding.args,
  );
  if (noteId !== submission.noteId) {
    throw new Error("prepared exit changed after note binding");
  }
  return candidate;
}

export function serializeFund(args: FundArgs): string[] {
  return [
    felt(BigInt(PrivateAction.Fund)),
    felt(args.vault_id, "vault id"),
    felt(args.token, "token"),
    felt(u128(args.amount, "amount")),
    felt(args.mode, "mode"),
    felt(args.owner_key, "owner key"),
    felt(args.successor_key, "successor key"),
    felt(u64(args.inactivity_seconds, "inactivity seconds")),
    felt(u64(args.grace_seconds, "grace seconds")),
    felt(u64(args.valid_until, "valid until")),
    felt(args.sig_r, "signature r"),
    felt(args.sig_s, "signature s"),
  ];
}

export function serializeExit(
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  args: ExitArgs,
): string[] {
  const noteId =
    args.note_id === OPEN_NOTE_PLACEHOLDER
      ? OPEN_NOTE_PLACEHOLDER
      : felt(args.note_id, "note id");
  return [
    felt(BigInt(kind)),
    felt(args.vault_id, "vault id"),
    felt(args.token, "token"),
    felt(u128(args.amount, "amount")),
    felt(args.expected_state, "expected state"),
    felt(u64(args.expected_epoch, "expected epoch")),
    felt(u64(args.expected_nonce, "expected nonce")),
    noteId,
    felt(u64(args.valid_until, "valid until")),
    felt(args.sig_r, "signature r"),
    felt(args.sig_s, "signature s"),
  ];
}

export function serializeControl(args: ControlArgs): string[] {
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

function buildExitActions(
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  contract: FeltInput,
  noteRecipient: FeltInput,
  args: ExitArgs,
): readonly STRK20_ACTION[] {
  if (args.note_id !== OPEN_NOTE_PLACEHOLDER) {
    throw new Error("Ready exit actions must reference ${openNoteIds[0]}; literal note ids are signing inputs only");
  }
  const target = address(contract, "Afterlight contract");
  const actions: STRK20_ACTION[] = [
    {
      type: "transfer",
      token: address(args.token, "token"),
      amount: "OPEN",
      recipient: address(noteRecipient, "open-note recipient"),
    },
    {
      type: "invoke",
      contract: target,
      calldata: serializeExit(kind, args),
    },
  ];
  assertNoSelfWithdraw(actions, noteRecipient);
  return Object.freeze(actions);
}

function buildManagedExitActions(
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  contract: FeltInput,
  noteRecipient: FeltInput,
  args: ExitArgs,
): readonly STRK20_ACTION[] {
  if (args.note_id === OPEN_NOTE_PLACEHOLDER) {
    throw new Error("managed Ready exit requires the resolved, signed open-note ID");
  }
  const target = address(contract, "Afterlight contract");
  const actions: STRK20_ACTION[] = [
    {
      type: "transfer",
      token: address(args.token, "token"),
      amount: "OPEN",
      recipient: address(noteRecipient, "open-note recipient"),
    },
    {
      type: "invoke",
      contract: target,
      calldata: serializeExit(kind, args),
    },
  ];
  assertNoSelfWithdraw(actions, noteRecipient);
  return Object.freeze(actions);
}

/** A live-path invariant: private exits never add NIGHTSHIFT's public self-withdraw canary. */
export function assertNoSelfWithdraw(
  actions: readonly STRK20_ACTION[],
  accountAddress: FeltInput,
): void {
  const self = address(accountAddress, "account address");
  const found = actions.some(
    (action) =>
      action.type === "withdraw" && address(action.recipient, "withdraw recipient") === self,
  );
  if (found) throw new Error("public self-withdraw is forbidden in Afterlight exit batches");
}

type NormalizedPreparedPoolCall = Readonly<{
  pool: string;
  entrypoint: string;
  calldata: readonly bigint[];
}>;

type ParsedInvoke = Readonly<{
  target: string;
  calldata: readonly bigint[];
  calldataStart: number;
  actionIndex: number;
}>;

type ParsedOpenNote = Readonly<{
  token: string;
  noteId: string;
  actionIndex: number;
  randomizedOffsets: readonly number[];
}>;

type ParsedWriteOnce = Readonly<{
  storageAddress: bigint;
  value: readonly bigint[];
  actionIndex: number;
}>;

type ParsedServerAction = Readonly<{
  variant: bigint;
  start: number;
  end: number;
}>;

type ParsedServerInvokes = Readonly<{
  invokes: readonly ParsedInvoke[];
  openNotes: readonly ParsedOpenNote[];
  writeOnceActions: readonly ParsedWriteOnce[];
  actions: readonly ParsedServerAction[];
  actionsEnd: number;
}>;

type ValidatedPreparedExit = Readonly<{
  noteId: string;
  normalized: NormalizedPreparedPoolCall;
  invoke: ParsedInvoke;
  openNote: ParsedOpenNote;
  writeOnce: ParsedWriteOnce;
  actions: readonly ParsedServerAction[];
  actionsEnd: number;
}>;

function normalizePreparedPoolCall(call: PreparedPoolCall): NormalizedPreparedPoolCall {
  const record = call as unknown as Record<string, unknown>;
  const pools = [record.contractAddress, record.contract_address]
    .filter((value) => value !== undefined)
    .map((value) => address(asFeltInput(value, "prepared pool call target")));
  if (pools.length === 0) throw new Error("prepared call is missing its pool target");
  if (pools.some((value) => value !== pools[0])) {
    throw new Error("prepared call has conflicting pool targets");
  }

  const entrypoints = [record.entrypoint, record.entry_point]
    .filter((value) => value !== undefined)
    .map((value) => {
      if (typeof value !== "string") throw new TypeError("prepared call entrypoint must be a string");
      return value;
    });
  if (entrypoints.length === 0) throw new Error("prepared call is missing its entrypoint");
  if (entrypoints.some((value) => value !== entrypoints[0])) {
    throw new Error("prepared call has conflicting entrypoints");
  }
  if (!Array.isArray(record.calldata)) throw new Error("prepared call calldata must be an array");

  return {
    pool: pools[0]!,
    entrypoint: entrypoints[0]!,
    calldata: record.calldata.map((entry, index) =>
      toBigInt(asFeltInput(entry, `prepared calldata[${index}]`), `prepared calldata[${index}]`),
    ),
  };
}

function asFeltInput(value: unknown, label: string): FeltInput {
  if (typeof value !== "string" && typeof value !== "bigint") {
    throw new TypeError(`${label} must be a felt`);
  }
  return value;
}

function assertEquivalentPreparedExitCalls(
  sentinel: ValidatedPreparedExit,
  signed: ValidatedPreparedExit,
): void {
  if (
    sentinel.normalized.pool !== signed.normalized.pool ||
    sentinel.normalized.entrypoint !== signed.normalized.entrypoint
  ) {
    throw new Error("sentinel and final prepared pool calls target different entrypoints");
  }
  if (sentinel.invoke.calldataStart !== signed.invoke.calldataStart) {
    throw new Error("sentinel and final prepared Invoke layouts differ");
  }
  if (
    sentinel.actions.length !== signed.actions.length ||
    sentinel.actions.some((action, index) => {
      const candidate = signed.actions[index];
      return (
        candidate === undefined ||
        action.variant !== candidate.variant ||
        action.start !== candidate.start ||
        action.end !== candidate.end
      );
    })
  ) {
    throw new Error("sentinel and final prepared ServerAction layouts differ");
  }
  if (
    sentinel.openNote.token !== signed.openNote.token ||
    sentinel.openNote.noteId !== signed.openNote.noteId ||
    sentinel.openNote.actionIndex !== signed.openNote.actionIndex
  ) {
    throw new Error("sentinel and final prepared open-note semantics differ");
  }

  const sentinelRaw = sentinel.normalized.calldata.slice(0, sentinel.actionsEnd);
  const signedRaw = signed.normalized.calldata.slice(0, signed.actionsEnd);
  if (sentinelRaw.length !== signedRaw.length) {
    throw new Error("sentinel and final prepared pool calls have different lengths");
  }

  const signatureOffsets = new Set([
    sentinel.invoke.calldataStart + 9,
    sentinel.invoke.calldataStart + 10,
  ]);
  const randomizedOpenNoteOffsets = sentinel.openNote.randomizedOffsets;
  if (
    randomizedOpenNoteOffsets.length !== signed.openNote.randomizedOffsets.length ||
    randomizedOpenNoteOffsets.some(
      (offset, index) => offset !== signed.openNote.randomizedOffsets[index],
    )
  ) {
    throw new Error("sentinel and final prepared open-note layouts differ");
  }
  for (const offset of randomizedOpenNoteOffsets) signatureOffsets.add(offset);
  for (let index = 0; index < sentinelRaw.length; index += 1) {
    if (!signatureOffsets.has(index) && sentinelRaw[index] !== signedRaw[index]) {
      throw new Error(`sentinel and final prepared pool calls differ at calldata[${index}]`);
    }
  }
}

function assertCompletePreparedProofEnvelope(
  prepared: PreparedCallAndProof,
  validated: ValidatedPreparedExit,
  proofBaseBlock: Readonly<{ number: FeltInput; hash: FeltInput }>,
): void {
  const { proof } = prepared;
  if (
    typeof proof?.data !== "string" ||
    proof.data.length === 0 ||
    !Array.isArray(proof.output) ||
    proof.output.length < 2 ||
    !Array.isArray(proof.proof_facts)
  ) {
    throw new Error("final signed prepare must contain a non-empty STRK20 proof envelope");
  }
  if (!isCanonicalBase64(proof.data)) {
    throw new Error("final signed prepare proof data must be canonical standard base64");
  }
  proof.output.forEach((entry, index) =>
    toBigInt(asFeltInput(entry, `proof output[${index}]`), `proof output[${index}]`),
  );
  proof.proof_facts.forEach((entry, index) =>
    toBigInt(asFeltInput(entry, `proof fact[${index}]`), `proof fact[${index}]`),
  );
  assertProofOutputMatchesCall(prepared, validated);
  assertCanonicalProofFacts(prepared, validated, proofBaseBlock);
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==")) {
    return (alphabet.indexOf(value[value.length - 3]!) & 0x0f) === 0;
  }
  if (value.endsWith("=")) {
    return (alphabet.indexOf(value[value.length - 2]!) & 0x03) === 0;
  }
  return true;
}

function assertSimulatedPreparedProof(prepared: PreparedCallAndProof): void {
  if (
    prepared.proof?.data !== "" ||
    !Array.isArray(prepared.proof.output) ||
    prepared.proof.output.length !== 0 ||
    !Array.isArray(prepared.proof.proof_facts) ||
    prepared.proof.proof_facts.length !== 0
  ) {
    throw new Error("sentinel prepare must contain an empty simulate=true proof");
  }
}

function assertOptionalProofOutputMatchesCall(
  prepared: PreparedCallAndProof,
  validated: ValidatedPreparedExit,
): void {
  if (!Array.isArray(prepared.proof?.output)) {
    throw new Error("prepared proof output must be an array");
  }
  if (prepared.proof.output.length > 0) {
    assertProofOutputMatchesCall(prepared, validated);
  }
}

/**
 * Pinned privacy SDK 66e3caa defines proof.output as
 * [pool_class_hash, ...serialized_server_actions]. The screening suffix is not
 * proof output and follows the ServerAction span in apply_actions calldata.
 */
function assertProofOutputMatchesCall(
  prepared: PreparedCallAndProof,
  validated: ValidatedPreparedExit,
): void {
  const output = prepared.proof.output.map((entry, index) =>
    toBigInt(asFeltInput(entry, `proof output[${index}]`), `proof output[${index}]`),
  );
  if (output.length < 2) {
    throw new Error("prepared proof output must contain a class hash and ServerActions");
  }
  if (output[0] !== toBigInt(PINNED_STRK20_POOL_CLASS_HASH, "pinned pool class hash")) {
    throw new Error("prepared proof output uses a different privacy-pool class hash");
  }

  const expectedActions = validated.normalized.calldata.slice(0, validated.actionsEnd);
  if (output.length !== expectedActions.length + 1) {
    throw new Error("prepared proof output does not match the prepared ServerActions");
  }
  for (let index = 0; index < expectedActions.length; index += 1) {
    if (output[index + 1] !== expectedActions[index]) {
      throw new Error(`prepared proof output differs at ServerActions[${index}]`);
    }
  }
}

/**
 * Validate the nine-felt ProofFacts fields enforced by the canonical pool.
 * The pool deliberately deserializes but ignores proof_version (field 0),
 * virtual_program_hash (field 2), base_block_hash (field 5), and
 * starknet_os_config_hash (field 6). The SNIP-36 proof verifier remains
 * authoritative for those metadata fields. We still independently bind field
 * 5 to the accepted Mainnet block used by the proof; field 6 must remain
 * unpinned because the canonical pool does not define that invariant.
 */
function assertCanonicalProofFacts(
  prepared: PreparedCallAndProof,
  validated: ValidatedPreparedExit,
  proofBaseBlock: Readonly<{ number: FeltInput; hash: FeltInput }>,
): void {
  const facts = prepared.proof.proof_facts.map((entry, index) =>
    toBigInt(asFeltInput(entry, `proof fact[${index}]`), `proof fact[${index}]`),
  );
  if (facts.length !== 9) {
    throw new Error("prepared proof facts must use the canonical nine-felt layout");
  }
  const expectedBaseBlockNumber = u64(proofBaseBlock.number, "expected proof base block number");
  const expectedBaseBlockHash = toBigInt(proofBaseBlock.hash, "expected proof base block hash");
  if (expectedBaseBlockNumber === 0n || expectedBaseBlockHash === 0n) {
    throw new Error("proof base block must identify a nonzero mainnet block");
  }

  const actions = validated.normalized.calldata.slice(0, validated.actionsEnd);
  const poolClassHash = toBigInt(PINNED_STRK20_POOL_CLASS_HASH, "pinned pool class hash");
  const payload = [poolClassHash, ...actions];
  const messageHash = ec.starkCurve.poseidonHashMany([
    toBigInt(CANONICAL_STRK20_POOL, "canonical pool"),
    0n,
    BigInt(payload.length),
    ...payload,
  ]);
  const expected = [
    undefined,
    VIRTUAL_SNOS,
    undefined,
    VIRTUAL_SNOS0,
    expectedBaseBlockNumber,
    expectedBaseBlockHash,
    undefined,
    1n,
    messageHash,
  ] as const;
  for (let index = 0; index < expected.length; index += 1) {
    const value = expected[index];
    if (value !== undefined && facts[index] !== value) {
      throw new Error(`prepared proof facts differ at field[${index}]`);
    }
  }
}

/** Freeze every mutable leaf of the structurally validated prepared response. */
function freezePreparedResponse(prepared: PreparedCallAndProof): void {
  const calldata = (prepared.call as { calldata?: unknown }).calldata;
  if (Array.isArray(calldata)) Object.freeze(calldata);
  Object.freeze(prepared.call);
  Object.freeze(prepared.proof.output);
  Object.freeze(prepared.proof.proof_facts);
  Object.freeze(prepared.proof);
  Object.freeze(prepared);
}

/** Cairo StoragePath(`notes`).entry(noteId): Pedersen(sn_keccak("notes"), noteId). */
function notesStorageAddress(noteId: bigint): bigint {
  const raw = toBigInt(
    hash.computePedersenHash(hash.starknetKeccak("notes"), noteId),
    "prepared note storage address",
  );
  return raw % constants.ADDR_BOUND;
}

function assertManagedReadyExitRelayEnvelope(
  calldata: readonly FeltInput[],
  contract: FeltInput,
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  signedArgs: ExitArgs,
  poolFee: bigint,
): void {
  if (signedArgs.note_id === OPEN_NOTE_PLACEHOLDER) {
    throw new Error("managed exit evidence requires the literal signed note ID");
  }
  const raw = calldata.map((entry, index) =>
    toBigInt(entry, `managed exit outer calldata[${index}]`),
  );
  let cursor = 0;
  const take = (label: string): bigint => {
    const value = raw[cursor];
    if (value === undefined) throw new Error(`managed exit outer calldata truncated at ${label}`);
    cursor += 1;
    return value;
  };
  const takeSpan = (length: bigint, label: string): readonly bigint[] => {
    if (length < 0n || length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`managed exit outer calldata has invalid ${label} length`);
    }
    const numeric = Number(length);
    if (cursor + numeric > raw.length) {
      throw new Error(`managed exit outer calldata truncated at ${label}`);
    }
    const span = raw.slice(cursor, cursor + numeric);
    cursor += numeric;
    return span;
  };

  if (take("call count") !== 2n) throw new Error("managed exit sponsor must submit exactly two outer calls");
  const feeTarget = take("fee target");
  const feeSelector = take("fee selector");
  const feeCalldata = takeSpan(take("fee calldata length"), "fee calldata");
  const relayTarget = take("relay target");
  const relaySelector = take("relay selector");
  const relay = takeSpan(take("relay calldata length"), "relay calldata");
  if (cursor !== raw.length) throw new Error("managed exit sponsor outer calldata has a trailing call");

  const token = toBigInt(signedArgs.token, "managed exit token");
  const lockedForwarder = toBigInt(LOCKED_READY_SPONSOR_FORWARDER, "Ready sponsor forwarder");
  if (
    feeTarget !== token ||
    feeSelector !== toBigInt(hash.getSelectorFromName("transfer"), "transfer selector") ||
    feeCalldata.length !== 3 ||
    feeCalldata[0] !== lockedForwarder ||
    feeCalldata[1] !== poolFee ||
    feeCalldata[2] !== 0n ||
    relayTarget !== lockedForwarder ||
    relaySelector !== toBigInt(LOCKED_READY_SPONSOR_SELECTOR, "Ready sponsor selector")
  ) {
    throw new Error("managed exit sponsor fee or forwarder envelope differs");
  }

  if (
    relay.length < 10 ||
    relay[0] !== 1n ||
    relay[1] !== toBigInt(CANONICAL_STRK20_POOL, "canonical pool") ||
    relay[2] !== toBigInt(hash.getSelectorFromName("apply_actions"), "apply_actions selector")
  ) {
    throw new Error("managed exit sponsor does not forward one canonical pool call");
  }
  const poolLength = relay[3]!;
  if (poolLength < 0n || poolLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("managed exit pool calldata length is invalid");
  }
  const poolEnd = 4 + Number(poolLength);
  if (relay.length !== poolEnd + 5) throw new Error("managed exit relay trailer length differs");
  const pool = relay.slice(4, poolEnd);
  const trailer = relay.slice(poolEnd);
  if (
    trailer[0] !== token ||
    trailer[1] !== poolFee ||
    trailer[2] !== 0n ||
    trailer[3] !== 1n ||
    trailer[4] === 0n
  ) {
    throw new Error("managed exit relay fee trailer differs");
  }

  const parsed = parseServerInvokes(pool, "strict-none-suffix");
  if (parsed.openNotes.length !== 1 || parsed.writeOnceActions.length !== 1 || parsed.invokes.length !== 1) {
    throw new Error("managed exit must create one exact open note and invoke Afterlight once");
  }
  const openNote = parsed.openNotes[0]!;
  const signedNoteId = felt(signedArgs.note_id, "managed exit signed note ID");
  if (openNote.token !== address(signedArgs.token, "managed exit note token") || openNote.noteId !== signedNoteId) {
    throw new Error("managed exit open note differs from the signed destination");
  }
  const writeOnce = parsed.writeOnceActions[0]!;
  if (
    writeOnce.storageAddress !== notesStorageAddress(toBigInt(signedNoteId, "managed exit note ID")) ||
    writeOnce.value.length !== 2 ||
    writeOnce.value[0] !== OPEN_NOTE_PACKED_VALUE ||
    writeOnce.value[1] !== token
  ) {
    throw new Error("managed exit note storage differs from the signed destination");
  }
  const invoke = parsed.invokes[0]!;
  const expectedInvoke = serializeExit(kind, signedArgs).map((entry, index) =>
    toBigInt(entry, `managed exit expected invoke[${index}]`),
  );
  if (
    invoke.target !== address(contract, "Afterlight contract") ||
    invoke.calldata.length !== expectedInvoke.length ||
    invoke.calldata.some((entry, index) => entry !== expectedInvoke[index])
  ) {
    throw new Error("managed exit Afterlight invocation differs from the signed authorization");
  }

  let feeTransferTo = 0;
  let feeWithdrawal = 0;
  for (const action of parsed.actions) {
    if (action.variant === 2n || action.variant === 4n || action.variant === 6n || action.variant === 11n) {
      throw new Error("managed exit contains a forbidden server action");
    }
    const fields = pool.slice(action.start + 1, action.end);
    if (action.variant === 3n) {
      if (fields.length !== 3 || fields[0] !== lockedForwarder || fields[1] !== token || fields[2] !== poolFee) {
        throw new Error("managed exit contains an unexpected public transfer");
      }
      feeTransferTo += 1;
    }
    if (action.variant === 5n) {
      if (fields.length !== 6 || fields[3] !== lockedForwarder || fields[4] !== token || fields[5] !== poolFee) {
        throw new Error("managed exit contains an unexpected withdrawal");
      }
      feeWithdrawal += 1;
    }
  }
  if (feeTransferTo !== 1 || feeWithdrawal !== 1) {
    throw new Error("managed exit does not contain exactly one private fee reimbursement");
  }
}

/** Decode enough of the current pool ServerAction ABI to locate top-level Invoke actions. */
function parseServerInvokes(
  raw: readonly bigint[],
  screeningPolicy: "strict-none-suffix" | "simulated-may-omit-screening-suffix",
): ParsedServerInvokes {
  let cursor = 0;
  const take = (label: string): bigint => {
    const value = raw[cursor];
    if (value === undefined) throw new Error(`truncated prepared pool calldata at ${label}`);
    cursor += 1;
    return value;
  };
  const count = (label: string): number => {
    const value = take(label);
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`invalid prepared pool length at ${label}`);
    }
    return Number(value);
  };
  const skip = (length: number, label: string): void => {
    if (cursor + length > raw.length) {
      throw new Error(`truncated prepared pool calldata at ${label}`);
    }
    cursor += length;
  };

  const actionCount = count("server action count");
  const invokes: ParsedInvoke[] = [];
  const openNotes: ParsedOpenNote[] = [];
  const writeOnceActions: ParsedWriteOnce[] = [];
  const actions: ParsedServerAction[] = [];
  for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
    const actionStart = cursor;
    const variant = take(`server action[${actionIndex}] variant`);
    switch (variant) {
      case 0n: { // WriteOnce(storage_address, Span<felt252>)
        const storageAddress = take(`server action[${actionIndex}] storage address`);
        const valueLength = count(`server action[${actionIndex}] value length`);
        const end = cursor + valueLength;
        if (end > raw.length) {
          throw new Error(`truncated prepared pool calldata at server action[${actionIndex}] value`);
        }
        writeOnceActions.push({
          storageAddress,
          value: raw.slice(cursor, end),
          actionIndex,
        });
        cursor = end;
        break;
      }
      case 1n: // Append(recipient_addr, EncChannelInfo)
        skip(4, `server action[${actionIndex}] Append`);
        break;
      case 2n: // TransferFrom(from_addr, token, amount)
      case 3n: // TransferTo(to_addr, token, amount)
      case 6n: // EmitDeposit(user_addr, token, amount)
        skip(3, `server action[${actionIndex}] fixed fields`);
        break;
      case 4n: // EmitViewingKeySet(user_addr, public_key, EncPrivateKey)
        skip(5, `server action[${actionIndex}] fixed fields`);
        break;
      case 7n: { // EmitOpenNoteCreated(EncUserAddr, token, note_id)
        const fieldsStart = cursor;
        const auditorPublicKey = take(`server action[${actionIndex}] auditor public key`);
        const ephemeralPublicKey = take(`server action[${actionIndex}] ephemeral public key`);
        const encryptedRecipient = take(`server action[${actionIndex}] encrypted recipient`);
        const token = take(`server action[${actionIndex}] open-note token`);
        const noteId = take(`server action[${actionIndex}] open-note ID`);
        // The first, fourth, and fifth fields are semantic. Ready recompiles
        // each prepare with fresh encryption randomness, so only the
        // ephemeral key and ciphertext are expected to differ.
        void auditorPublicKey;
        void ephemeralPublicKey;
        void encryptedRecipient;
        openNotes.push({
          token: address(token, "prepared open-note token"),
          noteId: felt(noteId, "prepared open-note ID"),
          actionIndex,
          randomizedOffsets: Object.freeze([fieldsStart + 1, fieldsStart + 2]),
        });
        break;
      }
      case 5n: // EmitWithdrawal(EncUserAddr, to_addr, token, amount)
        skip(6, `server action[${actionIndex}] fixed fields`);
        break;
      case 8n: // EmitEncNoteCreated(note_id, packed_value)
        skip(2, `server action[${actionIndex}] fixed fields`);
        break;
      case 9n: // EmitNoteUsed(nullifier)
        skip(1, `server action[${actionIndex}] nullifier`);
        break;
      case 10n:
      case 11n: { // Invoke / InvokeWithComputation(contract_address, Span<felt252>)
        const target = address(take(`server action[${actionIndex}] target`), "prepared Invoke target");
        const calldataLength = count(`server action[${actionIndex}] calldata length`);
        const calldataStart = cursor;
        const end = cursor + calldataLength;
        if (end > raw.length) {
          throw new Error(`truncated prepared pool calldata at server action[${actionIndex}] calldata`);
        }
        if (variant === 10n) {
          invokes.push({ target, calldata: raw.slice(cursor, end), calldataStart, actionIndex });
        }
        cursor = end;
        break;
      }
      default:
        throw new Error(`unknown prepared pool ServerAction variant ${variant}`);
    }
    actions.push({ variant, start: actionStart, end: cursor });
  }

  const suffix = raw.slice(cursor);
  if (screeningPolicy === "simulated-may-omit-screening-suffix" && suffix.length === 0) {
    return { invokes, openNotes, writeOnceActions, actions, actionsEnd: cursor };
  }
  if (suffix.length !== 1 || suffix[0] !== 1n) {
    throw new Error("prepared no-deposit exit requires an exact Option::None screening suffix");
  }
  return { invokes, openNotes, writeOnceActions, actions, actionsEnd: cursor };
}
