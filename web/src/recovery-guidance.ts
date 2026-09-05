import type { VaultSnapshot } from "./model.ts";

export interface SuccessorRecoveryGuidanceInput {
  /** Supply only a live snapshot already verified against this invitation. */
  snapshot?: VaultSnapshot;
  invitationValid: boolean;
  keyVerified: boolean;
  keyMatches: boolean;
  walletConnected: boolean;
  exitCapacity: "checking" | "ready" | "exhausted" | "unknown";
  preparationRejected?: boolean;
  pendingClaim?: boolean;
  nowSeconds: number;
}

function timestamp(value: string): bigint | undefined {
  return /^\d+$/.test(value) ? BigInt(value) : undefined;
}

/** Display guidance only; authoritative checks remain in the action handlers. */
export function successorRecoveryGuidance(input: SuccessorRecoveryGuidanceInput): { now: string } {
  const snapshot = input.snapshot?.exists ? input.snapshot : undefined;
  if (snapshot?.state === "3") return { now: "Review the completed recovery" };
  if (snapshot?.state === "4") return { now: "Review the reserve returned to its owner" };
  if (!input.keyVerified) return { now: "Secure your successor key" };
  if (input.invitationValid && !input.keyMatches) return { now: "Restore the designated successor key" };
  if (!input.invitationValid) return { now: "Import the recovery invitation" };
  if (!snapshot) return { now: "Read the live reserve" };
  if (input.pendingClaim) {
    return { now: input.walletConnected ? "Reconcile the pending private recovery" : "Connect Ready X to reconcile recovery" };
  }

  const nowSeconds = Math.floor(input.nowSeconds);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return { now: "Refresh the live reserve" };
  const now = BigInt(nowSeconds);
  if (snapshot.state === "1") {
    const lastHeartbeat = timestamp(snapshot.lastHeartbeat);
    const inactivitySeconds = timestamp(snapshot.inactivitySeconds);
    if (lastHeartbeat === undefined || inactivitySeconds === undefined) return { now: "Refresh the live reserve" };
    return { now: now >= lastHeartbeat + inactivitySeconds ? "Request recovery" : "Wait until inactivity expires" };
  }
  if (snapshot.state !== "2") return { now: "Refresh the live reserve" };
  const claimAfter = timestamp(snapshot.claimAfter);
  if (claimAfter === undefined) return { now: "Refresh the live reserve" };
  if (now < claimAfter) return { now: "Wait for the grace period to finish" };
  if (!input.walletConnected) return { now: "Connect Ready X to continue recovery" };
  if (input.preparationRejected) return { now: "Check preparation only — no claim" };
  if (input.exitCapacity === "checking") return { now: "Checking sponsored recovery capacity" };
  if (input.exitCapacity === "unknown") return { now: "Check sponsored recovery capacity again" };
  if (input.exitCapacity === "exhausted") return { now: "Wait for sponsored recovery capacity" };
  return { now: "Recover privately after validation" };
}
