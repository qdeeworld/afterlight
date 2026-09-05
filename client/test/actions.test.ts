import assert from "node:assert/strict";
import { test } from "node:test";

import type { STRK20_ACTION } from "@starknet-io/types-js";
import { constants, ec, hash, shortString } from "starknet";

import {
  address,
  assertExactDappSubmittedPreparedExit,
  assertManagedReadyExitEvidence,
  assertNoSelfWithdraw,
  bindDappSubmittedPreparedExit,
  buildCancelRefundActions,
  buildClaimActions,
  buildFundActions,
  buildManagedCancelRefundActions,
  buildManagedClaimActions,
  CANONICAL_STRK20_POOL,
  LOCKED_READY_SPONSOR_FORWARDER,
  LOCKED_READY_SPONSOR_SELECTOR,
  OPEN_NOTE_PLACEHOLDER,
  PINNED_STRK20_POOL_CLASS_HASH,
  PREPARE_SIGNATURE,
  preparedExitNeedsSetupAuthorization,
  PrivateAction,
  resolvePreparedExitNoteId,
  resolveSimulatedPreparedExitNoteId,
  inspectSimulatedExitWrites,
  serializeExit,
  validatePreparedExitProofEnvelope,
  type ExitArgs,
  type FundArgs,
  type PreparedCallAndProof,
  type ValidatePreparedExitProofEnvelopeArgs,
} from "../src/index.js";

const contract = "0x1234";
const token = "0x5678";
const account = "0x9999";
const pool = CANONICAL_STRK20_POOL;
const poolClassHash = PINNED_STRK20_POOL_CLASS_HASH;
const proofBaseBlock = Object.freeze({ number: "0xd3a000", hash: "0x123456" });
const openNotePackedValue = 1n << 128n;
const mainnetChainId = 0x534e5f4d41494en;
const strkToken = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn;
const virtualProgramHash =
  0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473n;

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

test("managed Ready exits retain the exact signed note while Ready creates the OPEN note", () => {
  const resolved = { ...exit, note_id: "0x777" };
  for (const [kind, actions] of [
    [PrivateAction.CancelRefund, buildManagedCancelRefundActions(contract, account, resolved)],
    [PrivateAction.Claim, buildManagedClaimActions(contract, account, resolved)],
  ] as const) {
    assert.deepEqual(actions[0], {
      type: "transfer",
      token: address(token),
      amount: "OPEN",
      recipient: address(account),
    });
    assert.equal(actions[1]!.type, "invoke");
    if (actions[1]!.type === "invoke") {
      assert.equal(actions[1]!.calldata[0], `0x${kind.toString(16)}`);
      assert.equal(actions[1]!.calldata[7], "0x777");
    }
    assert.equal(actions.some((action) => action.type === "withdraw"), false);
  }
});

test("managed Ready exits reject an unresolved destination", () => {
  assert.throws(
    () => buildManagedClaimActions(contract, account, exit),
    /requires the resolved, signed open-note ID/,
  );
});

function managedExitEvidence(overrides: Readonly<Record<string, unknown>> = {}) {
  const signedArgs = { ...exit, note_id: "0x777" };
  const invokeCalldata = serializeExit(PrivateAction.Claim, signedArgs);
  const fee = 6n * 10n ** 18n;
  const serverActions = [
    ["0x0", noteStorageAddress("0x777"), "0x2", hex(openNotePackedValue), address(token)],
    ["0x7", "0xa11d", "0xe11e", "0xec11", address(token), "0x777"],
    ["0xa", address(contract), "0xb", ...invokeCalldata],
    ["0x3", LOCKED_READY_SPONSOR_FORWARDER, address(token), hex(fee)],
    ["0x5", "0x111", "0x222", "0x333", LOCKED_READY_SPONSOR_FORWARDER, address(token), hex(fee)],
  ];
  const poolCalldata = [hex(BigInt(serverActions.length)), ...serverActions.flat(), "0x1"];
  const relayCalldata = [
    "0x1",
    address(pool),
    hash.getSelectorFromName("apply_actions"),
    hex(BigInt(poolCalldata.length)),
    ...poolCalldata,
    address(token),
    hex(fee),
    "0x0",
    "0x1",
    "0x1234",
  ];
  const transaction = {
    transactionHash: "0xabc",
    senderAddress: "0x7777",
    calldata: [
      "0x2",
      address(token),
      hash.getSelectorFromName("transfer"),
      "0x3",
      LOCKED_READY_SPONSOR_FORWARDER,
      hex(fee),
      "0x0",
      LOCKED_READY_SPONSOR_FORWARDER,
      LOCKED_READY_SPONSOR_SELECTOR,
      hex(BigInt(relayCalldata.length)),
      ...relayCalldata,
    ],
  };
  return {
    transaction,
    receipt: {
      transactionHash: "0xabc",
      finalityStatus: "ACCEPTED_ON_L2",
      executionStatus: "SUCCEEDED",
      poolEventCount: 7,
      afterlightEventCount: 1,
      openNoteCreatedEventCount: 1,
      poolFeeWithdrawalCount: 1,
      poolFeeCollectorTransferCount: 1,
    },
    readyAccounts: [account, "0x8888"],
    contract,
    kind: PrivateAction.Claim,
    signedArgs,
    poolFee: fee,
    shieldedBalanceBefore: 12n * 10n ** 18n,
    shieldedBalanceAfter: 16n * 10n ** 18n,
    lockedLiabilityBefore: 20n * 10n ** 18n,
    lockedLiabilityAfter: 10n * 10n ** 18n,
    ...overrides,
  } as Parameters<typeof assertManagedReadyExitEvidence>[0];
}

