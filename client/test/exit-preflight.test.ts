import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import type { STRK20_ACTION } from "@starknet-io/types-js";
import { constants, ec, hash, shortString } from "starknet";

import {
  address,
  CANONICAL_STRK20_POOL,
  LocalStarkKey,
  OPEN_NOTE_PLACEHOLDER,
  PINNED_STRK20_POOL_CLASS_HASH,
  PrivateAction,
  PrivateExitPreflight,
  STARKNET_MAINNET_CHAIN_ID,
  verifyRoleSignature,
  type AcceptedMainnetBlock,
  type ClaimExitPreflightInput,
  type PreparedCallAndProof,
  type ReadMainnetBlockPort,
  type WalletBoundary,
} from "../src/index.js";
import {
  constants as narrowConstants,
  ec as narrowEc,
  hash as narrowHash,
  shortString as narrowShortString,
} from "../tools/starknet-narrow.js";

const contract = "0x1234";
const token = "0x5678";
const account = "0x9999";
const noteId = "0xdeadbeef";
const pool = CANONICAL_STRK20_POOL;
const poolClassHash = PINNED_STRK20_POOL_CLASS_HASH;
const proofBlockNumber = "0xd3a000";
const proofBlockHash = "0x123456";
const testNow = 1_787_707_800n;
const mainnetChainId = 0x534e5f4d41494en;
const strkToken = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn;
const openNotePackedValue = 1n << 128n;
const virtualProgramHash =
  0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473n;

function claimInput(rolePublicKey: string): ClaimExitPreflightInput {
  return Object.freeze({
    mode: "live-funded",
    kind: PrivateAction.Claim,
    expectedReadyAccount: account,
    openNoteRecipient: account,
    chainId: STARKNET_MAINNET_CHAIN_ID,
    pool,
    contract,
    vaultId: "0xabc",
    token,
    amount: 10n ** 19n,
    expectedState: 2n,
    expectedEpoch: 2n,
    expectedNonce: 2n,
    rolePublicKey,
    validUntil: testNow + 600n,
    requestedAt: testNow - 100n,
    claimAfter: testNow - 10n,
  });
}

function cancelInput(rolePublicKey: string) {
  const claim = claimInput(rolePublicKey);
  return Object.freeze({
    mode: claim.mode,
    kind: PrivateAction.CancelRefund,
    expectedReadyAccount: claim.expectedReadyAccount,
    openNoteRecipient: claim.openNoteRecipient,
    chainId: claim.chainId,
    pool: claim.pool,
    contract: claim.contract,
    vaultId: claim.vaultId,
    token: claim.token,
    amount: claim.amount,
    expectedState: 1n,
    expectedEpoch: 1n,
    expectedNonce: 1n,
    rolePublicKey: claim.rolePublicKey,
    validUntil: claim.validUntil,
  } as const);
}

function boundary(accountOverride: string = account, chainOverride: string = STARKNET_MAINNET_CHAIN_ID) {
  return Object.freeze({ account: accountOverride, chainId: chainOverride });
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function noteStorageAddress(resolvedNoteId: string): string {
  const raw = BigInt(hash.computePedersenHash(hash.starknetKeccak("notes"), resolvedNoteId));
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
    proofBlockNumber,
    proofBlockHash,
    String(configHash),
    "0x1",
    hex(messageHash),
  ];
}

