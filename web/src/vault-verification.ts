import { num } from "starknet";
import { STRK } from "./config.ts";
import type { RecoveryInvitation, VaultSnapshot } from "./model.ts";

export type VerifiedVaultRecord = Readonly<{
  vaultId: string;
  snapshot: VaultSnapshot;
}>;

export function assertInvitationMatchesVault(invitation: RecoveryInvitation, snapshot: VaultSnapshot): void {
  const mode = invitation.mode === "NORMAL" ? "0" : "1";
  for (const [label, observed, expected] of [
    ["owner key", snapshot.ownerKey, invitation.ownerKey],
    ["successor key", snapshot.successorKey, invitation.successorKey],
    ["token", snapshot.token, STRK],
    ["amount", snapshot.amount, 10n ** 18n],
    ["mode", snapshot.mode, mode],
    ["inactivity", snapshot.inactivitySeconds, invitation.inactivitySeconds],
    ["grace", snapshot.graceSeconds, invitation.graceSeconds],
  ] as const) {
    if (num.toHex(BigInt(observed)) !== num.toHex(BigInt(expected))) throw new Error(`Invitation ${label} does not match Mainnet state.`);
  }
}

export function bindVerifiedVault(invitation: RecoveryInvitation, snapshot: VaultSnapshot): VerifiedVaultRecord {
  assertInvitationMatchesVault(invitation, snapshot);
  return Object.freeze({ vaultId: num.toHex(BigInt(invitation.vaultId)), snapshot });
}

export function snapshotForInvitation(invitation: RecoveryInvitation, record: VerifiedVaultRecord | undefined): VaultSnapshot | undefined {
  if (!record || num.toHex(BigInt(invitation.vaultId)) !== record.vaultId) return undefined;
  try {
    assertInvitationMatchesVault(invitation, record.snapshot);
    return record.snapshot;
  } catch {
    return undefined;
  }
}