test("managed Ready exit evidence binds sender, sponsor, exact note, receipt, and deltas", () => {
  const exact = managedExitEvidence();
  assert.doesNotThrow(() => assertManagedReadyExitEvidence(exact));
  assert.throws(
    () => assertManagedReadyExitEvidence(managedExitEvidence({
      transaction: { ...exact.transaction, senderAddress: account },
    })),
    /exposed a Ready account/,
  );
  assert.throws(
    () => assertManagedReadyExitEvidence(managedExitEvidence({
      receipt: { ...exact.receipt, executionStatus: "REVERTED" },
    })),
    /not accepted and succeeded/,
  );
  assert.throws(
    () => assertManagedReadyExitEvidence(managedExitEvidence({ shieldedBalanceAfter: 15n * 10n ** 18n })),
    /shielded-balance delta/,
  );
  assert.throws(
    () => assertManagedReadyExitEvidence(managedExitEvidence({ lockedLiabilityAfter: 11n * 10n ** 18n })),
    /liability/,
  );
  assert.throws(
    () => assertManagedReadyExitEvidence(managedExitEvidence({
      signedArgs: { ...exact.signedArgs, note_id: "0x778" },
    })),
    /open note differs from the signed destination/,
  );
  assert.throws(
    () => assertManagedReadyExitEvidence(managedExitEvidence({ contract: "0x4321" })),
    /Afterlight invocation differs/,
  );
  const changedEnvelope = [...exact.transaction.calldata];
  changedEnvelope[5] = "0x1";
  assert.throws(
    () => assertManagedReadyExitEvidence(managedExitEvidence({
      transaction: { ...exact.transaction, calldata: changedEnvelope },
    })),
    /sponsor fee or forwarder/,
  );
});

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function noteStorageAddress(noteId: string): string {
  const raw = BigInt(hash.computePedersenHash(hash.starknetKeccak("notes"), noteId));
  return hex(raw % constants.ADDR_BOUND);
}

function canonicalProofFacts(serverActions: readonly string[], classHash: string): string[] {
  const configHash = hash.computeHashOnElements([
    shortString.encodeShortString("StarknetOsConfig3"),
    mainnetChainId,
    strkToken,
  ]);
  const payload = [BigInt(classHash), ...serverActions.map((entry) => BigInt(entry))];
  const messageHash = ec.starkCurve.poseidonHashMany([
    BigInt(pool),
    0n,
    BigInt(payload.length),
    ...payload,
  ]);
  return [
    shortString.encodeShortString("PROOF1"),
    shortString.encodeShortString("VIRTUAL_SNOS"),
    hex(virtualProgramHash),
    shortString.encodeShortString("VIRTUAL_SNOS0"),
    "0xd3a000",
    "0x123456",
    configHash,
    "0x1",
    hex(messageHash),
  ];
}

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
    setupActions?: readonly (readonly string[])[];
    auditorPublicKey?: string;
    ephemeralPublicKey?: string;
    encryptedRecipient?: string;
    openNoteToken?: string;
    openNoteId?: string;
    writeOnceStorage?: string;
    writeOncePackedValue?: string;
    writeOnceToken?: string;
    screeningSuffix?: readonly string[];
    poolClassHash?: string;
    proofFacts?: readonly string[];
  }> = {},
): PreparedCallAndProof {
  const serialized = serializeExit(kind, args);
  serialized[7] = noteId;
  const invoke = ["0xa", address(options.target ?? contract), "0xb", ...serialized];
  const writeOnce = [
    "0x0",
    options.writeOnceStorage ?? noteStorageAddress(noteId),
    "0x2",
    options.writeOncePackedValue ?? hex(openNotePackedValue),
    address(options.writeOnceToken ?? token),
  ];
  const openNote = [
    "0x7",
    options.auditorPublicKey ?? "0xa11d",
    options.ephemeralPublicKey ?? "0xe11e",
    options.encryptedRecipient ?? "0xec11",
    address(options.openNoteToken ?? token),
    options.openNoteId ?? noteId,
  ];
  const copies = options.copies ?? 1;
  const actions = [
    ...(options.setupActions ?? []),
    writeOnce,
    openNote,
    ...(options.serverActionsBefore ?? []),
    ...Array.from({ length: copies }, () => invoke),
  ];
  const serverActions = [`0x${actions.length.toString(16)}`, ...actions.flat()];
  const calldata = [
    ...serverActions,
    ...(options.screeningSuffix ?? (options.simulate ? [] : ["0x1"])),
  ];
  const selectedClassHash = options.poolClassHash ?? poolClassHash;
  return {
    call: {
      contractAddress: address(options.pool ?? pool),
      entrypoint: options.entrypoint ?? "apply_actions",
      calldata,
    },
    proof: options.simulate
      ? { data: "", output: [], proof_facts: [] }
      : {
          data: "YQ==",
          output: [selectedClassHash, ...serverActions],
          proof_facts:
            options.proofFacts === undefined
              ? canonicalProofFacts(serverActions, selectedClassHash)
              : [...options.proofFacts],
        },
  };
}

