import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { constants, ec, hash, shortString } from "starknet";
import type { STRK20_ACTION } from "@starknet-io/types-js";
import { LocalStarkKey } from "../../client/src/keys.ts";
import { PINNED_STRK20_POOL_CLASS_HASH, type PreparedCallAndProof } from "../../client/src/actions.ts";
import { ROLE_BOUND_SETUP_POLICY, SETUP_AUTHORIZATION_SCHEMA, setupAuthorizationHash } from "../../client/src/setup-authorization.mjs";
import { AMOUNT_FRI, CHAIN_ID, CONTRACT, POOL, STRK } from "../src/config.ts";
import type { RecoveryInvitation, VaultSnapshot } from "../src/model.ts";
import type { ReadySession } from "../src/wallet.ts";

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

describe("first-use browser exit preparation", () => {
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
