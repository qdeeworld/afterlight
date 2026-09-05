import type { ExitProgressStage } from "./operations.ts";

export function exitProgressCopy(stage: ExitProgressStage): string {
  return {
    destination: "Ready preparation 1 of 2: prepare the private destination. Approve in Ready if prompted, then return here. This is not the claim submission.",
    "setup-consent": "Approval needed in Afterlight: review the private token setup. No claim has been signed or submitted yet.",
    "final-proof": "Ready preparation 2 of 2: prepare the final proof. Approve in Ready if prompted. Keep this tab open; do not restart recovery.",
    "verify-proof": "Checking the final proof, exact 1 STRK amount and private destination. No claim has been submitted yet.",
    sponsor: "The sponsor is checking this exact transaction and reserving its fees. Keep this tab open.",
    broadcast: "Submitting the sponsor-signed transaction to Starknet Mainnet. Do not start another recovery attempt.",
    confirmation: "Waiting for Mainnet confirmation of this exact transaction. No further approval is needed. Do not claim again.",
  }[stage];
}

/** Receipt success is independent of whether the private-wallet read succeeds. */
export async function checkSettledBalance(read: () => Promise<bigint>, before: bigint, isCurrent: () => boolean = () => true): Promise<{
  balance?: bigint;
  confirmed: boolean;
}> {
  try {
    if (!isCurrent()) return { confirmed: false };
    const balance = await read();
    if (!isCurrent()) return { confirmed: false };
    return { balance, confirmed: balance === before + 10n ** 18n };
  } catch {
    return { confirmed: false };
  }
}