// Synthetic setup targets and ciphertext only. Their shape does not identify a
// token/channel, and these fixtures do not establish authentic proof validity.
const syntheticSetupActions = [
  ["0x0", "0x111", "0x2", "0xabcdef", "0xfedcba"],
  ["0x0", "0x222", "0x1", "0x1"],
] as const;

function setupExitEnvelope(
  signedOptions: Parameters<typeof preparedExit>[3] = {},
  sentinelOptions: Parameters<typeof preparedExit>[3] = {},
): ValidatePreparedExitProofEnvelopeArgs {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  return {
    allowSetup: true,
    pool,
    contract,
    proofBaseBlock,
    kind: PrivateAction.Claim,
    sentinelArgs,
    sentinelPrepared: preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
      simulate: true,
      setupActions: syntheticSetupActions,
      ...sentinelOptions,
    }),
    signedNoteId: "0xdeadbeef",
    signedArgs: exit,
    signedPrepared: preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", {
      setupActions: syntheticSetupActions,
      ...signedOptions,
    }),
  };
}

test("resolved OPEN note is extracted from sentinel and real-signature prepared pool calls", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelSerialized = serializeExit(PrivateAction.Claim, sentinelArgs);
  sentinelSerialized[7] = "0xdeadbeef";
  const sentinelInvoke = ["0xa", address(contract), "0xb", ...sentinelSerialized];
  const sentinelWriteOnce = [
    "0x0",
    noteStorageAddress("0xdeadbeef"),
    "0x2",
    hex(openNotePackedValue),
    address(token),
  ];
  const sentinelOpenNote = [
    "0x7",
    "0xa11d",
    "0xe11e",
    "0xec11",
    address(token),
    "0xdeadbeef",
  ];
  const sentinelPreparedCall = {
    contract_address: address(pool),
    entry_point: "apply_actions",
    calldata: ["0x3", ...sentinelWriteOnce, ...sentinelOpenNote, ...sentinelInvoke, "0x1"],
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

test("proof-envelope validator allows only Ready open-note encryption randomness to change", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
    ephemeralPublicKey: "0x1111",
    encryptedRecipient: "0x2222",
  });
  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", {
    ephemeralPublicKey: "0x3333",
    encryptedRecipient: "0x4444",
  });
  assert.doesNotThrow(() =>
    validatePreparedExitProofEnvelope({
      pool,
      contract,
      proofBaseBlock,
      kind: PrivateAction.Claim,
      sentinelArgs,
      sentinelPrepared,
      signedNoteId: "0xdeadbeef",
      signedArgs: exit,
      signedPrepared,
    }),
  );

  for (const drift of [
    { auditorPublicKey: "0xbad" },
    { openNoteToken: "0x7777" },
    { openNoteId: "0xcafebabe" },
  ]) {
    assert.throws(
      () =>
        validatePreparedExitProofEnvelope({
          pool,
          contract,
          proofBaseBlock,
          kind: PrivateAction.Claim,
          sentinelArgs,
          sentinelPrepared: preparedExit(
            PrivateAction.Claim,
            sentinelArgs,
            "0xdeadbeef",
            { simulate: true },
          ),
          signedNoteId: "0xdeadbeef",
          signedArgs: exit,
          signedPrepared: preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", drift),
        }),
      /open-note|destination|differ at calldata/,
    );
  }
});

