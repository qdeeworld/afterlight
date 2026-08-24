import assert from "node:assert/strict";
import { test } from "node:test";

import type { STRK20_ACTION } from "@starknet-io/types-js";

import {
  buildCancelRefundActions,
  buildClaimActions,
  buildFundActions,
  OPEN_NOTE_PLACEHOLDER,
  serializeExit,
  serializeFund,
  PrivateAction,
  type ExitArgs,
  type FundArgs,
} from "../src/index.js";

const contract = "0x300";
const noteRecipient = "0x301";

// Every field is deliberately distinct so a swap, omission, or accidental
// enum reorder changes the raw vector. The comments mirror common.cairo's
// FundArgs and ExitArgs declaration order.
const fund: FundArgs = {
  vault_id: "0x101",
  token: "0x102",
  amount: "0x103",
  mode: "0x14",
  owner_key: "0x105",
  successor_key: "0x106",
  inactivity_seconds: "0x107",
  grace_seconds: "0x108",
  valid_until: "0x109",
  sig_r: "0x10a",
  sig_s: "0x10b",
};

const fundVector = [
  "0x0", // PrivateAction::Fund discriminator
  "0x101", // vault_id
  "0x102", // token
  "0x103", // amount
  "0x14", // mode (valid u8)
  "0x105", // owner_key
  "0x106", // successor_key
  "0x107", // inactivity_seconds
  "0x108", // grace_seconds
  "0x109", // valid_until
  "0x10a", // sig_r
  "0x10b", // sig_s
] as const;

const exit: ExitArgs = {
  vault_id: "0x201",
  token: "0x202",
  amount: "0x203",
  expected_state: "0x24",
  expected_epoch: "0x205",
  expected_nonce: "0x206",
  note_id: OPEN_NOTE_PLACEHOLDER,
  valid_until: "0x208",
  sig_r: "0x209",
  sig_s: "0x20a",
};

function exitVector(discriminator: "0x1" | "0x2") {
  return [
    discriminator,
    "0x201", // vault_id
    "0x202", // token
    "0x203", // amount
    "0x24", // expected_state (valid u8)
    "0x205", // expected_epoch
    "0x206", // expected_nonce
    OPEN_NOTE_PLACEHOLDER, // note_id, resolved by Ready
    "0x208", // valid_until
    "0x209", // sig_r
    "0x20a", // sig_s
  ] as const;
}

function walletInvokeCalldata(actions: readonly STRK20_ACTION[]): readonly string[] {
  const invoke = actions.find((action) => action.type === "invoke");
  if (invoke?.type !== "invoke") throw new Error("wallet batch has no invoke action");
  return invoke.calldata;
}

test("raw FUND wallet calldata matches Cairo enum and FundArgs ABI order", () => {
  assert.equal(PrivateAction.Fund, 0);
  assert.deepEqual(serializeFund(fund), fundVector);
  assert.deepEqual(walletInvokeCalldata(buildFundActions(contract, fund)), fundVector);
});

test("raw CANCEL_REFUND wallet calldata matches Cairo enum and ExitArgs ABI order", () => {
  const expected = exitVector("0x1");
  assert.equal(PrivateAction.CancelRefund, 1);
  assert.deepEqual(serializeExit(PrivateAction.CancelRefund, exit), expected);
  assert.deepEqual(
    walletInvokeCalldata(buildCancelRefundActions(contract, noteRecipient, exit)),
    expected,
  );
});

test("raw CLAIM wallet calldata matches Cairo enum and ExitArgs ABI order", () => {
  const expected = exitVector("0x2");
  assert.equal(PrivateAction.Claim, 2);
  assert.deepEqual(serializeExit(PrivateAction.Claim, exit), expected);
  assert.deepEqual(walletInvokeCalldata(buildClaimActions(contract, noteRecipient, exit)), expected);
});
