/** Bound read/connection requests only. Never use this to retry a transaction. */
export async function walletRequest<T>(request: Promise<T>, stage: string, timeoutMs = 25_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Ready X did not answer ${stage}. Open and unlock the extension, check that it can access this site, then retry Connect. No transaction was submitted. The earlier wallet request may still be pending.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
