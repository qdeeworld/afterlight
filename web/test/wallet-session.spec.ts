import type { STRK20_ACTION } from "@starknet-io/types-js";
import type { RpcProvider } from "starknet";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_ID, STRK } from "../src/config.ts";
import { connectReady, detectReady, type ReadySession } from "../src/wallet.ts";
import { ReadyAuthorizationError } from "../src/wallet-request.ts";

const mocks = vi.hoisted(() => ({
  getWallets: vi.fn(),
  refreshInjectedWallets: vi.fn(),
  request: vi.fn(),
  on: vi.fn(),
  unsubscribe: vi.fn(),
  constructAccount: vi.fn(),
  balances: vi.fn(),
  invoke: vi.fn(),
  execute: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@starknet-io/get-starknet-discovery", () => ({
  createStore: () => ({
    getWallets: mocks.getWallets,
    _refreshInjectedWallets: mocks.refreshInjectedWallets,
  }),
}));

vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  return {
    ...actual,
    WalletAccountV6: class {
      constructor(options: unknown) { mocks.constructAccount(options); }
      strk20Balances = mocks.balances;
      strk20InvokeTransaction = mocks.invoke;
      execute = mocks.execute;
      strk20PrepareInvoke = mocks.prepare;
    },
  };
});

const ADDRESS = "0x123";
const OTHER_ADDRESS = "0x456";
const TESTNET = "0x534e5f5345504f4c4941";
const provider = {} as RpcProvider;
const wallet = {
  name: "Ready X",
  features: {
    "starknet:walletApi": { walletVersion: "5.33.9", request: mocks.request },
    "standard:events": { on: mocks.on },
  },
};
const actions = Object.freeze([
  { type: "withdraw", token: STRK, amount: "0x1", recipient: ADDRESS },
] satisfies STRK20_ACTION[]);
const calls = Object.freeze([
  { contractAddress: STRK, entrypoint: "transfer", calldata: [ADDRESS, "0x1", "0x0"] },
]);

let selectedAccounts: string[];
let selectedChain: string;

beforeEach(() => {
  vi.resetAllMocks();
  selectedAccounts = [ADDRESS];
  selectedChain = CHAIN_ID;
  mocks.getWallets.mockReturnValue([wallet]);
  mocks.on.mockReturnValue(mocks.unsubscribe);
  mocks.request.mockImplementation(async ({ type }: { type: string }) => {
    if (type === "wallet_requestAccounts") return selectedAccounts;
    if (type === "wallet_requestChainId") return selectedChain;
    throw new Error(`Unexpected wallet request: ${type}`);
  });
  mocks.balances.mockResolvedValue([{ token: STRK, amount: "0x0" }]);
  mocks.invoke.mockResolvedValue({ transaction_hash: "0xabc" });
  mocks.execute.mockResolvedValue({ transaction_hash: "0xdef" });
});

function expectNoBroadcast(): void {
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
}

