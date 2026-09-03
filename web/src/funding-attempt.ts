import { parseInvitation, type RecoveryInvitation } from "./model.ts";

export type PendingFundingAttempt = Readonly<{
  invitation: RecoveryInvitation;
  transactionHash?: string;
  preparedAt: string;
}>;

export type TransactionOutcome = "succeeded" | "reverted" | "rejected" | "unknown";

export interface AvailableLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: object | null) => Promise<T>,
  ): Promise<T>;
}

export async function withAvailableExclusiveLock<T>(
  lockManager: AvailableLockManager | undefined,
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!lockManager) throw new Error("This browser cannot safely serialize private funding across tabs. Use a current supported desktop browser.");
  return lockManager.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("Another Afterlight tab is already preparing a reserve. Finish or close that attempt first.");
    return action();
  });
}

export async function executeFundingSequence(input: {
  invitation: RecoveryInvitation;
  checkpoint: () => Promise<string>;
  invoke: () => Promise<string>;
  waitForSuccess: (transactionHash: string) => Promise<void>;
  onCheckpoint?: (transactionHash: string) => void;
  onPrepared?: (invitation: RecoveryInvitation) => void;
  onSubmitted?: (transactionHash: string) => void;
}): Promise<string> {
  const checkpointHash = await input.checkpoint();
  input.onCheckpoint?.(checkpointHash);
  input.onPrepared?.(input.invitation);
  const transactionHash = await input.invoke();
  input.onSubmitted?.(transactionHash);
  await input.waitForSuccess(transactionHash);
  return transactionHash;
}

export function classifyTransactionOutcome(executionStatus: unknown, finalityStatus: unknown): TransactionOutcome {
  if (finalityStatus === "REJECTED") return "rejected";
  const accepted = finalityStatus === "ACCEPTED_ON_L2" || finalityStatus === "ACCEPTED_ON_L1";
  if (!accepted) return "unknown";
  if (executionStatus === "SUCCEEDED") return "succeeded";
  if (executionStatus === "REVERTED") return "reverted";
  return "unknown";
}

export function isExplicitWalletRejection(error: unknown, depth = 0): boolean {
  if (depth > 2 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === 113 || candidate.code === 4001 || candidate.code === "113" || candidate.code === "4001") return true;
  return candidate.cause === error ? false : isExplicitWalletRejection(candidate.cause, depth + 1);
}

export function parsePendingFundingAttempt(value: string | null): PendingFundingAttempt | undefined {
  try {
    const parsedValue = JSON.parse(value ?? "null") as Partial<PendingFundingAttempt> | null;
    if (!parsedValue || typeof parsedValue.preparedAt !== "string" || !Number.isFinite(Date.parse(parsedValue.preparedAt))) return undefined;
    if (
      parsedValue.transactionHash !== undefined
      && (typeof parsedValue.transactionHash !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(parsedValue.transactionHash))
    ) return undefined;
    const invitation = parseInvitation(JSON.stringify(parsedValue.invitation));
    if (!invitation.valid) return undefined;
    return Object.freeze({
      invitation: invitation.invitation,
      transactionHash: parsedValue.transactionHash === undefined
        ? undefined
        : `0x${BigInt(parsedValue.transactionHash).toString(16)}`,
      preparedAt: parsedValue.preparedAt,
    });
  } catch {
    return undefined;
  }
}
