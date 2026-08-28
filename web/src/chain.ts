import { RpcProvider, num } from "starknet";
import { CHAIN_ID, CONTRACT, RPC_URL, STRK } from "./config.ts";
import type { VaultSnapshot } from "./model.ts";

export const provider = new RpcProvider({ nodeUrl: RPC_URL });

function hex(value: unknown): string {
  return num.toHex(BigInt(String(value ?? 0)));
}

export async function assertMainnet(): Promise<void> {
  if (num.toHex(BigInt(await provider.getChainId())) !== CHAIN_ID) throw new Error("The public RPC is not Starknet Mainnet.");
}

export async function readVault(vaultId: string): Promise<VaultSnapshot> {
  const raw = await provider.callContract({ contractAddress: CONTRACT, entrypoint: "get_vault", calldata: [vaultId] }) as string[];
  if (raw.length !== 15) throw new Error("Afterlight returned an unexpected vault shape.");
  const decimal = raw.map((value) => BigInt(value).toString());
  return {
    exists: BigInt(raw[0]!) !== 0n,
    state: decimal[1]!,
    mode: decimal[2]!,
    ownerKey: hex(raw[3]),
    successorKey: hex(raw[4]),
    token: hex(raw[5]),
    amount: decimal[6]!,
    inactivitySeconds: decimal[7]!,
    graceSeconds: decimal[8]!,
    lastHeartbeat: decimal[9]!,
    requestedAt: decimal[10]!,
    claimAfter: decimal[11]!,
    epoch: decimal[12]!,
    ownerNonce: decimal[13]!,
    successorNonce: decimal[14]!,
  };
}

export async function readLiability(): Promise<bigint> {
  const raw = await provider.callContract({ contractAddress: CONTRACT, entrypoint: "get_locked_by_token", calldata: [STRK] });
  return BigInt(raw[0] ?? 0) + (BigInt(raw[1] ?? 0) << 128n);
}

export async function waitForSuccess(transactionHash: string): Promise<void> {
  const receipt = await provider.waitForTransaction(transactionHash, { retryInterval: 4_000 });
  const value = (receipt as unknown as { value?: Record<string, unknown> }).value ?? receipt as unknown as Record<string, unknown>;
  if (String(value.execution_status ?? "") !== "SUCCEEDED") throw new Error("The Mainnet transaction did not succeed.");
}