function preparedFromActions(
  actions: readonly STRK20_ACTION[],
  simulate: boolean,
  options: Readonly<{
    proofFactsLength?: number;
    preparedNoteId?: string;
  }> = {},
): PreparedCallAndProof {
  assert.equal(actions.length, 2);
  const transfer = actions[0];
  const invoke = actions[1];
  assert.equal(transfer?.type, "transfer");
  assert.equal(invoke?.type, "invoke");
  if (transfer?.type !== "transfer" || invoke?.type !== "invoke") {
    throw new Error("fixture expected one transfer and one invoke");
  }
  const resolvedNoteId = options.preparedNoteId ?? noteId;
  const helperCalldata = invoke.calldata.map((entry) =>
    entry === OPEN_NOTE_PLACEHOLDER ? resolvedNoteId : entry,
  );
  const writeOnce = [
    "0x0",
    noteStorageAddress(resolvedNoteId),
    "0x2",
    hex(openNotePackedValue),
    address(transfer.token),
  ];
  const openNote = [
    "0x7",
    "0xa11d",
    simulate ? "0xe11e" : "0xe22e",
    simulate ? "0xec11" : "0xec22",
    address(transfer.token),
    resolvedNoteId,
  ];
  const helperInvoke = [
    "0xa",
    address(invoke.contract),
    `0x${helperCalldata.length.toString(16)}`,
    ...helperCalldata,
  ];
  const actionsCalldata = ["0x3", ...writeOnce, ...openNote, ...helperInvoke];
  const calldata = simulate ? actionsCalldata : [...actionsCalldata, "0x1"];
  const allProofFacts = canonicalProofFacts(actionsCalldata, poolClassHash);
  const proofFacts = allProofFacts.slice(0, options.proofFactsLength ?? allProofFacts.length);
  return {
    call: {
      contractAddress: pool,
      entrypoint: "apply_actions",
      calldata,
    },
    proof: simulate
      ? { data: "", output: [], proof_facts: [] }
      : {
          data: "YQ==",
          output: [poolClassHash, ...actionsCalldata],
          proof_facts: proofFacts,
        },
  };
}

function acceptedBlock(overrides: Partial<AcceptedMainnetBlock> = {}): AcceptedMainnetBlock {
  return Object.freeze({
    chainId: STARKNET_MAINNET_CHAIN_ID,
    number: proofBlockNumber,
    hash: proofBlockHash,
    status: "ACCEPTED_ON_L2",
    ...overrides,
  });
}

function reader(
  id: string,
  endpoint: string,
  order: string[],
  block: AcceptedMainnetBlock = acceptedBlock(),
  operator: string = id,
): ReadMainnetBlockPort {
  return Object.freeze({
    providerId: id,
    endpointId: endpoint,
    operatorId: operator,
    async readAcceptedBlock(number: string) {
      order.push(`rpc:${id}:${number}`);
      return block;
    },
  });
}

function harness(
  options: Readonly<{
    proofFactsLength?: number;
    changeBoundaryAfterPrepare?: Readonly<{ simulate: boolean; boundary: WalletBoundary }>;
    rejectBoundaryReadAt?: number;
  }> = {},
) {
  const order: string[] = [];
  let observedBoundary: WalletBoundary = boundary();
  let boundaryReadCount = 0;
  const preparePort = {
    async readBoundary() {
      boundaryReadCount += 1;
      order.push("boundary");
      if (boundaryReadCount === options.rejectBoundaryReadAt) {
        throw new Error("silent Ready account read failed");
      }
      return observedBoundary;
    },
    async prepare(actions: readonly STRK20_ACTION[], simulate: boolean) {
      order.push(`prepare:${String(simulate)}`);
      const prepared = preparedFromActions(actions, simulate, options);
      if (options.changeBoundaryAfterPrepare?.simulate === simulate) {
        observedBoundary = options.changeBoundaryAfterPrepare.boundary;
      }
      return prepared;
    },
  };
  const readers = [
    reader("lava", "rpc.lava.build", order),
    reader("zan", "api.zan.top", order),
  ];
  return {
    order,
    preparePort,
    readers,
    setBoundary(next: WalletBoundary) {
      observedBoundary = next;
    },
  };
}