test("simulate=true sentinel may omit screening suffix while strict final parsing may not", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const suffixless = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  assert.equal(
    resolveSimulatedPreparedExitNoteId(
      suffixless,
      pool,
      contract,
      PrivateAction.Claim,
      sentinelArgs,
    ),
    "0xdeadbeef",
  );
  assert.throws(
    () =>
      resolvePreparedExitNoteId(
        suffixless.call,
        pool,
        contract,
        PrivateAction.Claim,
        sentinelArgs,
      ),
    /Option::None/,
  );
});

test("fresh-wallet diagnostics expose storage targets and shapes without proof or values", () => {
  const prepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", {
    simulate: true,
    setupActions: [["0x0", "0x111", "0x2", "0xabcdef", "0xfedcba"], ["0x0", "0x222", "0x1", "0x1"]],
  });
  const report = inspectSimulatedExitWrites(prepared);
  assert.deepEqual(report.actionTypes, ["0", "0", "0", "7", "10"]);
  assert.deepEqual((report.writes as { valueLength: number }[]).map((write) => write.valueLength), [2, 1, 2]);
  assert.ok(!JSON.stringify(report).includes("abcdef"));
  assert.ok(!JSON.stringify(report).includes("fedcba"));
  assert.ok(!JSON.stringify(report).includes("deadbeef"));
  assert.throws(() => inspectSimulatedExitWrites(preparedExit(PrivateAction.Claim, exit, "0xdeadbeef")), /simulat|proof/i);
  assert.throws(() => resolveSimulatedPreparedExitNoteId(prepared, pool, contract, PrivateAction.Claim, exit), /must contain exactly/);
});

test("five-action setup prefixes remain rejected for simulated and final claims and cancellations", () => {
  // Synthetic storage and encrypted values only. Widths/booleans, stable targets,
  // and an intact note cannot bind these writes to the note's channel or token.
  const setupActions = [
    ["0x0", "0x111", "0x2", hex(1n << 200n), "0xabc"],
    ["0x0", "0x222", "0x1", "0x1"],
  ];
  for (const kind of [PrivateAction.Claim, PrivateAction.CancelRefund] as const) {
    const args = { ...exit, expected_state: kind === PrivateAction.Claim ? 2n : 1n };
    for (const simulate of [true, false]) {
      const prepared = preparedExit(kind, args, "0xdeadbeef", { setupActions, simulate });
      const resolve = () => simulate
        ? resolveSimulatedPreparedExitNoteId(prepared, pool, contract, kind, args)
        : resolvePreparedExitNoteId(prepared.call, pool, contract, kind, args);
      assert.throws(resolve, /received 5 action\(s\), types \[0, 0, 0, 7, 10\]/);
    }
    // Removing the unrelated prefix, as a separate synthetic fixture rather than
    // editing a real proof-bound response, restores the established boundary.
    const ordinary = preparedExit(kind, args, "0xdeadbeef");
    assert.equal(resolvePreparedExitNoteId(ordinary.call, pool, contract, kind, args), "0xdeadbeef");
  }
});

