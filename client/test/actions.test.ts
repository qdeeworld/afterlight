import assert from "node:assert/strict";
import { test } from "node:test";

import type { STRK20_ACTION } from "@starknet-io/types-js";
import { constants, ec, hash, shortString } from "starknet";

import {
  address,
  assertExactDappSubmittedPreparedExit,
  assertNoSelfWithdraw,
  bindDappSubmittedPreparedExit,
  buildCancelRefundActions,
  buildClaimActions,
  buildFundActions,
  CANONICAL_STRK20_POOL,
  OPEN_NOTE_PLACEHOLDER,
  PINNED_STRK20_POOL_CLASS_HASH,
  PREPARE_SIGNATURE,
  PrivateAction,
  resolvePreparedExitNoteId,
  resolveSimulatedPreparedExitNoteId,
  serializeExit,
  validatePreparedExitProofEnvelope,
  type ExitArgs,
  type FundArgs,
  type PreparedCallAndProof,
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
    shortString.encodeShortString("PROOF0"),
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
      /must contain exactly/,
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
