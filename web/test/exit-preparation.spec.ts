import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { constants, ec, hash, shortString } from "starknet";
import type { STRK20_ACTION } from "@starknet-io/types-js";
import { LocalStarkKey } from "../../client/src/keys.ts";
import { PINNED_STRK20_POOL_CLASS_HASH, type PreparedCallAndProof } from "../../client/src/actions.ts";
import { ROLE_BOUND_SETUP_POLICY, SETUP_AUTHORIZATION_SCHEMA, setupAuthorizationHash } from "../../client/src/setup-authorization.mjs";
import { AMOUNT_FRI, AUTH_TTL_SECONDS, CHAIN_ID, CONTRACT, POOL, STRK } from "../src/config.ts";
import type { RecoveryInvitation, VaultSnapshot } from "../src/model.ts";
import type { ReadySession } from "../src/wallet.ts";
import { openPrivateTokenSetupConsent } from "../src/setup-consent.ts";

vi.mock("../src/chain.ts", () => ({
  provider: {
    getBlockWithTxHashes: vi.fn(async () => ({ block_hash: "0x123456" })),
    getBlockNumber: vi.fn(async () => 13869056),
  },
  waitForSuccess: vi.fn(),
  TransactionExecutionError: class extends Error {},
}));

let prepareExitPackage: typeof import("../src/operations.ts").prepareExitPackage;
beforeAll(async () => {
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  ({ prepareExitPackage } = await import("../src/operations.ts"));
});
afterEach(() => vi.restoreAllMocks());

// Synthetic prepared actions, NOT an authentic privacy proof. These tests prove
// browser policy/consent sequencing and exact bytes only, never Mainnet receipt.
function prepared(actions: readonly STRK20_ACTION[], simulate: boolean, setup: boolean): PreparedCallAndProof {
  const invoke = actions[1] as { calldata: string[] };
  const fields = [...invoke.calldata];
  fields[7] = "0xdeadbeef";
  const storage = BigInt(hash.computePedersenHash(hash.starknetKeccak("notes"), fields[7])) % constants.ADDR_BOUND;
  const server = [
    setup ? "5" : "3",
    ...(setup ? ["0", "273", "2", simulate ? "100" : "101", simulate ? "200" : "201", "0", "819", "1", "1"] : []),
    "0", storage.toString(), "2", (1n << 128n).toString(), STRK,
    "7", "123", simulate ? "456" : "457", simulate ? "789" : "790", STRK, fields[7],
    "10", CONTRACT, "11", ...fields,
  ];
  const output = [PINNED_STRK20_POOL_CLASS_HASH, ...server];
  const messageHash = ec.starkCurve.poseidonHashMany([BigInt(POOL), 0n, BigInt(output.length), ...output.map(BigInt)]);
  return {
    call: { contractAddress: POOL, entrypoint: "apply_actions", calldata: [...server, ...(simulate ? [] : ["1"])] },
    proof: simulate ? { data: "", output: [], proof_facts: [] } : {
      data: "YQ==", output,
      proof_facts: [
        shortString.encodeShortString("PROOF1"), shortString.encodeShortString("VIRTUAL_SNOS"),
        "0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473",
        shortString.encodeShortString("VIRTUAL_SNOS0"), "0xd3a000", "0x123456",
        hash.computeHashOnElements([shortString.encodeShortString("StarknetOsConfig3"), CHAIN_ID, STRK]),
        "1", messageHash.toString(),
      ],
    },
  };
}