test("bounded setup candidates require opt-in and preserve the exact signed response", () => {
  for (const kind of [PrivateAction.Claim, PrivateAction.CancelRefund] as const) {
    const signedArgs = { ...exit, expected_state: kind === PrivateAction.Claim ? 2n : 1n };
    const sentinelArgs: ExitArgs = { ...signedArgs, ...PREPARE_SIGNATURE };
    for (const screeningSuffix of [[], ["0x1"]]) {
      const sentinelPrepared = preparedExit(kind, sentinelArgs, "0xdeadbeef", {
        simulate: true,
        screeningSuffix,
        setupActions: syntheticSetupActions,
      });
      const signedPrepared = preparedExit(kind, signedArgs, "0xdeadbeef", {
        setupActions: syntheticSetupActions,
      });
      const originalCall = [...signedPrepared.call.calldata as string[]];
      assert.equal(preparedExitNeedsSetupAuthorization(sentinelPrepared), true);
      assert.equal(preparedExitNeedsSetupAuthorization(signedPrepared), true);
      assert.throws(
        () => resolveSimulatedPreparedExitNoteId(sentinelPrepared, pool, contract, kind, sentinelArgs),
        /must contain exactly/,
      );
      assert.equal(
        resolveSimulatedPreparedExitNoteId(sentinelPrepared, pool, contract, kind, sentinelArgs, { allowSetup: true }),
        "0xdeadbeef",
      );
      const input = {
        pool, contract, proofBaseBlock, kind, sentinelArgs, sentinelPrepared,
        signedNoteId: "0xdeadbeef", signedArgs, signedPrepared,
      };
      assert.throws(() => validatePreparedExitProofEnvelope(input), /must contain exactly/);
      assert.throws(
        () => validatePreparedExitProofEnvelope({ ...input, allowSetup: false }),
        /must contain exactly/,
      );
      const submission = bindDappSubmittedPreparedExit({ ...input, allowSetup: true });
      assert.equal(submission.noteId, "0xdeadbeef");
      assert.equal(submission.prepared, signedPrepared);
      assert.equal(assertExactDappSubmittedPreparedExit(submission, signedPrepared), signedPrepared);
      assert.deepEqual(signedPrepared.call.calldata, originalCall);
      assert.equal(Object.isFrozen(signedPrepared.call.calldata), true);
      assert.equal(Object.isFrozen(signedPrepared.proof.output), true);
      assert.throws(
        () => assertExactDappSubmittedPreparedExit(submission, structuredClone(signedPrepared)),
        /rebuilt response/,
      );
    }
  }
  for (const simulate of [true, false]) {
    assert.equal(
      preparedExitNeedsSetupAuthorization(preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", { simulate })),
      false,
    );
  }
  assert.doesNotThrow(() => validatePreparedExitProofEnvelope(setupExitEnvelope({ setupActions: [] }, { setupActions: [] })));
});

test("setup salt and ciphertext may change while setup targets and exact exit stay fixed", () => {
  const input = setupExitEnvelope({
    setupActions: [
      ["0x0", "0x111", "0x2", hex(1n << 200n), "0x0"],
      ["0x0", "0x222", "0x1", "0x1"],
    ],
    ephemeralPublicKey: "0x3333",
    encryptedRecipient: "0x4444",
  });
  assert.equal(validatePreparedExitProofEnvelope(input).prepared, input.signedPrepared);

  for (const setupActions of [
    [["0x0", "0x112", "0x2", "0xa", "0xb"], syntheticSetupActions[1]],
    [syntheticSetupActions[0], ["0x0", "0x223", "0x1", "0x1"]],
  ]) {
    assert.throws(
      () => validatePreparedExitProofEnvelope(setupExitEnvelope({ setupActions })),
      /differ at calldata/,
    );
  }
  for (const [signedOptions, sentinelOptions] of [
    [{ setupActions: [] }, {}],
    [{}, { setupActions: [] }],
  ] as const) {
    assert.throws(
      () => validatePreparedExitProofEnvelope(setupExitEnvelope(signedOptions, sentinelOptions)),
      /layouts differ/,
    );
  }
});

test("opt-in rejects malformed setup widths, salts, booleans and out-of-range felts", () => {
  const invalidSetupActions = [
    [["0x0", "0x111", "0x0"], syntheticSetupActions[1]],
    [["0x0", "0x111", "0x1", "0xa"], syntheticSetupActions[1]],
    [["0x0", "0x111", "0x3", "0xa", "0xb", "0xc"], syntheticSetupActions[1]],
    [["0x0", "0x111", "0x2", "0x0", "0xb"], syntheticSetupActions[1]],
    [syntheticSetupActions[0], ["0x0", "0x222", "0x0"]],
    [syntheticSetupActions[0], ["0x0", "0x222", "0x2", "0x1", "0x1"]],
    [syntheticSetupActions[0], ["0x0", "0x222", "0x1", "0x0"]],
    [syntheticSetupActions[0], ["0x0", "0x222", "0x1", "0x2"]],
    [["0x0", "0x111", "0x2", hex(constants.PRIME), "0xb"], syntheticSetupActions[1]],
    [["0x0", "0x111", "0x2", "0xa", hex(constants.PRIME)], syntheticSetupActions[1]],
    [["0x0", "0x111", "0x2", "-1", "0xb"], syntheticSetupActions[1]],
  ];
  for (const setupActions of invalidSetupActions) {
    const input = setupExitEnvelope({ setupActions });
    assert.throws(() => validatePreparedExitProofEnvelope(input), /setup|Stark field|non-negative/);
    assert.throws(() => preparedExitNeedsSetupAuthorization(input.signedPrepared), /setup|Stark field|non-negative/);
  }
});

test("opt-in enforces nonzero storage bases and disjoint occupied setup/note slots", () => {
  const noteBase = BigInt(noteStorageAddress("0xdeadbeef"));
  const invalidTargets = [
    [0n, 0x222n],
    [0x111n, 0n],
    [constants.ADDR_BOUND, 0x222n],
    [0x111n, constants.ADDR_BOUND],
    [constants.PRIME, 0x222n],
    [0x111n, constants.PRIME],
    [0x111n, 0x111n],
    [0x111n, 0x112n],
    [noteBase, 0x222n],
    [noteBase - 1n, 0x222n],
    [noteBase + 1n, 0x222n],
    [0x111n, noteBase],
    [0x111n, noteBase + 1n],
  ] as const;
  for (const [firstBase, secondBase] of invalidTargets) {
    const setupActions = [
      ["0x0", hex(firstBase), "0x2", "0xa", "0xb"],
      ["0x0", hex(secondBase), "0x1", "0x1"],
    ];
    assert.throws(
      () => validatePreparedExitProofEnvelope(setupExitEnvelope({ setupActions }, { setupActions })),
      /storage|overlap|Stark field/,
    );
  }
  // Cairo restricts the base to ADDR_BOUND; the small offset may extend past it.
  const lastValidBase = [
    ["0x0", hex(constants.ADDR_BOUND - 1n), "0x2", "0xa", "0xb"],
    syntheticSetupActions[1],
  ];
  assert.doesNotThrow(() => validatePreparedExitProofEnvelope(setupExitEnvelope(
    { setupActions: lastValidBase }, { setupActions: lastValidBase },
  )));

  for (const name of ["auditor_public_key", "screener_public_key", "fee_amount", "fee_collector", "proof_validity_blocks"]) {
    const slot = hash.starknetKeccak(name);
    for (const [firstBase, secondBase] of [[slot - 1n, 0x222n], [0x111n, slot]]) {
      const setupActions = [
        ["0x0", hex(firstBase!), "0x2", "0xa", "0xb"],
        ["0x0", hex(secondBase!), "0x1", "0x1"],
      ];
      assert.throws(
        () => validatePreparedExitProofEnvelope(setupExitEnvelope({ setupActions }, { setupActions })),
        /known pool configuration storage/,
      );
    }
  }
});

test("opt-in rejects extra actions, action reordering and every non-exit action type", () => {
  const rejectedOptions: NonNullable<Parameters<typeof preparedExit>[3]>[] = [
    { setupActions: [syntheticSetupActions[0]] },
    { setupActions: [...syntheticSetupActions, syntheticSetupActions[1]] },
    { setupActions: [...syntheticSetupActions, ...syntheticSetupActions] },
    { setupActions: [syntheticSetupActions[1], syntheticSetupActions[0]] },
    { setupActions: [], serverActionsBefore: syntheticSetupActions },
    { copies: 2 },
    { serverActionsBefore: [["0x3", address(account), address(token), "0x1"]] },
    { serverActionsBefore: [["0x0", "0x333", "0x1", "0x1"]] },
  ];
  for (const options of rejectedOptions) {
    assert.throws(
      () => validatePreparedExitProofEnvelope(setupExitEnvelope(options)),
      /must contain exactly|setup/,
    );
  }
  for (const replacement of [
    ["0x1", "0x111", "0x222", "0x333", "0x444"],
    ["0x2", "0x111", token, "0x1"],
    ["0x3", "0x111", token, "0x1"],
    ["0x4", "0x111", "0x222", "0x333", "0x444", "0x555"],
    ["0x5", "0x111", "0x222", "0x333", account, token, "0x1"],
    ["0x6", "0x111", token, "0x1"],
    ["0x7", "0x111", "0x222", "0x333", token, "0x444"],
    ["0x8", "0x111", "0x222"],
    ["0x9", "0x111"],
    ["0xa", contract, "0x0"],
    ["0xb", contract, "0x0"],
    ["0xc"],
  ]) {
    assert.throws(
      () => validatePreparedExitProofEnvelope(setupExitEnvelope({
        setupActions: [replacement, syntheticSetupActions[1]],
      })),
      /must contain exactly|unknown prepared pool ServerAction/,
    );
  }
});

test("opt-in keeps destination, token, amount, invoke, screening and proof checks", () => {
  for (const options of [
    { pool: "0x7777" },
    { target: "0x7777" },
    { entrypoint: "compile_actions" },
    { openNoteId: "0xcafebabe" },
    { openNoteToken: "0x7777" },
    { writeOnceStorage: "0x7777" },
    { writeOncePackedValue: "0x0" },
    { writeOnceToken: "0x7777" },
    { auditorPublicKey: "0xbad" },
    { screeningSuffix: [] },
    { screeningSuffix: ["0x0"] },
    { screeningSuffix: ["0x1", "0x1"] },
    { poolClassHash: "0x123" },
    { proofFacts: ["0x2"] },
  ]) {
    assert.throws(() => validatePreparedExitProofEnvelope(setupExitEnvelope(options)));
  }

  for (let index = 0; index < 11; index += 1) {
    const input = setupExitEnvelope();
    const calldata = input.signedPrepared.call.calldata as string[];
    const invokeStart = calldata.length - 1 - 11;
    calldata[invokeStart + index] = hex(BigInt(calldata[invokeStart + index]!) + 1n);
    assert.throws(
      () => validatePreparedExitProofEnvelope(input),
      /differs at calldata|destination/,
    );
  }

  for (const mutate of [
    (prepared: PreparedCallAndProof) => { prepared.proof.data = "not-base64"; },
    (prepared: PreparedCallAndProof) => { prepared.proof.data = ""; },
    (prepared: PreparedCallAndProof) => { prepared.proof.output[5] = "0x123"; },
    (prepared: PreparedCallAndProof) => { prepared.proof.proof_facts[8] = "0x123"; },
    (prepared: PreparedCallAndProof) => { prepared.proof.proof_facts[4] = "0x1"; },
    (prepared: PreparedCallAndProof) => { prepared.proof.proof_facts[5] = "0x1"; },
    // Setup randomness may differ across prepares, but final output must bind it.
    (prepared: PreparedCallAndProof) => { (prepared.call.calldata as string[])[5] = "0x123"; },
  ]) {
    const input = setupExitEnvelope();
    mutate(input.signedPrepared);
    assert.throws(() => validatePreparedExitProofEnvelope(input), /proof|base64/);
  }
});

test("setup classification rejects malformed simulation proofs and final suffixes", () => {
  const unexpectedSentinelProof = setupExitEnvelope().sentinelPrepared;
  unexpectedSentinelProof.proof.output = ["0x1"];
  assert.throws(() => preparedExitNeedsSetupAuthorization(unexpectedSentinelProof), /empty simulate=true proof/);
  for (const options of [
    { screeningSuffix: [] },
    { screeningSuffix: ["0x0"] },
    { pool: "0x7777" },
    { entrypoint: "compile_actions" },
    { openNoteId: "0xcafebabe" },
  ]) {
    assert.throws(() => preparedExitNeedsSetupAuthorization(setupExitEnvelope(options).signedPrepared));
  }
});

test("prepared exits require the exact source-faithful open-note action shape", () => {
  const invalidOptions = [
    { writeOnceStorage: "0x4455" },
    { writeOncePackedValue: "0x0" },
    { writeOnceToken: "0x7777" },
  ] as const;
  for (const options of invalidOptions) {
    assert.throws(
      () =>
        resolvePreparedExitNoteId(
          preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", options).call,
          pool,
          contract,
          PrivateAction.Claim,
          exit,
        ),
      /WriteOnce/,
    );
  }

  for (const extraAction of [
    ["0x0", noteStorageAddress("0xcafe"), "0x2", hex(openNotePackedValue), address(token)],
    ["0x1", "0x111", "0x222", "0x333", "0x444"],
  ]) {
    assert.throws(
      () =>
        resolvePreparedExitNoteId(
          preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", {
            serverActionsBefore: [extraAction],
          }).call,
          pool,
          contract,
          PrivateAction.Claim,
          exit,
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /must contain exactly/);
        assert.match(error.message, /received 4 action\(s\), types \[0, 7, [01], 10\]/);
        assert.ok(!error.message.includes("0xdeadbeef"));
        assert.ok(!error.message.includes("0xcafe"));
        return true;
      },
    );
  }

  assert.throws(
    () =>
      resolvePreparedExitNoteId(
        preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", {
          screeningSuffix: ["0x0", "0x1", "0x2", "0x3"],
        }).call,
        pool,
        contract,
        PrivateAction.Claim,
        exit,
      ),
    /Option::None/,
  );
});

