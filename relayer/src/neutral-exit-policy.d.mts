export type ExitPolicyResult = Readonly<{
  networkCapFri: bigint;
  amountMarginBps: bigint;
  priceMarginBps: bigint;
}>;

export type ValidatedExit = Readonly<{
  action: "CLAIM" | "CANCEL_REFUND";
  actionPolicy: Readonly<{ requiredState: bigint; finalState: bigint; roleNonceIndex: number; eventName: string; eventSelector: string }>;
  metadata: Readonly<{
    vaultId: string;
    expectedState: string;
    expectedEpoch: string;
    expectedRoleNonce: string;
    destinationNoteId: string;
    validUntil: string;
    preparedAtBlock: bigint;
  }>;
  call: Readonly<{ contractAddress: string; entrypoint: string; calldata: readonly string[] }>;
  proof: Readonly<{
    data: string;
    output: readonly bigint[];
    facts: Readonly<{ facts: readonly string[]; baseBlockNumber: bigint; messageHash: string }>;
  }>;
  bindingSha256: string;
}>;

export type ResourceBounds = Readonly<{
  l1_gas: Readonly<{ max_amount: bigint; max_price_per_unit: bigint }>;
  l1_data_gas: Readonly<{ max_amount: bigint; max_price_per_unit: bigint }>;
  l2_gas: Readonly<{ max_amount: bigint; max_price_per_unit: bigint }>;
}>;

export const LOCKED_AFTERLIGHT_ADDRESS: string;
export const LOCKED_AMOUNT_FRI: bigint;
export const LOCKED_NEUTRAL_ADDRESS: string;
export const LOCKED_POOL_ADDRESS: string;
export const LOCKED_POOL_CLASS_HASH: string;
export const LOCKED_TOKEN_ADDRESS: string;
export const OPEN_NOTE_PACKED_VALUE: bigint;
export const PROOF1_HEADER: string;

export function validatePolicy(policy: unknown): ExitPolicyResult;
export function buildExitLocks(input: unknown): Readonly<{
  callSha256: string;
  proofDataSha256: string;
  proofOutputSha256: string;
  proofFactsSha256: string;
  bindingSha256: string;
}>;
export function validatePreparedExitPackage(input: unknown, policy: unknown): ValidatedExit;
export function proofFactsForFeeEstimate(raw: readonly string[]): readonly string[];
export function parseResourceBounds(value: unknown): ResourceBounds;
export function addResourceMargins(bounds: ResourceBounds, amountMarginBps: bigint, priceMarginBps: bigint): ResourceBounds;
export function resourceCapFri(bounds: ResourceBounds): bigint;
export function parseU256Result(result: readonly string[], label?: string): bigint;
export function parseVaultResult(result: readonly string[]): Readonly<{ raw: readonly bigint[] }>;
export function validateLiveExitState(validated: ValidatedExit, vault: unknown, timestamp: bigint): unknown;
export function validateAuthorizationInclusionWindow(validUntil: string, blockTimestamp: bigint, wallClockTimestamp: bigint): bigint;
export function validateAllowanceForAction(action: string, allowance: bigint): bigint;
export function validateBalanceForExit(balance: bigint, resourceCap: bigint, healthFloor?: bigint): unknown;
export function assertProofFreshness(baseBlock: bigint, liveBlock: bigint, validityBlocks: bigint): bigint;
export function assertSignedExitTransaction(signed: unknown, expected: unknown): boolean;
export function assertOuterSignatureMatchesHash(signed: unknown, publicKey?: string): string;
export function normalizeHex(value: string, label?: string): string;
export function safePublicError(error: unknown): string;
