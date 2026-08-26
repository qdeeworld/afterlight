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

const STARKNET_MAINNET_CHAIN_ID = 0x534e5f4d41494en;
const STRK_TOKEN = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn;
const OPEN_NOTE_PACKED_VALUE = 1n << 128n;
const PROOF_VERSION = toBigInt(shortString.encodeShortString("PROOF0"));
const VIRTUAL_SNOS = toBigInt(shortString.encodeShortString("VIRTUAL_SNOS"));
const VIRTUAL_SNOS0 = toBigInt(shortString.encodeShortString("VIRTUAL_SNOS0"));
const VIRTUAL_PROGRAM_HASH =
  0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473n;
const STARKNET_OS_CONFIG_HASH_VERSION = toBigInt(
  shortString.encodeShortString("StarknetOsConfig3"),
);

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

function validatePreparedExit(
  preparedCall: PreparedPoolCall,
  pool: FeltInput,
  contract: FeltInput,
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  args: ExitArgs,
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

  const parsed = parseServerInvokes(normalized.calldata);
  const exactVariants = [0n, 7n, 10n];
  if (
    parsed.actions.length !== exactVariants.length ||
    parsed.actions.some((action, index) => action.variant !== exactVariants[index])
  ) {
    throw new Error("prepared exit must contain exactly WriteOnce, EmitOpenNoteCreated, Invoke");
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

const exactPreparedExit = Symbol("exact PreparedCallAndProof returned by the signed prepare");

export type PreparedExitSubmission = Readonly<{
  noteId: string;
  prepared: PreparedCallAndProof;
  [exactPreparedExit]: Readonly<{
    pool: FeltInput;
    contract: FeltInput;
    kind: PrivateAction.CancelRefund | PrivateAction.Claim;
    args: ExitArgs;
  }>;
}>;

export type BindPreparedExitSubmissionArgs = Readonly<{
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
 * Bind the real proof to the note signed after the sentinel prepare. Both
 * action sets retain OPEN_NOTE_PLACEHOLDER; only the prepared calls contain the
 * concrete note id. Ready recompiles CreateOpenNote with fresh encryption
 * randomness, so the two calls are compared semantically while the exact final
 * call/proof object is frozen for submission. The caller must prevent any
 * intervening wallet action that could advance the recipient channel's token
 * note index and therefore change the note id. `proofBaseBlock` must come from
 * an independent mainnet RPC lookup of the block identified by the proof facts;
 * copying those two fields out of the proof does not establish canonicality.
 */
export function bindPreparedExitSubmission(
  input: BindPreparedExitSubmissionArgs,
): PreparedExitSubmission {
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
  assertSubmittableProof(input.signedPrepared, signedExit, input.proofBaseBlock);
  freezePreparedResponse(input.signedPrepared);

  return Object.freeze({
    noteId: signedNoteId,
    prepared: input.signedPrepared,
    [exactPreparedExit]: Object.freeze({
      pool: input.pool,
      contract: input.contract,
      kind: input.kind,
      args: input.signedArgs,
    }),
  });
}

/** Refuse any response other than the exact call-and-proof object that was bound. */
export function assertExactPreparedExitSubmission(
  submission: PreparedExitSubmission,
  candidate: PreparedCallAndProof,
): PreparedCallAndProof {
  if (candidate !== submission.prepared) {
    throw new Error("independently rebuilt prepared exit calls cannot be submitted");
  }
  const binding = submission[exactPreparedExit];
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

  const sentinelRaw = sentinel.normalized.calldata;
  const signedRaw = signed.normalized.calldata;
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

function assertSubmittableProof(
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
    throw new Error("final signed prepare must contain a non-empty submittable STRK20 proof");
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

/** Validate the pinned nine-felt blockifier/Cairo ProofFacts serialization. */
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

  const configHash = toBigInt(
    hash.computeHashOnElements([
      STARKNET_OS_CONFIG_HASH_VERSION,
      STARKNET_MAINNET_CHAIN_ID,
      STRK_TOKEN,
    ]),
    "Starknet OS config hash",
  );
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
    PROOF_VERSION,
    VIRTUAL_SNOS,
    VIRTUAL_PROGRAM_HASH,
    VIRTUAL_SNOS0,
    expectedBaseBlockNumber,
    expectedBaseBlockHash,
    configHash,
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

/** Freeze every mutable leaf whose exact bytes are authorized for submission. */
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

/** Decode enough of the current pool ServerAction ABI to locate top-level Invoke actions. */
function parseServerInvokes(raw: readonly bigint[]): ParsedServerInvokes {
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
  if (suffix.length !== 1 || suffix[0] !== 1n) {
    throw new Error("prepared no-deposit exit requires an exact Option::None screening suffix");
  }
  return { invokes, openNotes, writeOnceActions, actions, actionsEnd: cursor };
}