test("preflight enforces sentinel, signature, final proof, then two exact accepted block reads", async () => {
  const role = LocalStarkKey.generate();
  try {
    const fixture = harness();
    const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
    const sentinel = await preflight.prepareSentinel(claimInput(role.publicKey));
    assert.deepEqual(fixture.order, ["boundary", "prepare:true", "boundary"]);
    assert.equal(sentinel.evidenceLevel, "E1");
    assert.equal(sentinel.sentinelSimulated, true);
    assert.match(sentinel.noteIdDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(sentinel).includes(noteId), false);
    assert.equal(preflight.hasActiveSentinel, true);

    const signature = role.sign(sentinel.authorizationHash);
    const result = await preflight.complete(signature);
    assert.deepEqual(fixture.order, [
      "boundary",
      "prepare:true",
      "boundary",
      "boundary",
      "prepare:false",
      "boundary",
      `rpc:lava:${proofBlockNumber}`,
      `rpc:zan:${proofBlockNumber}`,
      "boundary",
    ]);
    assert.deepEqual(result, {
      evidence: "AFTERLIGHT_PRIVATE_EXIT_PREFLIGHT_E1",
      evidenceLevel: "E1",
      operation: "CLAIM",
      mode: "live-funded",
      readyAccount: "0x00000000…00009999",
      authorizationHash: sentinel.authorizationHash,
      noteIdDigest: sentinel.noteIdDigest,
      preparedDigest: result.preparedDigest,
      proofFactsCount: 9,
      proofBaseBlock: { number: proofBlockNumber, hash: proofBlockHash },
      rpcProviders: ["lava", "zan"],
      rpcOperators: ["lava", "zan"],
      applicationSignatureVerified: true,
      walletTransactionSigned: false,
      submitted: false,
      retainedPreparedResponse: false,
    });
    assert.match(result.preparedDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(preflight.hasActiveSentinel, false);
    const redacted = JSON.stringify(result);
    assert.equal(redacted.includes(noteId), false);
    assert.equal(redacted.includes("YQ=="), false);
    assert.equal("prepared" in result, false);
    assert.equal("proof" in result, false);
  } finally {
    role.destroy();
  }
});

test("Cairo x-coordinate signature verification accepts the correct parity only", () => {
  const role = LocalStarkKey.generate();
  const wrongRole = LocalStarkKey.generate();
  try {
    const message = "0x123456";
    const signature = role.sign(message);
    assert.equal(verifyRoleSignature(message, role.publicKey, signature), true);
    assert.equal(verifyRoleSignature(message, wrongRole.publicKey, signature), false);
    assert.equal(verifyRoleSignature("0x123457", role.publicKey, signature), false);
    assert.equal(verifyRoleSignature(message, role.publicKey, { sig_r: "0x1", sig_s: "0x1" }), false);
  } finally {
    role.destroy();
    wrongRole.destroy();
  }
});

test("cancel/refund uses the owner-key authorization domain and remains E1-only", async () => {
  const owner = LocalStarkKey.generate();
  try {
    const fixture = harness();
    const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
    const sentinel = await preflight.prepareSentinel(cancelInput(owner.publicKey));
    assert.equal(sentinel.operation, "CANCEL_REFUND");
    const result = await preflight.complete(owner.sign(sentinel.authorizationHash));
    assert.equal(result.operation, "CANCEL_REFUND");
    assert.equal(result.evidenceLevel, "E1");
    assert.equal(result.submitted, false);
  } finally {
    owner.destroy();
  }
});

test("narrow browser cryptography shim matches every validator primitive it replaces", () => {
  const values = [1n, 2n, 3n, 0x123456n];
  assert.equal(narrowConstants.PRIME, constants.PRIME);
  assert.equal(narrowConstants.ADDR_BOUND, constants.ADDR_BOUND);
  assert.equal(
    narrowShortString.encodeShortString("StarknetOsConfig3"),
    shortString.encodeShortString("StarknetOsConfig3"),
  );
  assert.equal(narrowHash.starknetKeccak("notes"), hash.starknetKeccak("notes"));
  assert.equal(
    narrowHash.computePedersenHash(values[0]!, values[1]!),
    hash.computePedersenHash(values[0]!, values[1]!),
  );
  assert.equal(
    String(narrowHash.computeHashOnElements(values)),
    String(hash.computeHashOnElements(values)),
  );
  assert.equal(
    narrowHash.computePoseidonHashOnElements(values),
    hash.computePoseidonHashOnElements(values),
  );
  assert.equal(narrowEc.starkCurve, ec.starkCurve);
});

test("wrong application signature stops before the final non-simulated prepare", async () => {
  const role = LocalStarkKey.generate();
  const wrongRole = LocalStarkKey.generate();
  try {
    const fixture = harness();
    const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
    const sentinel = await preflight.prepareSentinel(claimInput(role.publicKey));
    await assert.rejects(
      preflight.complete(wrongRole.sign(sentinel.authorizationHash)),
      /does not verify/,
    );
    assert.deepEqual(fixture.order, ["boundary", "prepare:true", "boundary", "boundary"]);
    assert.equal(preflight.hasActiveSentinel, true);
  } finally {
    role.destroy();
    wrongRole.destroy();
  }
});

test("account and network changes each invalidate the sentinel", async () => {
  for (const changed of [boundary("0x8888"), boundary(account, "0x534e5f5345504f4c4941")]) {
    const role = LocalStarkKey.generate();
    try {
      const fixture = harness();
      const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
      const sentinel = await preflight.prepareSentinel(claimInput(role.publicKey));
      assert.equal(preflight.observeWalletBoundary(changed), false);
      assert.equal(preflight.hasActiveSentinel, false);
      await assert.rejects(
        preflight.complete(role.sign(sentinel.authorizationHash)),
        /no active exit sentinel/,
      );
      assert.deepEqual(fixture.order, ["boundary", "prepare:true", "boundary"]);
    } finally {
      role.destroy();
    }
  }
});

test("expected Ready account must be the open-note recipient before any prepare", async () => {
  const role = LocalStarkKey.generate();
  try {
    const fixture = harness();
    const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
    await assert.rejects(
      preflight.prepareSentinel({ ...claimInput(role.publicKey), openNoteRecipient: "0x7777" }),
      /must equal the open-note recipient/,
    );
    assert.deepEqual(fixture.order, []);
  } finally {
    role.destroy();
  }
});

test("exit operation, funded state, nonce, epoch, and validity window fail before wallet access", async () => {
  const role = LocalStarkKey.generate();
  try {
    const fixture = harness();
    const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
    for (const [input, message] of [
      [{ ...claimInput(role.publicKey), expectedState: 1n }, /requires expected GRACE/],
      [{ ...claimInput(role.publicKey), expectedEpoch: 0n }, /requested vault epoch/],
      [{ ...claimInput(role.publicKey), expectedNonce: 0n }, /successor nonce/],
      [{ ...cancelInput(role.publicKey), expectedState: 2n }, /requires expected ACTIVE/],
      [{ ...cancelInput(role.publicKey), expectedEpoch: 0n }, /funded vault epoch/],
      [{ ...cancelInput(role.publicKey), expectedNonce: 0n }, /owner nonce/],
      [{ ...claimInput(role.publicKey), validUntil: testNow }, /remain valid/],
      [
        { ...claimInput(role.publicKey), validUntil: testNow + 901n },
        /exceeds the locked 900-second/,
      ],
    ] as const) {
      await assert.rejects(preflight.prepareSentinel(input), message);
    }
    assert.deepEqual(fixture.order, []);
  } finally {
    role.destroy();
  }
});

test("a silent account change during final Prepare invalidates before RPC validation", async () => {
  const role = LocalStarkKey.generate();
  try {
    const fixture = harness({
      changeBoundaryAfterPrepare: { simulate: false, boundary: boundary("0x8888") },
    });
    const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
    const sentinel = await preflight.prepareSentinel(claimInput(role.publicKey));
    await assert.rejects(
      preflight.complete(role.sign(sentinel.authorizationHash)),
      /account or network changed/,
    );
    assert.equal(preflight.hasActiveSentinel, false);
    assert.deepEqual(fixture.order, [
      "boundary",
      "prepare:true",
      "boundary",
      "boundary",
      "prepare:false",
      "boundary",
    ]);
  } finally {
    role.destroy();
  }
});

test("a failed direct post-Prepare account read fails closed", async () => {
  const role = LocalStarkKey.generate();
  try {
    const fixture = harness({ rejectBoundaryReadAt: 2 });
    const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
    await assert.rejects(
      preflight.prepareSentinel(claimInput(role.publicKey)),
      /silent Ready account read failed/,
    );
    assert.equal(preflight.hasActiveSentinel, false);
    assert.deepEqual(fixture.order, ["boundary", "prepare:true", "boundary"]);
  } finally {
    role.destroy();
  }
});

test("live/funded mode requires two distinct endpoint and declared operator identities", async () => {
  const role = LocalStarkKey.generate();
  try {
    const fixture = harness();
    const oneReader = new PrivateExitPreflight(
      fixture.preparePort,
      [fixture.readers[0]!],
      () => testNow,
    );
    await assert.rejects(
      oneReader.prepareSentinel(claimInput(role.publicKey)),
      /requires two declared-independent/,
    );
    assert.throws(
      () =>
        new PrivateExitPreflight(
          fixture.preparePort,
          [
            reader("one", "same.example", fixture.order),
            reader("two", "same.example", fixture.order),
          ],
          () => testNow,
        ),
      /distinct endpoint and operator identities/,
    );
    assert.throws(
      () =>
        new PrivateExitPreflight(
          fixture.preparePort,
          [
            reader("one", "one.example", fixture.order, acceptedBlock(), "same-operator"),
            reader("two", "two.example", fixture.order, acceptedBlock(), "same-operator"),
          ],
          () => testNow,
        ),
      /distinct endpoint and operator identities/,
    );
  } finally {
    role.destroy();
  }
});

test("proof facts must be exactly nine before independent block reads", async () => {
  const role = LocalStarkKey.generate();
  try {
    const fixture = harness({ proofFactsLength: 8 });
    const preflight = new PrivateExitPreflight(fixture.preparePort, fixture.readers, () => testNow);
    const sentinel = await preflight.prepareSentinel(claimInput(role.publicKey));
    await assert.rejects(
      preflight.complete(role.sign(sentinel.authorizationHash)),
      /exactly nine/,
    );
    assert.deepEqual(fixture.order, [
      "boundary",
      "prepare:true",
      "boundary",
      "boundary",
      "prepare:false",
      "boundary",
    ]);
    assert.equal(preflight.hasActiveSentinel, false);
  } finally {
    role.destroy();
  }
});

test("independent RPC block hash, number, chain and accepted status are exact", async () => {
  const failures: ReadonlyArray<readonly [AcceptedMainnetBlock, RegExp]> = [
    [acceptedBlock({ hash: "0x999" }), /different proof base block hash/],
    [acceptedBlock({ number: "0xd3a001" }), /different proof base block number/],
    [acceptedBlock({ chainId: "0x534e5f5345504f4c4941" }), /not connected to Starknet Mainnet/],
    [
      acceptedBlock({ status: "PENDING" as AcceptedMainnetBlock["status"] }),
      /not accepted/,
    ],
  ];
  for (const [badBlock, message] of failures) {
    const role = LocalStarkKey.generate();
    try {
      const fixture = harness();
      const readers = [
        reader("bad", "bad.example", fixture.order, badBlock),
        reader("good", "good.example", fixture.order),
      ];
      const preflight = new PrivateExitPreflight(fixture.preparePort, readers, () => testNow);
      const sentinel = await preflight.prepareSentinel(claimInput(role.publicKey));
      await assert.rejects(
        preflight.complete(role.sign(sentinel.authorizationHash)),
        message,
      );
      assert.equal(preflight.hasActiveSentinel, false);
    } finally {
      role.destroy();
    }
  }
});

test("dedicated browser bundle contains no remote loader, persistence, signing, or submission API", async () => {
  const bundle = await readFile(new URL("../../tools/private-exit-preflight.js", import.meta.url), "utf8");
  for (const forbidden of [
    "wallet_strk20InvokeTransaction",
    "wallet_addInvokeTransaction",
    "wallet_signTypedData",
    "strk20InvokeTransaction",
    "executeWithProof",
    ".execute(",
    "addInvokeTransaction",
    "sendTransaction",
    "broadcastTransaction",
    "snaps.consensys.io",
    "remoteEntry.js",
    "new Function",
    "localStorage",
    "sessionStorage",
    "indexedDB",
  ]) {
    assert.equal(bundle.includes(forbidden), false, forbidden);
  }
  assert.equal(bundle.includes("wallet_strk20PrepareInvoke"), true);
  assert.equal(bundle.includes("wallet_requestAccounts"), true);

  const metafile = JSON.parse(
    await readFile(
      new URL("../../tools/private-exit-preflight.meta.json", import.meta.url),
      "utf8",
    ),
  ) as { inputs?: Record<string, unknown> };
  const moduleGraph = Object.keys(metafile.inputs ?? {}).join("\n");
  for (const forbiddenModule of [
    "get-starknet-discovery",
    "get-starknet-virtual-wallet",
    "metamask",
  ]) {
    assert.equal(moduleGraph.includes(forbiddenModule), false, forbiddenModule);
  }
  assert.equal(moduleGraph.includes("get-starknet-wallet-standard"), true);

  const toolSource = await readFile(
    new URL("../../tools/private-exit-preflight.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/console\.(?:log|debug|info|warn|error)\s*\(/.test(toolSource), false);
  assert.equal(/(?:localStorage|sessionStorage|indexedDB)/.test(toolSource), false);
});
