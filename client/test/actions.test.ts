import assert from "node:assert/strict";
import { test } from "node:test";

import type { STRK20_ACTION } from "@starknet-io/types-js";

import {
  address,
  assertExactPreparedExitSubmission,
  assertNoSelfWithdraw,
  bindPreparedExitSubmission,
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
  type PreparedCallAndProof,
} from "../src/index.js";

const contract = "0x1234";
const token = "0x5678";
const account = "0x9999";
const pool = "0x8888";

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

function preparedExit(
  kind: PrivateAction.CancelRefund | PrivateAction.Claim,
  args: ExitArgs,
  noteId: string,
  options: Readonly<{
    pool?: string;
    target?: string;
    copies?: number;
    entrypoint?: string;
    simulate?: boolean;
    serverActionsBefore?: readonly (readonly string[])[];
  }> = {},
): PreparedCallAndProof {
  const serialized = serializeExit(kind, args);
  serialized[7] = noteId;
  const invoke = ["0xa", address(options.target ?? contract), "0xb", ...serialized];
  const copies = options.copies ?? 1;
  const actions = [
    ...(options.serverActionsBefore ?? []),
    ...Array.from({ length: copies }, () => invoke),
  ];
  const serverActions = [`0x${actions.length.toString(16)}`, ...actions.flat()];
  const calldata = [...serverActions, "0x1"];
  return {
    call: {
      contractAddress: address(options.pool ?? pool),
      entrypoint: options.entrypoint ?? "apply_actions",
      calldata,
    },
    proof: options.simulate
      ? { data: "", output: [], proof_facts: [] }
      : {
          data: `proof-${noteId}`,
          output: ["0xc1a55", ...serverActions],
          proof_facts: ["0x2"],
        },
  };
}

test("resolved OPEN note is extracted from sentinel and real-signature prepared pool calls", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelSerialized = serializeExit(PrivateAction.Claim, sentinelArgs);
  sentinelSerialized[7] = "0xdeadbeef";
  const sentinelInvoke = ["0xa", address(contract), "0xb", ...sentinelSerialized];
  const sentinelPreparedCall = {
    contract_address: address(pool),
    entry_point: "apply_actions",
    calldata: ["0x1", ...sentinelInvoke, "0x1"],
  };
  assert.equal(
    resolvePreparedExitNoteId(
      sentinelPreparedCall,
      pool,
      contract,
      PrivateAction.Claim,
      sentinelArgs,
    ),
    "0xdeadbeef",
  );

  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  assert.equal(
    resolvePreparedExitNoteId(signedPrepared.call, pool, contract, PrivateAction.Claim, exit),
    "0xdeadbeef",
  );
});

test("final signed prepare is bound to the signed note and exact wallet response", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  const submission = bindPreparedExitSubmission({
    pool,
    contract,
    kind: PrivateAction.Claim,
    sentinelArgs,
    sentinelPrepared,
    signedNoteId: "0xdeadbeef",
    signedArgs: exit,
    signedPrepared,
  });

  assert.equal(submission.noteId, "0xdeadbeef");
  assert.equal(assertExactPreparedExitSubmission(submission, signedPrepared), signedPrepared);
  assert.throws(
    () =>
      assertExactPreparedExitSubmission(submission, {
        call: {
          ...signedPrepared.call,
          calldata: Array.from(signedPrepared.call.calldata as string[]),
        },
        proof: signedPrepared.proof,
      }),
    /independently rebuilt/,
  );
});

test("prepared exit binding rejects note drift and non-placeholder submit calldata", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  assert.throws(
    () =>
      bindPreparedExitSubmission({
        pool,
        contract,
        kind: PrivateAction.Claim,
        sentinelArgs,
        sentinelPrepared,
        signedNoteId: "0xdeadbeef",
        signedArgs: exit,
        signedPrepared: preparedExit(PrivateAction.Claim, exit, "0xcafebabe"),
      }),
    /drifted/,
  );
  assert.throws(
    () =>
      resolvePreparedExitNoteId(
        preparedExit(PrivateAction.Claim, exit, "0xdeadbeef").call,
        pool,
        contract,
        PrivateAction.Claim,
        { ...exit, note_id: "0xdeadbeef" },
      ),
    /placeholder/,
  );
});

