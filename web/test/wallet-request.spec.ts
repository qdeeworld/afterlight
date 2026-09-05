import { describe, expect, it, vi } from "vitest";
import { ReadyAuthorizationError, walletAuthorizationResult, walletRequest } from "../src/wallet-request.ts";

describe("connection request deadline", () => {
  it("identifies the failed permission stage without replaying the request", async () => {
    const request = Promise.reject(new Error("Not preauthorized"));
    await expect(walletRequest(request, "the network check")).rejects.toThrow("permission during the network check");
    await expect(walletAuthorizationResult(Promise.reject({ message: "Not preauthorized" }), "simulated preparation")).rejects.toBeInstanceOf(ReadyAuthorizationError);
    await expect(walletAuthorizationResult(Promise.reject(new Error("Proof failed")), "final preparation")).rejects.toThrow("Proof failed");
  });
  it("returns successful responses and preserves wallet rejection", async () => {
    await expect(walletRequest(Promise.resolve(["0x123"]), "connection")).resolves.toEqual(["0x123"]);
    await expect(walletRequest(Promise.reject(new Error("User rejected")), "connection")).rejects.toThrow("User rejected");
  });
  it("times out without retrying or accepting a late wallet response", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: string) => void;
      const request = new Promise<string>((done) => { resolve = done; });
      const result = walletRequest(request, "connection", 100);
      const rejected = expect(result).rejects.toThrow("Ready X did not answer connection");
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      resolve("late response");
      await expect(result).rejects.toThrow("earlier wallet request may still be pending");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
