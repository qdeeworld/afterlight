import { describe, expect, it, vi } from "vitest";
import { requestSponsorCapacity } from "../src/capacity.ts";
import { ROLE_BOUND_SETUP_POLICY } from "../../client/src/setup-authorization.mjs";

function health(status: string, fundingStatus: string): Response {
  return new Response(JSON.stringify({
    submission: "enabled",
    claimCapacity: { status, fundingStatus },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("browser sponsor-capacity checks", () => {
  it("enables setup only for the exact explicitly enabled policy", async () => {
    for (const setupSponsorship of [undefined, {}, { enabled: false, policy: ROLE_BOUND_SETUP_POLICY }, { enabled: "true", policy: ROLE_BOUND_SETUP_POLICY }, { enabled: true, policy: "future-policy" }, { enabled: true, policy: ROLE_BOUND_SETUP_POLICY }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        submission: "enabled", claimCapacity: { status: "ready", fundingStatus: "ready" }, setupSponsorship,
      })));
      const result = await requestSponsorCapacity("https://relay.invalid/health", { fetcher, retryDelaysMs: [0] });
      expect(result.setupPolicy).toBe(setupSponsorship?.enabled === true && setupSponsorship.policy === ROLE_BOUND_SETUP_POLICY ? ROLE_BOUND_SETUP_POLICY : undefined);
    }
  });
  it("returns a ready browser-origin capacity response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(health("ready", "ready"));
    await expect(requestSponsorCapacity("https://relay.invalid/health", {
      fetcher,
      retryDelaysMs: [0],
    })).resolves.toEqual({ exit: "ready", funding: "ready" });
    expect(fetcher).toHaveBeenCalledWith("https://relay.invalid/health", expect.objectContaining({
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }));
  });

  it("retries a transient unknown response before disabling funding", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(health("unknown", "unknown"))
      .mockResolvedValueOnce(health("ready", "ready"));
    const wait = vi.fn(async () => undefined);
    await expect(requestSponsorCapacity("https://relay.invalid/health", {
      fetcher,
      retryDelaysMs: [0, 400],
      wait,
    })).resolves.toEqual({ exit: "ready", funding: "ready" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(400);
  });

  it("does not retry an authoritative exhausted response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(health("ready", "exhausted"));
    await expect(requestSponsorCapacity("https://relay.invalid/health", {
      fetcher,
      retryDelaysMs: [0, 400, 1_200],
    })).resolves.toEqual({ exit: "ready", funding: "exhausted" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed after repeated malformed responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(requestSponsorCapacity("https://relay.invalid/health", {
      fetcher,
      retryDelaysMs: [0, 1],
      wait: async () => undefined,
    })).rejects.toThrow("invalid_sponsor_health");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