test("final proof pins the pool class and canonical ProofFacts message", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  const validate = (signedPrepared: PreparedCallAndProof) =>
    validatePreparedExitProofEnvelope({
      pool,
      contract,
      proofBaseBlock,
      kind: PrivateAction.Claim,
      sentinelArgs,
      sentinelPrepared,
      signedNoteId: "0xdeadbeef",
      signedArgs: exit,
      signedPrepared,
    });

  assert.throws(
    () => validate(preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", { poolClassHash: "0x123" })),
    /different privacy-pool class hash/,
  );
  assert.throws(
    () =>
      validate(
        preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", {
          proofFacts: ["0x2"],
        }),
      ),
    /canonical nine-felt layout/,
  );
  for (const invalidBase64 of ["not-base64", "YR==", "YWJ="]) {
    assert.throws(
      () => {
        const malformed = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
        malformed.proof.data = invalidBase64;
        return validate(malformed);
      },
      /canonical standard base64/,
    );
  }

  for (const [index, value] of [[4, "0x1"], [5, "0xdead"]] as const) {
    const wrongBlock = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
    wrongBlock.proof.proof_facts[index] = value;
    assert.throws(() => validate(wrongBlock), new RegExp(`proof facts differ at field\\[${index}\\]`));
  }

  const wrongMessage = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  wrongMessage.proof.proof_facts[8] = "0x123";
  assert.throws(() => validate(wrongMessage), /proof facts differ at field\[8\]/);

  const verifierUpgradeMetadata = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  verifierUpgradeMetadata.proof.proof_facts[0] = "0x50524f4f4631";
  verifierUpgradeMetadata.proof.proof_facts[2] = "0x123456";
  verifierUpgradeMetadata.proof.proof_facts[6] = "0x654321";
  assert.equal(validate(verifierUpgradeMetadata).noteId, "0xdeadbeef");
});

