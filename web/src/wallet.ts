import { createStore } from "@starknet-io/get-starknet-discovery";
import { WalletAccountV6, walletV6, num, type Call, type RpcProvider } from "starknet";
import type { STRK20_ACTION } from "@starknet-io/types-js";
import type { PreparedCallAndProof } from "../../client/src/actions.ts";
import { CHAIN_ID, READY_MIN_VERSION } from "./config.ts";
import { isCompatibleReadyVersion, isRecognizedReadyName, isUsableReadyProvider } from "./compatibility.ts";
import { walletAuthorizationResult, walletRequest } from "./wallet-request.ts";

type ReadyWallet = ReturnType<ReturnType<typeof createStore>["getWallets"]>[number];

export interface ReadySession {
  name: string;
  version: string;
  address: string;
  chainId: string;
  balance(token: string): Promise<bigint>;
  invoke(actions: readonly STRK20_ACTION[]): Promise<string>;
  invokePublic(calls: readonly Call[]): Promise<string>;
  prepare(actions: readonly STRK20_ACTION[], simulate: boolean): Promise<PreparedCallAndProof>;
  disconnect(): void;
}

const store = createStore({ eip1193Adapters: [] });

function walletFeature(wallet: ReadyWallet): { walletVersion?: unknown; request?: unknown } | undefined {
  return wallet.features["starknet:walletApi"] as { walletVersion?: unknown; request?: unknown } | undefined;
}

export function detectReady(): { found: boolean; version?: string } {
  const wallets = store.getWallets();
  const wallet = findUsableReady(wallets)
    ?? wallets.find((candidate) => isRecognizedReadyName(candidate.name) && typeof walletFeature(candidate)?.request === "function")
    ?? wallets.find((candidate) => isRecognizedReadyName(candidate.name));
  const feature = wallet ? walletFeature(wallet) : undefined;
  return wallet && typeof feature?.request === "function"
    ? { found: true, version: String(feature.walletVersion ?? "") }
    : { found: false };
}

function findUsableReady(wallets: readonly ReadyWallet[]): ReadyWallet | undefined {
  return wallets.find((wallet) => {
    const feature = walletFeature(wallet);
    return isUsableReadyProvider(wallet.name, feature?.walletVersion, feature?.request);
  });
}

function findReady(refreshIfMissing: boolean): ReadyWallet | undefined {
  // Some extension builds still use the legacy Argent X identity, while newer
  // releases register as Ready, Ready X, or Ready Wallet. Refresh only after
  // an explicit connection attempt so ordinary renders do not repeatedly wrap
  // unrelated late-injected providers and attach redundant event listeners.
  const discovered = findUsableReady(store.getWallets());
  if (discovered || !refreshIfMissing) return discovered;
  store._refreshInjectedWallets();
  return findUsableReady(store.getWallets());
}

export async function connectReady(provider: RpcProvider, onChanged: () => void): Promise<ReadySession> {
  const wallet = findReady(true);
  if (!wallet) {
    const recognized = store.getWallets().filter((candidate) => isRecognizedReadyName(candidate.name));
    const withApi = recognized.filter((candidate) => typeof walletFeature(candidate)?.request === "function");
    if (recognized.length === 0) throw new Error("Ready X was not detected in this browser profile.");
    if (withApi.length === 0) throw new Error("The detected Ready wallet does not expose its Wallet API.");
    const versions = [...new Set(withApi.map((candidate) => String(walletFeature(candidate)?.walletVersion ?? "unknown")))];
    throw new Error(`Ready X ${READY_MIN_VERSION} or a compatible Ready 5.x release is required; detected ${versions.join(", ")}.`);
  }
  const feature = walletFeature(wallet);
  if (typeof feature?.request !== "function") throw new Error("Ready X does not expose its Wallet API.");
  if (!isCompatibleReadyVersion(feature.walletVersion)) throw new Error(`Ready X ${READY_MIN_VERSION} or a compatible Ready 5.x release is required; detected ${String(feature.walletVersion)}.`);
  // Use the same Wallet API feature that detection and private operations use.
  // An additional standard:connect wrapper is not needed for authorization.
  const accounts = await walletRequest(walletV6.requestAccounts(wallet as never, false), "the connection request");
  const chainId = num.toHex(BigInt(await walletRequest(walletV6.requestChainId(wallet as never), "the network check")));
  if (chainId !== CHAIN_ID) throw new Error("Switch Ready X to Starknet Mainnet.");
  if (accounts.length !== 1) throw new Error("Ready X must expose exactly one selected account.");
  const address = num.toHex(BigInt(accounts[0]!));
  const confirmed = await walletRequest(walletV6.requestAccounts(wallet as never, true), "the selected-account check");
  if (confirmed.length !== 1 || num.toHex(BigInt(confirmed[0]!)) !== address) throw new Error("Ready account changed during connection. Reconnect before continuing.");
  const account = new WalletAccountV6({ provider, walletProvider: wallet as never, address });
  const unsubscribe = walletV6.subscribeWalletEvent(wallet as never, onChanged);

  async function assertFresh(): Promise<void> {
    // Chain-ID requests require site authorization in Ready X. Never race them
    // with account authorization. Session methods are user-triggered, never
    // background polling. An authorized session returns without another prompt.
    const freshAccounts = await walletRequest(walletV6.requestAccounts(wallet as never, false), "wallet authorization");
    if (freshAccounts.length !== 1 || num.toHex(BigInt(freshAccounts[0]!)) !== address) {
      throw new Error("Ready account or network changed. Reconnect before continuing.");
    }
    const freshChain = await walletRequest(walletV6.requestChainId(wallet as never), "the network check");
    if (num.toHex(BigInt(freshChain)) !== CHAIN_ID) {
      throw new Error("Ready account or network changed. Reconnect before continuing.");
    }
  }

  return {
    name: wallet.name,
    version: String(feature.walletVersion),
    address,
    chainId,
    balance: async (token) => {
      await assertFresh();
      const raw = await walletRequest(account.strk20Balances([token] as never), "the private-balance check") as unknown;
      if (!Array.isArray(raw)) throw new Error("Ready returned an invalid private-balance response.");
      const match = raw.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const record = entry as Record<string | number, unknown>;
        const candidate = record.token ?? record.token_address ?? record[0];
        try { return num.toHex(BigInt(String(candidate))) === num.toHex(BigInt(token)); } catch { return false; }
      }) as Record<string | number, unknown> | undefined;
      if (!match) throw new Error("Ready did not return the requested STRK balance.");
      const amount = match.amount ?? match.balance ?? match[1];
      return BigInt(String(amount));
    },
    invoke: async (actions) => {
      await assertFresh();
      const response = await account.strk20InvokeTransaction([...actions] as never);
      if (!response.transaction_hash) throw new Error("Ready did not return a transaction hash.");
      return num.toHex(BigInt(response.transaction_hash));
    },
    invokePublic: async (calls) => {
      await assertFresh();
      const response = await account.execute([...calls]);
      if (!response.transaction_hash) throw new Error("Ready did not return a public transaction hash.");
      return num.toHex(BigInt(response.transaction_hash));
    },
    prepare: async (actions, simulate) => {
      await assertFresh();
      // Preparation is never automatically retried or replaced by an invoke.
      return walletAuthorizationResult(account.strk20PrepareInvoke([...actions] as never, simulate), simulate ? "simulated preparation" : "final preparation");
    },
    disconnect: unsubscribe,
  };
}
