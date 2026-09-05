export class ReadyAuthorizationError extends Error {
  constructor(stage: string) {
    super(`Ready X could not confirm permission during ${stage}. Unlock Ready X and reconnect this site. This does not clear your key or invitation. No transaction was submitted by this step.`);
    this.name = "ReadyAuthorizationError";
  }
}

/** Label permission failures without logging wallet payloads or replaying requests. */
export async function walletAuthorizationResult<T>(request: Promise<T>, stage: string): Promise<T> {
  try { return await request; } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
    if (message.trim().toLowerCase() === "not preauthorized") throw new ReadyAuthorizationError(stage);
    throw error;
  }
}

/** Bound read/connection requests only. Never use this to retry a transaction. */
export async function walletRequest<T>(request: Promise<T>, stage: string, timeoutMs = 25_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      walletAuthorizationResult(request, stage),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Ready X did not answer ${stage}. Open and unlock the extension, check that it can access this site, then retry Connect. This check did not submit a transaction. The earlier wallet request may still be pending.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
