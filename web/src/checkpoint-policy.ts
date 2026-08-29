const RETRYABLE_CHECKPOINT_CODES = new Set([
  "fee_policy_rejected",
  "internal_error",
  "receipt_unreconciled",
  "receipt_reverted",
  "relayer_busy",
  "simulation_failed",
  "simulation_mismatch",
  "signer_adapter_unavailable",
  "sponsorship_frozen",
  "sponsorship_invariant_breach",
  "submission_mismatch",
  "submission_not_started",
  "submission_uncertain",
]);

export function isRetryableCheckpointCode(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_CHECKPOINT_CODES.has(code);
}

export function isHashlessRelayedResult(
  status: string | undefined,
  resultStatus: string | undefined,
  transactionHash: string | null | undefined,
): boolean {
  return status === "relayed"
    && (resultStatus === "accepted" || resultStatus === "duplicate")
    && !transactionHash;
}