test("dApp-submitted route binds the signed note to the exact PrepareInvoke response", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  const submission = bindDappSubmittedPreparedExit({
    pool,
    contract,
    proofBaseBlock,
    kind: PrivateAction.Claim,
    sentinelArgs,
    sentinelPrepared,
    signedNoteId: "0xdeadbeef",
    signedArgs: exit,
    signedPrepared,
  });

  assert.equal(submission.noteId, "0xdeadbeef");
  assert.equal(assertExactDappSubmittedPreparedExit(submission, signedPrepared), signedPrepared);
  assert.throws(
    () =>
      assertExactDappSubmittedPreparedExit(submission, {
        call: {
          ...signedPrepared.call,
          calldata: Array.from(signedPrepared.call.calldata as string[]),
        },
        proof: signedPrepared.proof,
      }),
    /rebuilt response/,
  );
});

test("prepared proof-envelope validation rejects note drift and non-placeholder calldata", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  assert.throws(
    () =>
      validatePreparedExitProofEnvelope({
        pool,
        contract,
        proofBaseBlock,
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
      validatePreparedExitProofEnvelope({
        pool,
        contract,
        proofBaseBlock,
        kind: PrivateAction.Claim,
        sentinelArgs,
        sentinelPrepared,
        signedNoteId: "0xdeadbeef",
        signedArgs: exit,
        signedPrepared,
      }),
    /must contain exactly/,
  );
});

test("final proof output must be the prepared call's exact ServerAction prefix", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  signedPrepared.proof.output[5] = "0xdead";

  assert.throws(
    () =>
      validatePreparedExitProofEnvelope({
        pool,
        contract,
        proofBaseBlock,
        kind: PrivateAction.Claim,
        sentinelArgs,
        sentinelPrepared,
        signedNoteId: "0xdeadbeef",
        signedArgs: exit,
        signedPrepared,
      }),
    /proof output differs at ServerActions/,
  );
});