describe("Ready connection", () => {
  it("discovers a late injected Ready at startup without requesting accounts", () => {
    mocks.getWallets.mockReturnValueOnce([]).mockReturnValue([wallet]);
    expect(detectReady(true)).toEqual({ found: true, version: "5.33.9" });
    expect(mocks.refreshInjectedWallets).toHaveBeenCalledOnce();
    expect(mocks.request).not.toHaveBeenCalled();
    expectNoBroadcast();
  });

  it("does not rewrap a detected wallet during ordinary renders", () => {
    expect(detectReady(true).found).toBe(true);
    expect(detectReady().found).toBe(true);
    expect(mocks.refreshInjectedWallets).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("requests interactive authorization, then silently confirms the selected Mainnet account", async () => {
    mocks.request.mockResolvedValueOnce(["0x000123"]);
    const onChanged = vi.fn();

    const session = await connectReady(provider, onChanged);

    expect(mocks.request.mock.calls).toEqual([
      [{ type: "wallet_requestAccounts", params: { silent_mode: false } }],
      [{ type: "wallet_requestChainId" }],
      [{ type: "wallet_requestAccounts", params: { silent_mode: true } }],
    ]);
    expect(session).toMatchObject({ name: "Ready X", version: "5.33.9", address: ADDRESS, chainId: CHAIN_ID });
    expect(mocks.constructAccount).toHaveBeenCalledExactlyOnceWith({ provider, walletProvider: wallet, address: ADDRESS });
    expect(mocks.on).toHaveBeenCalledExactlyOnceWith("change", onChanged);
    session.disconnect();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expectNoBroadcast();
  });

  it("aborts before creating a session when Ready is on another network", async () => {
    selectedChain = TESTNET;

    await expect(connectReady(provider, vi.fn())).rejects.toThrow("Switch Ready X to Starknet Mainnet");

    expect(mocks.constructAccount).not.toHaveBeenCalled();
    expect(mocks.on).not.toHaveBeenCalled();
    expectNoBroadcast();
  });

  it.each([{ accounts: [] }, { accounts: [ADDRESS, OTHER_ADDRESS] }])("rejects an ambiguous initial account selection: $accounts", async ({ accounts }) => {
    selectedAccounts = accounts;

    await expect(connectReady(provider, vi.fn())).rejects.toThrow("exactly one selected account");

    expect(mocks.constructAccount).not.toHaveBeenCalled();
    expect(mocks.on).not.toHaveBeenCalled();
  });

  it("aborts if the selected account changes while connection is being confirmed", async () => {
    mocks.request.mockResolvedValueOnce([ADDRESS]);
    selectedAccounts = [OTHER_ADDRESS];

    await expect(connectReady(provider, vi.fn())).rejects.toThrow("Ready account changed during connection");

    expect(mocks.constructAccount).not.toHaveBeenCalled();
    expect(mocks.on).not.toHaveBeenCalled();
    expectNoBroadcast();
  });
});

const operations: readonly [string, boolean, (session: ReadySession) => Promise<unknown>][] = [
  ["private balance", false, (session) => session.balance(STRK)],
  ["private invocation", false, (session) => session.invoke(actions)],
  ["public invocation", false, (session) => session.invokePublic(calls)],
  ["proof preparation", false, (session) => session.prepare(actions, true)],
];

describe.each(operations)("Ready session %s", (_name, silentMode, operation) => {
  it.each(["account", "network"])("blocks wallet work after the selected %s changes", async (changed) => {
    const session = await connectReady(provider, vi.fn());
    mocks.request.mockClear();
    if (changed === "account") selectedAccounts = [OTHER_ADDRESS];
    else selectedChain = TESTNET;

    await expect(operation(session)).rejects.toThrow("Ready account or network changed");

    expect(mocks.request).toHaveBeenCalledWith({ type: "wallet_requestAccounts", params: { silent_mode: silentMode } });
    if (changed === "network") expect(mocks.request).toHaveBeenCalledWith({ type: "wallet_requestChainId" });
    else expect(mocks.request).not.toHaveBeenCalledWith({ type: "wallet_requestChainId" });
    expect(mocks.request).not.toHaveBeenCalledWith({ type: "wallet_requestAccounts", params: { silent_mode: !silentMode } });
    expect(mocks.balances).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expectNoBroadcast();
  });
});

describe("Ready private balance", () => {
  it.each([
    { format: "Wallet API", entry: { token: STRK, amount: "0x0" } },
    { format: "named balance", entry: { token_address: STRK, balance: 0 } },
    { format: "tuple", entry: [STRK, "0"] },
  ])("accepts a valid zero balance in $format format", async ({ entry }) => {
    const session = await connectReady(provider, vi.fn());
    mocks.balances.mockResolvedValue([entry]);

    await expect(session.balance(STRK)).resolves.toBe(0n);

    expect(mocks.balances).toHaveBeenCalledExactlyOnceWith([STRK]);
    expectNoBroadcast();
  });

  it("does not mistake a missing token balance for zero", async () => {
    const session = await connectReady(provider, vi.fn());
    mocks.balances.mockResolvedValue([{ token: OTHER_ADDRESS, amount: "0x0" }]);

    await expect(session.balance(STRK)).rejects.toThrow("did not return the requested STRK balance");

    expectNoBroadcast();
  });
});

describe("Ready proof preparation", () => {
  it("finishes interactive authorization before checking the network and requesting a proof", async () => {
    const session = await connectReady(provider, vi.fn());
    mocks.request.mockClear();
    let authorize!: (accounts: string[]) => void;
    const authorization = new Promise<string[]>((resolve) => { authorize = resolve; });
    const prepared = {
      call: { contractAddress: STRK, entrypoint: "apply_actions", calldata: [] },
      proof: { data: "", output: [], proof_facts: [] },
    };
    mocks.request.mockImplementationOnce(() => authorization);
    mocks.prepare.mockResolvedValue(prepared);

    const result = session.prepare(actions, true);

    expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ type: "wallet_requestAccounts", params: { silent_mode: false } });
    expect(mocks.prepare).not.toHaveBeenCalled();
    authorize([ADDRESS]);
    await expect(result).resolves.toBe(prepared);
    expect(mocks.request.mock.calls).toEqual([
      [{ type: "wallet_requestAccounts", params: { silent_mode: false } }],
      [{ type: "wallet_requestChainId" }],
    ]);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(actions, true);
    expectNoBroadcast();
  });

  it("labels a network permission failure and stops before requesting a proof", async () => {
    const session = await connectReady(provider, vi.fn());
    mocks.request.mockClear();
    mocks.request.mockResolvedValueOnce([ADDRESS]).mockRejectedValueOnce(new Error("Not preauthorized"));

    const result = session.prepare(actions, true);

    await expect(result).rejects.toBeInstanceOf(ReadyAuthorizationError);
    await expect(result).rejects.toThrow("permission during the network check");
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expectNoBroadcast();
  });

  it.each([
    { simulate: true, stage: "simulated preparation" },
    { simulate: false, stage: "final preparation" },
  ])("labels permission failure during $stage without retrying or broadcasting", async ({ simulate, stage }) => {
    const session = await connectReady(provider, vi.fn());
    mocks.prepare.mockRejectedValue(new Error("Not preauthorized"));

    const result = session.prepare(actions, simulate);

    await expect(result).rejects.toBeInstanceOf(ReadyAuthorizationError);
    await expect(result).rejects.toThrow(`permission during ${stage}`);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(actions, simulate);
    expectNoBroadcast();
  });

  it("preserves a preparation failure without invoking a transaction", async () => {
    const session = await connectReady(provider, vi.fn());
    const failure = new Error("Proof generation failed");
    mocks.prepare.mockRejectedValue(failure);

    await expect(session.prepare(actions, true)).rejects.toBe(failure);

    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(actions, true);
    expectNoBroadcast();
  });
});
