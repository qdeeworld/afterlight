export const DEFAULT_READ_ONLY_RPC_TIMEOUT_MS = 12_000;

export type JsonRpcFetch = (input: string, init: RequestInit) => Promise<Response>;

export type ReadJsonRpcOptions = Readonly<{
  fetcher?: JsonRpcFetch;
  timeoutMs?: number;
}>;

/** A bounded, read-only JSON-RPC request with no URL or payload in its errors. */
export async function readJsonRpc<T>(
  url: string,
  method: string,
  params: readonly unknown[],
  options: ReadJsonRpcOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_ONLY_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Read-only RPC timeout must be between 1 and 60000 ms.");
  }
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new Error("Read-only RPC timed out.");
    if (!response.ok) throw new Error(`Read-only RPC failed with HTTP ${response.status}.`);

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new Error("Read-only RPC returned invalid JSON.");
    }
    if (controller.signal.aborted) throw new Error("Read-only RPC timed out.");
    if (!isRecord(envelope) || envelope.id !== 1 || envelope.jsonrpc !== "2.0") {
      throw new Error("Read-only RPC returned an invalid JSON-RPC envelope.");
    }
    if ("error" in envelope) throw new Error("Read-only RPC returned an error.");
    if (!("result" in envelope)) throw new Error("Read-only RPC omitted its result.");
    return envelope.result as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Read-only RPC timed out.");
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
