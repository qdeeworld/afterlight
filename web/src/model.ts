import { CONTRACT } from "./config.ts";

export type Role = "owner" | "successor";
export type WalletStatus = "checking" | "missing" | "available" | "connecting" | "connected" | "wrong-network";
export type VaultStateName = "NOT FOUND" | "ACTIVE" | "GRACE" | "CLAIMED" | "CANCELLED";

export interface VaultSnapshot {
  exists: boolean;
  state: string;
  mode: string;
  ownerKey: string;
  successorKey: string;
  token: string;
  amount: string;
  inactivitySeconds: string;
  graceSeconds: string;
  lastHeartbeat: string;
  requestedAt: string;
  claimAfter: string;
  epoch: string;
  ownerNonce: string;
  successorNonce: string;
}

export interface RecoveryInvitation {
  version: 1;
  chain: "SN_MAIN";
  contract: string;
  vaultId: string;
  ownerKey: string;
  successorKey: string;
  token: "STRK";
  amount: "1";
  mode: "FAST_DEMO";
  inactivitySeconds: "300";
  graceSeconds: "300";
}

export type InvitationResult =
  | { valid: true; invitation: RecoveryInvitation }
  | { valid: false; reason: string };

export function parseInvitation(value: string): InvitationResult {
  if (!value.trim()) return { valid: false, reason: "Paste a recovery invitation first." };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const fields = ["version", "chain", "contract", "vaultId", "ownerKey", "successorKey", "token", "amount", "mode", "inactivitySeconds", "graceSeconds"];
    if (Object.keys(parsed).some((key) => !fields.includes(key))) return { valid: false, reason: "Invitation contains an unsupported field." };
    if (parsed.version !== 1 || parsed.chain !== "SN_MAIN") return { valid: false, reason: "Invitation is not Afterlight Mainnet v1." };
    if (String(parsed.contract).toLowerCase() !== CONTRACT) return { valid: false, reason: "Invitation points to a different contract." };
    for (const key of ["vaultId", "ownerKey", "successorKey"] as const) {
      if (!/^0x[0-9a-f]{1,64}$/i.test(String(parsed[key]))) return { valid: false, reason: `${key} is invalid.` };
    }
    if (parsed.token !== "STRK" || parsed.amount !== "1" || parsed.mode !== "FAST_DEMO" || parsed.inactivitySeconds !== "300" || parsed.graceSeconds !== "300") {
      return { valid: false, reason: "This release supports the 1 STRK, five-minute Recovery Drill only." };
    }
    return { valid: true, invitation: parsed as unknown as RecoveryInvitation };
  } catch {
    return { valid: false, reason: "Invitation is not valid Afterlight JSON." };
  }
}

export function stateName(state: string): VaultStateName {
  return ({ "1": "ACTIVE", "2": "GRACE", "3": "CLAIMED", "4": "CANCELLED" } as Record<string, VaultStateName>)[state] ?? "NOT FOUND";
}
