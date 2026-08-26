import { StarknetInjectedWallet } from "@starknet-io/get-starknet-wallet-standard";
import type { StarknetWindowObject } from "@starknet-io/types-js";

type Listener = (wallets: readonly ReadyWallet[]) => void;

export type ReadyWallet = StarknetInjectedWallet;

export type ReadyOnlyStore = Readonly<{
  getWallets(): ReadyWallet[];
  subscribe(listener: Listener): () => void;
  refreshInjectedWallets(): void;
}>;

/**
 * Exact Ready X injected-wallet discovery for the proof-handling tool.
 *
 * Ready X 5.33.9 injects the same object at `starknet_argentX` and
 * `starknet`. Requiring its exact id/name avoids the generic discovery
 * package and its statically imported virtual-wallet remote loader.
 */
export function createReadyOnlyStore(): ReadyOnlyStore {
  const listeners = new Set<Listener>();
  let injected: StarknetWindowObject | undefined;
  let wallet: ReadyWallet | undefined;

  const refreshInjectedWallets = () => {
    const windowWithReady = window as typeof window & {
      starknet_argentX?: StarknetWindowObject;
      starknet?: StarknetWindowObject;
    };
    const candidate = [windowWithReady.starknet_argentX, windowWithReady.starknet].find(
      isExactReady,
    );
    if (candidate === injected) return;
    injected = candidate;
    wallet = candidate ? new StarknetInjectedWallet(candidate) : undefined;
    const wallets = wallet ? [wallet] : [];
    for (const listener of listeners) listener(wallets);
  };

  refreshInjectedWallets();
  return Object.freeze({
    getWallets: () => (wallet ? [wallet] : []),
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshInjectedWallets,
  });
}

function isExactReady(value: StarknetWindowObject | undefined): value is StarknetWindowObject {
  return value?.id === "argentX" && value.name === "Ready X";
}
