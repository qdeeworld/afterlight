import { createStore } from "@starknet-io/get-starknet-discovery";
import { WalletAccountV6, walletV6, num, type RpcProvider } from "starknet";
import type { STRK20_ACTION } from "@starknet-io/types-js";
import type { PreparedCallAndProof } from "../../client/src/actions.ts";
import { CHAIN_ID, READY_VERSION } from "./config.ts";

type ReadyWallet = ReturnType<ReturnType<typeof createStore>["getWallets"]>[number];

export interface ReadySession {
  name: string;
  version: string;
  address: string;
  chainId: string;
  balance(token: string): Promise<bigint>;
  invoke(actions: readonly STRK20_ACTION[]): Promise<string>;
  prepare(actions: readonly STRK20_ACTION[], simulate: boolean): Promise<PreparedCallAndProof>;
  disconnect(): void;
}

const store = createStore({ eip1193Adapters: [] });

function walletFeature(wallet: ReadyWallet): { walletVersion?: unknown; request?: unknown } | undefined {
  return wallet.features["starknet:walletApi"] as { walletVersion?: unknown; request?: unknown } | undefined;
}

export function detectReady(): { found: boolean; version?: string } {
  const wallet = findReady();
  const feature = wallet ? walletFeature(wallet) : undefined;
  return wallet && typeof feature?.request === "function"
    ? { found: true, version: String(feature.walletVersion ?? "") }
    : { found: false };
}

function findReady(): ReadyWallet | undefined {
  return store.getWallets().find((wallet) => /^(?:ready|readyx)$/i.test(wallet.name.replace(/[^a-z0-9]/gi, "")));
}

export async function connectReady(provider: RpcProvider, onChanged: () => void): Promise<ReadySession> {
  const wallet = findReady();
  if (!wallet) throw new Error("Ready X was not detected in this browser profile.");
  const feature = walletFeature(wallet);
  if (typeof feature?.request !== "function") throw new Error("Ready X does not expose its Wallet API.");
  if (feature.walletVersion !== READY_VERSION) throw new Error(`Ready X ${READY_VERSION} is required; detected ${String(feature.walletVersion)}.`);
  const account = await WalletAccountV6.connectSilent(provider, wallet as never);
  const chainId = num.toHex(BigInt(await walletV6.requestChainId(wallet as never)));
  const accounts = await walletV6.requestAccounts(wallet as never, true);
  if (chainId !== CHAIN_ID) throw new Error("Switch Ready X to Starknet Mainnet.");
  if (accounts.length !== 1) throw new Error("Ready X must expose exactly one selected account.");
  const address = num.toHex(BigInt(accounts[0]!));
  if (num.toHex(BigInt(account.address)) !== address) throw new Error("Ready X returned conflicting account identities.");
  const unsubscribe = walletV6.subscribeWalletEvent(wallet as never, onChanged);

  async function assertFresh(): Promise<void> {
    const [freshAccounts, freshChain] = await Promise.all([
      walletV6.requestAccounts(wallet as never, true),
      walletV6.requestChainId(wallet as never),
    ]);
    if (freshAccounts.length !== 1 || num.toHex(BigInt(freshAccounts[0]!)) !== address || num.toHex(BigInt(freshChain)) !== CHAIN_ID) {
      throw new Error("Ready account or network changed. Reconnect before continuing.");
    }
  }

  return {
    name: wallet.name,
    version: READY_VERSION,
    address,
    chainId,
    balance: async (token) => {
      await assertFresh();
      const raw = await account.strk20Balances([token] as never) as unknown;
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
    prepare: async (actions, simulate) => {
      await assertFresh();
      return account.strk20PrepareInvoke([...actions] as never, simulate);
    },
    disconnect: unsubscribe,
  };
}
