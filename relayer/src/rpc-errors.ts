export function rpcErrorCode(error: unknown): number | undefined {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
  const base = typeof record?.baseError === "object" && record.baseError !== null
    ? record.baseError as Record<string, unknown>
    : undefined;
  return typeof record?.code === "number"
    ? record.code
    : typeof base?.code === "number" ? base.code : undefined;
}

export function classifyBroadcastFailure(error: unknown): Readonly<{
  category: "rpc_execution" | "rpc_transaction_nonce" | "rpc_validate_resources" | "rpc_account_balance" | "rpc_validation" | "rpc_duplicate" | "rpc_other" | "transport_or_unknown";
  definitiveReject: boolean;
}> {
  const code = rpcErrorCode(error);
  if (code === 41) return { category: "rpc_execution", definitiveReject: true };
  if (code === 52) return { category: "rpc_transaction_nonce", definitiveReject: true };
  if (code === 53) return { category: "rpc_validate_resources", definitiveReject: true };
  if (code === 54) return { category: "rpc_account_balance", definitiveReject: true };
  if (code === 55) return { category: "rpc_validation", definitiveReject: true };
  if (code === 59) return { category: "rpc_duplicate", definitiveReject: false };
  if (code !== undefined) return { category: "rpc_other", definitiveReject: false };
  return { category: "transport_or_unknown", definitiveReject: false };
}