function fixture(setup = true, action: "CLAIM" | "CANCEL_REFUND" = "CLAIM") {
  const roleKey = LocalStarkKey.restore(JSON.stringify({ format: "afterlight-stark-key-v1", private_key: `0x${"12345".padStart(64, "0")}` }));
  const invitation: RecoveryInvitation = {
    version: 1, chain: "SN_MAIN", contract: CONTRACT, vaultId: "0xabc",
    ownerKey: action === "CLAIM" ? "0x111" : roleKey.publicKey,
    successorKey: action === "CLAIM" ? roleKey.publicKey : "0x222",
    token: "STRK", amount: "1", mode: "FAST_DEMO", inactivitySeconds: "300", graceSeconds: "300",
  };
  const vault: VaultSnapshot = {
    exists: true, state: action === "CLAIM" ? "2" : "1", mode: "1",
    ownerKey: invitation.ownerKey, successorKey: invitation.successorKey, token: STRK,
    amount: AMOUNT_FRI, inactivitySeconds: "300", graceSeconds: "300",
    lastHeartbeat: "1", requestedAt: "2", claimAfter: "302", epoch: "1", ownerNonce: "1", successorNonce: "1",
  };
  const ready: ReadySession = {
    name: "Ready X", version: "5.33.9", address: "0x999", chainId: CHAIN_ID,
    balance: vi.fn(async () => 0n), invoke: vi.fn(), invokePublic: vi.fn(), disconnect: vi.fn(),
    prepare: vi.fn(async (actions, simulate) => prepared(actions, simulate, setup)),
  };
  return { ready, invitation, vault, roleKey, action };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("first-use browser exit preparation", () => {
  it.each([true, false])("reports preparation stages in order with setup=%s", async (setup) => {
    const input = fixture(setup);
    const stages: string[] = [];
    const sign = vi.spyOn(input.roleKey, "sign");
    vi.mocked(input.ready.prepare).mockImplementation(async (actions, simulate) => {
      expect(stages.at(-1)).toBe(simulate ? "destination" : "final-proof");
      expect(sign).toHaveBeenCalledTimes(simulate ? 0 : 1);
      return prepared(actions, simulate, setup);
    });
    const approveSetup = vi.fn(() => {
      expect(stages.at(-1)).toBe("setup-consent");
      expect(sign).not.toHaveBeenCalled();
      return true;
    });
    await prepareExitPackage({
      ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup,
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(setup
      ? ["destination", "setup-consent", "final-proof", "verify-proof"]
      : ["destination", "final-proof", "verify-proof"]);
    expect(approveSetup).toHaveBeenCalledTimes(setup ? 1 : 0);
    input.roleKey.destroy();
  });

  it.each(["sentinel", "final"] as const)("rejects a context change during %s preparation before further signing", async (phase) => {
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    const entered = deferred<void>();
    const resume = deferred<void>();
    const stages: string[] = [];
    let contextValid = true;
    const assertContext = () => { if (!contextValid) throw new Error("attempt context changed"); };
    vi.mocked(input.ready.prepare).mockImplementation(async (actions, simulate) => {
      if (simulate === (phase === "sentinel")) {
        entered.resolve();
        await resume.promise;
      }
      return prepared(actions, simulate, true);
    });
    const approveSetup = vi.fn(() => true);
    const pending = prepareExitPackage({
      ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup, assertContext,
      onStage: (stage) => stages.push(stage),
    });
    const rejected = expect(pending).rejects.toThrow(/attempt context changed/);
    await entered.promise;
    expect(sign).toHaveBeenCalledTimes(phase === "sentinel" ? 0 : 1);
    contextValid = false;
    resume.resolve();
    await rejected;
    expect(sign).toHaveBeenCalledTimes(phase === "sentinel" ? 0 : 1);
    expect(input.ready.prepare).toHaveBeenCalledTimes(phase === "sentinel" ? 1 : 2);
    expect(approveSetup).toHaveBeenCalledTimes(phase === "sentinel" ? 0 : 1);
    expect(stages).toEqual(phase === "sentinel" ? ["destination"] : ["destination", "setup-consent", "final-proof"]);
    expect(input.ready.invoke).not.toHaveBeenCalled();
    expect(input.ready.invokePublic).not.toHaveBeenCalled();
    input.roleKey.destroy();
  });

  it("checks context after hashing the policy-bearing package and before setup signing", async () => {
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    let contextValid = true;
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let unsigned: Record<string, unknown> | undefined;
    const hashDigest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (unsigned === undefined) {
        unsigned = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
        contextValid = false;
      }
      return originalDigest(algorithm, data);
    });
    await expect(prepareExitPackage({
      ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup: () => true,
      assertContext: () => { if (!contextValid) throw new Error("attempt context changed"); },
    })).rejects.toThrow(/attempt context changed/);
    expect(unsigned).toMatchObject({ schema: "afterlight-prepared-neutral-exit/2", setupPolicy: ROLE_BOUND_SETUP_POLICY });
    expect(unsigned).not.toHaveProperty("setupAuthorization");
    expect(unsigned).not.toHaveProperty("locks");
    expect(hashDigest).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledTimes(1);
    input.roleKey.destroy();
  });

  it("expires an approval wait at its deadline without signing or preparing a final proof", async () => {
    const startMs = Date.UTC(2026, 0, 1);
    const now = vi.spyOn(Date, "now").mockReturnValue(startMs);
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    const entered = deferred<void>();
    const decision = deferred<boolean>();
    const stages: string[] = [];
    const pending = prepareExitPackage({
      ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY,
      approveSetup: () => { entered.resolve(); return decision.promise; },
      onStage: (stage) => stages.push(stage),
    });
    const rejected = expect(pending).rejects.toThrow(/expired while waiting for approval/);
    await entered.promise;
    now.mockReturnValue(startMs + AUTH_TTL_SECONDS * 1_000);
    decision.resolve(true);
    await rejected;
    expect(sign).not.toHaveBeenCalled();
    expect(input.ready.prepare).toHaveBeenCalledTimes(1);
    expect(stages).toEqual(["destination", "setup-consent"]);
    input.roleKey.destroy();
  });

  it("keeps both local signatures and final preparation pending until async approval", async () => {
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    const entered = deferred<void>();
    const decision = deferred<boolean>();
    const approveSetup = vi.fn(() => { entered.resolve(); return decision.promise; });
    const pending = prepareExitPackage({ ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup });
    await entered.promise;
    expect(sign).not.toHaveBeenCalled();
    expect(input.ready.prepare).toHaveBeenCalledTimes(1);
    expect(input.ready.invoke).not.toHaveBeenCalled();
    expect(input.ready.invokePublic).not.toHaveBeenCalled();
    decision.resolve(true);
    await expect(pending).resolves.toMatchObject({ schema: "afterlight-prepared-neutral-exit/2" });
    expect(sign).toHaveBeenCalledTimes(2);
    expect(input.ready.prepare).toHaveBeenCalledTimes(2);
    expect(approveSetup).toHaveBeenCalledOnce();
    input.roleKey.destroy();
  });

  it.each(["cancel", "reject"] as const)("stays unsigned when pending async approval is %s", async (outcome) => {
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    const entered = deferred<void>();
    const decision = deferred<boolean>();
    const stages: string[] = [];
    const pending = prepareExitPackage({
      ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY,
      approveSetup: () => { entered.resolve(); return decision.promise; },
      onStage: (stage) => stages.push(stage),
    });
    const rejected = expect(pending).rejects.toThrow(outcome === "cancel" ? /not authorized/ : /approval invalidated/);
    await entered.promise;
    expect(sign).not.toHaveBeenCalled();
    if (outcome === "cancel") decision.resolve(false);
    else decision.reject(new Error("approval invalidated"));
    await rejected;
    expect(sign).not.toHaveBeenCalled();
    expect(input.ready.prepare).toHaveBeenCalledTimes(1);
    expect(input.ready.invoke).not.toHaveBeenCalled();
    expect(input.ready.invokePublic).not.toHaveBeenCalled();
    expect(stages).toEqual(["destination", "setup-consent"]);
    input.roleKey.destroy();
  });

  it("requires fresh asynchronous consent after a previously approved attempt", async () => {
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    const entered = deferred<void>();
    const decision = deferred<boolean>();
    const approveSetup = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => { entered.resolve(); return decision.promise; });
    await prepareExitPackage({ ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup });
    expect(sign).toHaveBeenCalledTimes(2);
    const pending = prepareExitPackage({ ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup });
    const rejected = expect(pending).rejects.toThrow(/not authorized/);
    await entered.promise;
    expect(approveSetup).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(input.ready.prepare).toHaveBeenCalledTimes(3);
    decision.resolve(false);
    await rejected;
    expect(sign).toHaveBeenCalledTimes(2);
    input.roleKey.destroy();
  });

  it("does not sign if opening the in-page modal fails", async () => {
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    const control = Object.assign(new EventTarget(), { focus: vi.fn() });
    const dialog = Object.assign(new EventTarget(), {
      open: false, setAttribute: vi.fn(), querySelector: () => control,
      showModal: () => { throw new Error("modal unavailable"); }, remove: vi.fn(),
    });
    const doc = {
      activeElement: null, createElement: () => dialog, body: { append: vi.fn() },
    } as unknown as Document;
    await expect(prepareExitPackage({
      ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY,
      approveSetup: () => openPrivateTokenSetupConsent(doc).result,
    })).rejects.toThrow(/could not open the setup approval/);
    expect(sign).not.toHaveBeenCalled();
    expect(input.ready.prepare).toHaveBeenCalledTimes(1);
    expect(input.ready.invoke).not.toHaveBeenCalled();
    expect(dialog.remove).toHaveBeenCalledOnce();
    input.roleKey.destroy();
  });

  it.each(["CLAIM", "CANCEL_REFUND"] as const)("binds complete final %s package after consent without a private deposit", async (action) => {
    const input = fixture(true, action);
    const sign = vi.spyOn(input.roleKey, "sign");
    const approveSetup = vi.fn(() => {
      expect(sign).not.toHaveBeenCalled();
      expect(input.ready.prepare).toHaveBeenCalledTimes(1);
      return true;
    });
    const result = await prepareExitPackage({ ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup });
    expect(result.schema).toBe("afterlight-prepared-neutral-exit/2");
    expect(result.setupPolicy).toBe(ROLE_BOUND_SETUP_POLICY);
    expect(approveSetup).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(input.ready.prepare).toHaveBeenCalledTimes(2);
    expect(input.ready.balance).not.toHaveBeenCalled();
    expect(input.ready.invoke).not.toHaveBeenCalled();
    expect(input.ready.invokePublic).not.toHaveBeenCalled();
    const { locks, setupAuthorization, ...unsigned } = result;
    const auth = setupAuthorization as { schema: string; sig_r: string; sig_s: string };
    expect(auth.schema).toBe(SETUP_AUTHORIZATION_SCHEMA);
    const sig = new ec.starkCurve.Signature(BigInt(auth.sig_r), BigInt(auth.sig_s));
    expect(ec.starkCurve.verify(sig, setupAuthorizationHash(digest(unsigned)), ec.starkCurve.getPublicKey("0x12345"))).toBe(true);
    expect((locks as { bindingSha256: string }).bindingSha256).toBe(digest({ ...unsigned, setupAuthorization }));
    expect(Object.isFrozen(result)).toBe(true);
    input.roleKey.destroy();
  });

  it("keeps ordinary three-action packages unchanged and never asks setup consent", async () => {
    const input = fixture(false);
    const approveSetup = vi.fn(() => false);
    const sign = vi.spyOn(input.roleKey, "sign");
    const result = await prepareExitPackage({ ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup });
    expect(result.schema).toBe("afterlight-prepared-neutral-exit/1");
    expect(result).not.toHaveProperty("setupAuthorization");
    expect(result).not.toHaveProperty("setupPolicy");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(approveSetup).not.toHaveBeenCalled();
  });

  it.each(["disabled", "declined", "missing"])("never signs or requests final preparation when setup is %s", async (reason) => {
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    const approveSetup = reason === "missing" ? undefined : vi.fn(() => reason !== "declined");
    await expect(prepareExitPackage({ ...input, ...(reason === "disabled" ? {} : { setupPolicy: ROLE_BOUND_SETUP_POLICY }), ...(approveSetup ? { approveSetup } : {}) })).rejects.toThrow(/not enabled|not authorized/);
    expect(sign).not.toHaveBeenCalled();
    expect(input.ready.prepare).toHaveBeenCalledTimes(1);
    expect(input.ready.invoke).not.toHaveBeenCalled();
    if (reason === "disabled") expect(approveSetup).not.toHaveBeenCalled();
  });

  it("keeps the preparation-only diagnostic unsigned even if sponsorship is enabled", async () => {
    const input = fixture();
    const sign = vi.spyOn(input.roleKey, "sign");
    const approveSetup = vi.fn(() => true);
    await expect(prepareExitPackage({ ...input, diagnosticOnly: true, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup })).rejects.toThrow(/Preparation check complete/);
    expect(sign).not.toHaveBeenCalled();
    expect(approveSetup).not.toHaveBeenCalled();
    expect(input.ready.prepare).toHaveBeenCalledTimes(1);
  });

  it("does not grant final setup authorization after final write-target drift", async () => {
    const input = fixture();
    vi.mocked(input.ready.prepare).mockImplementation(async (actions, simulate) => {
      const value = prepared(actions, simulate, true);
      if (!simulate) (value.call.calldata as string[])[2] = "276";
      return value;
    });
    const sign = vi.spyOn(input.roleKey, "sign");
    await expect(prepareExitPackage({ ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup: () => true })).rejects.toThrow();
    expect(sign).toHaveBeenCalledTimes(1); // exact-note signature only; no v2 consent
  });

  it("does not grant final setup consent to a mock proof envelope", async () => {
    const input = fixture();
    vi.mocked(input.ready.prepare).mockImplementation(async (actions, simulate) => {
      const value = prepared(actions, simulate, true);
      if (!simulate) value.proof.proof_facts[0] = shortString.encodeShortString("PROOF0");
      return value;
    });
    const sign = vi.spyOn(input.roleKey, "sign");
    await expect(prepareExitPackage({ ...input, setupPolicy: ROLE_BOUND_SETUP_POLICY, approveSetup: () => true })).rejects.toThrow(/real PROOF1/);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
