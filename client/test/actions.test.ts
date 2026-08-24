import assert from "node:assert/strict";
import { test } from "node:test";

import type { STRK20_ACTION } from "@starknet-io/types-js";

import {
  address,
  assertNoSelfWithdraw,
  buildCancelRefundActions,
  buildClaimActions,
  buildFundActions,
  OPEN_NOTE_PLACEHOLDER,
  PREPARE_SIGNATURE,
  PrivateAction,
  resolvePreparedExitNoteId,
  serializeExit,
  type ExitArgs,
  type FundArgs,
} from "../src/index.js";

const contract = "0x1234";
const token = "0x5678";
const account = "0x9999";

const fund: FundArgs = {
  vault_id: "0xabc",
  token,
  amount: 10n ** 19n,
  mode: 1n,
  owner_key: "0x111",
  successor_key: "0x222",
  inactivity_seconds: 120n,
  grace_seconds: 60n,
  valid_until: 1_787_540_000n,
  sig_r: "0x333",
  sig_s: "0x444",
};

const exit: ExitArgs = {
  vault_id: "0xabc",
  token,
  amount: 10n ** 19n,
  expected_state: 2n,
  expected_epoch: 3n,
  expected_nonce: 4n,
  note_id: OPEN_NOTE_PLACEHOLDER,
  valid_until: 1_787_540_000n,
  sig_r: "0x333",
  sig_s: "0x444",
};

test("private action enum ABI order is frozen", () => {
  assert.equal(PrivateAction.Fund, 0);
  assert.equal(PrivateAction.CancelRefund, 1);
  assert.equal(PrivateAction.Claim, 2);
});

test("FUND is exactly withdraw-to-helper then invoke", () => {
  const actions = buildFundActions(contract, fund);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], {
    type: "withdraw",
    token: address(token),
    amount: "0x8ac7230489e80000",
    recipient: address(contract),
  });
  assert.deepEqual(actions[1], {
    type: "invoke",
    contract: address(contract),
    calldata: [
      "0x0",
      "0xabc",
      "0x5678",
      "0x8ac7230489e80000",
      "0x1",
      "0x111",
      "0x222",
      "0x78",
      "0x3c",
      "0x6a8bb220",
      "0x333",
      "0x444",
    ],
  });
});

test("CANCEL_REFUND and CLAIM are exactly OPEN transfer then invoke, with no withdrawal", () => {
  for (const [kind, actions] of [
    [PrivateAction.CancelRefund, buildCancelRefundActions(contract, account, exit)],
    [PrivateAction.Claim, buildClaimActions(contract, account, exit)],
  ] as const) {
    assert.equal(actions.length, 2);
    assert.deepEqual(actions[0], {
      type: "transfer",
      token: address(token),
      amount: "OPEN",
      recipient: address(account),
    });
    assert.equal(actions[1]!.type, "invoke");
    if (actions[1]!.type === "invoke") {
      assert.equal(actions[1]!.calldata[0], `0x${kind.toString(16)}`);
      assert.equal(actions[1]!.calldata[7], OPEN_NOTE_PLACEHOLDER);
    }
    assert.equal(actions.some((action) => action.type === "withdraw"), false);
    assert.doesNotThrow(() => assertNoSelfWithdraw(actions, account));
  }
});

test("exit builders reject literal note IDs and explicit self-withdraws", () => {
  assert.throws(
    () => buildClaimActions(contract, account, { ...exit, note_id: "0x777" }),
    /must reference/,
  );
  const unsafe: STRK20_ACTION[] = [
    { type: "withdraw", token: address(token), amount: "0x1", recipient: address(account) },
  ];
  assert.throws(() => assertNoSelfWithdraw(unsafe, account), /self-withdraw is forbidden/);
});

test("resolved OPEN note is extracted from one unambiguous prepared exit tail", () => {
  const prepare: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const serialized = serializeExit(PrivateAction.Claim, prepare);
  serialized[7] = "0xdeadbeef";
  const preparedPoolCalldata = ["0x900", "0x901", ...serialized, "0x902"];
  assert.equal(
    resolvePreparedExitNoteId(preparedPoolCalldata, PrivateAction.Claim, prepare),
    "0xdeadbeef",
  );
  assert.throws(
    () =>
      resolvePreparedExitNoteId(
        [...preparedPoolCalldata, ...serialized],
        PrivateAction.Claim,
        prepare,
      ),
    /found 2/,
  );
  assert.throws(
    () => resolvePreparedExitNoteId(preparedPoolCalldata, PrivateAction.Claim, exit),
    /prepare signature sentinel/,
  );
});
