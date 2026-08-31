export type SponsorCapacityState = "ready" | "exhausted" | "unknown";

export type SponsorCapacity = Readonly<{
  exit: SponsorCapacityState;
  funding: SponsorCapacityState;
}>;

type HealthBody = Readonly<{
  submission?: string;
  claimCapacity?: Readonly<{
    status?: string;
    fundingStatus?: string;
  }>;
}>;

type CapacityRequestOptions = Readonly<{
  fetcher?: typeof fetch;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}>;

const DEFAULT_RETRY_DELAYS_MS = [0, 400, 1_200] as const;

function normalize(value: string | undefined): SponsorCapacityState {
  return value === "ready" ? "ready" : value === "exhausted" ? "exhausted" : "unknown";
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export async function requestSponsorCapacity(
  healthUrl: string,
  options: CapacityRequestOptions = {},
): Promise<SponsorCapacity> {
  const fetcher = options.fetcher ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const wait = options.wait ?? delay;
  let lastError: unknown;
  let lastCapacity: SponsorCapacity | undefined;

  for (const retryDelayMs of retryDelaysMs) {
    if (retryDelayMs > 0) await wait(retryDelayMs);
    try {
      const response = await fetcher(healthUrl, {
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const body = await response.json() as HealthBody;
      if (!response.ok || body.submission !== "enabled" || body.claimCapacity === undefined) {
        throw new Error("invalid_sponsor_health");
      }
      lastCapacity = {
        exit: normalize(body.claimCapacity.status),
        funding: normalize(body.claimCapacity.fundingStatus),
      };
      if (lastCapacity.exit !== "unknown" && lastCapacity.funding !== "unknown") return lastCapacity;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastCapacity !== undefined) return lastCapacity;
  throw lastError instanceof Error ? lastError : new Error("sponsor_health_unavailable");
}
