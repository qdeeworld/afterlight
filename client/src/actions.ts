import type { STRK20_ACTION } from "@starknet-io/types-js";

import { address, felt, toBigInt, u64, u128, type FeltInput } from "./encoding.js";

/** Cairo enum discriminants. Changing this order is a breaking ABI change. */
export enum PrivateAction {
  Fund = 0,
  CancelRefund = 1,
  Claim = 2,
}

export const OPEN_NOTE_PLACEHOLDER = "${openNoteIds[0]}" as const;
export const PREPARE_SIGNATURE = Object.freeze({ sig_r: "0x1", sig_s: "0x1" });

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
 * Parse the wallet-resolved note id from a prepared pool call. This is only
 * valid for the sentinel-signature preparation batch. The submitted batch must
 * retain OPEN_NOTE_PLACEHOLDER so Ready resolves the same slot itself.
 */
export function resolvePreparedExitNoteId(
  preparedCalldata: readonly FeltInput[],
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  args: ExitArgs,
): string {
  if (
    toBigInt(args.sig_r, "signature r") !== 1n ||
    toBigInt(args.sig_s, "signature s") !== 1n ||
    args.note_id !== OPEN_NOTE_PLACEHOLDER
  ) {
    throw new Error("note resolution requires placeholder calldata and the prepare signature sentinel");
  }
  const expected = serializeExit(kind, args);
  const raw = preparedCalldata.map((entry, index) =>
    toBigInt(entry, `prepared calldata[${index}]`),
  );
  const known = expected.map((entry, index) =>
    index === 7 ? undefined : toBigInt(entry, `expected calldata[${index}]`),
  );

  const matches: bigint[] = [];
  for (let start = 0; start + expected.length <= raw.length; start += 1) {
    let match = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (offset !== 7 && raw[start + offset] !== known[offset]) {
        match = false;
        break;
      }
    }
    if (match) matches.push(raw[start + 7]!);
  }
  if (matches.length !== 1) {
    throw new Error(`expected one resolved Afterlight exit tail, found ${matches.length}`);
  }
  return felt(matches[0]!, "resolved note id");
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
