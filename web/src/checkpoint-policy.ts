const RETRYABLE_CHECKPOINT_CODES = new Set([
  "internal_error",
  "receipt_unreconciled",
  "relayer_busy",
  "simulation_failed",
  "submission_mismatch",
  "submission_uncertain",
]);

export function isRetryableCheckpointCode(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_CHECKPOINT_CODES.has(code);
}