test("final prepare cannot add a TransferTo outside the signed Afterlight Invoke", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  const transferTo = ["0x3", address("0x7777"), address(token), "0x1"];
  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", {
    serverActionsBefore: [transferTo],
  });

  assert.throws(
    () =>
      bindPreparedExitSubmission({
        pool,
        contract,
        kind: PrivateAction.Claim,
        sentinelArgs,
        sentinelPrepared,
        signedNoteId: "0xdeadbeef",
        signedArgs: exit,
        signedPrepared,
      }),
    /Invoke layouts differ|different lengths|differ at calldata/,
  );
});

test("final proof output must be the prepared call's exact ServerAction prefix", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  signedPrepared.proof.output = ["0xdead", "0x1"];

  assert.throws(
    () =>
      bindPreparedExitSubmission({
        pool,
        contract,
        kind: PrivateAction.Claim,
        sentinelArgs,
        sentinelPrepared,
        signedNoteId: "0xdeadbeef",
        signedArgs: exit,
        signedPrepared,
      }),
    /proof output does not match the prepared ServerActions/,
  );
});

test("simulated final proof cannot bind and an accepted response is deeply immutable", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  const simulatedFinal = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", { simulate: true });
  assert.throws(
    () =>
      bindPreparedExitSubmission({
        pool,
        contract,
        kind: PrivateAction.Claim,
        sentinelArgs,
        sentinelPrepared,
        signedNoteId: "0xdeadbeef",
        signedArgs: exit,
        signedPrepared: simulatedFinal,
      }),
    /non-empty submittable STRK20 proof/,
  );

  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  const submission = bindPreparedExitSubmission({
    pool,
    contract,
    kind: PrivateAction.Claim,
    sentinelArgs,
    sentinelPrepared,
    signedNoteId: "0xdeadbeef",
    signedArgs: exit,
    signedPrepared,
  });
  assert.equal(Object.isFrozen(signedPrepared), true);
  assert.equal(Object.isFrozen(signedPrepared.call), true);
  assert.equal(Object.isFrozen(signedPrepared.call.calldata), true);
  assert.equal(Object.isFrozen(signedPrepared.proof), true);
  assert.equal(Object.isFrozen(signedPrepared.proof.output), true);
  assert.equal(Object.isFrozen(signedPrepared.proof.proof_facts), true);
  assert.throws(() => {
    signedPrepared.proof.data = "tampered";
  }, TypeError);
  assert.throws(() => {
    signedPrepared.call.entrypoint = "compile_actions";
  }, TypeError);
  assert.equal(assertExactPreparedExitSubmission(submission, signedPrepared), signedPrepared);
});

test("prepared exit parser rejects multiple invokes, wrong pool, target, and entrypoint", () => {
  const prepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  assert.throws(
    () =>
      resolvePreparedExitNoteId(
        preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", { copies: 2 }).call,
        pool,
        contract,
        PrivateAction.Claim,
        exit,
      ),
    /found 2/,
  );
  assert.throws(
    () => resolvePreparedExitNoteId(prepared.call, "0x7777", contract, PrivateAction.Claim, exit),
    /wrong privacy pool/,
  );
  assert.throws(
    () =>
      resolvePreparedExitNoteId(
        preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", { target: "0x7777" }).call,
        pool,
        contract,
        PrivateAction.Claim,
        exit,
      ),
    /wrong Afterlight contract/,
  );
  assert.throws(
    () =>
      resolvePreparedExitNoteId(
        preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", { entrypoint: "compile_actions" }).call,
        pool,
        contract,
        PrivateAction.Claim,
        exit,
      ),
    /must use apply_actions/,
  );
});