test("simulated proof cannot validate and a dApp-submitted response is deeply immutable", () => {
  const sentinelArgs: ExitArgs = { ...exit, ...PREPARE_SIGNATURE };
  const sentinelPrepared = preparedExit(PrivateAction.Claim, sentinelArgs, "0xdeadbeef", {
    simulate: true,
  });
  const simulatedFinal = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef", {
    simulate: true,
    screeningSuffix: ["0x1"],
  });
  assert.throws(
    () =>
      validatePreparedExitProofEnvelope({
        pool,
        contract,
        proofBaseBlock,
        kind: PrivateAction.Claim,
        sentinelArgs,
        sentinelPrepared,
        signedNoteId: "0xdeadbeef",
        signedArgs: exit,
        signedPrepared: simulatedFinal,
      }),
    /non-empty STRK20 proof envelope/,
  );

  const signedPrepared = preparedExit(PrivateAction.Claim, exit, "0xdeadbeef");
  const submission = bindDappSubmittedPreparedExit({
    pool,
    contract,
    proofBaseBlock,
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
  assert.equal(assertExactDappSubmittedPreparedExit(submission, signedPrepared), signedPrepared);
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
    /must contain exactly/,
  );
  assert.throws(
    () => resolvePreparedExitNoteId(prepared.call, "0x7777", contract, PrivateAction.Claim, exit),
    /locked canonical mainnet privacy pool/,
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
