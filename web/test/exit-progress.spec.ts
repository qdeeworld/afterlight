import { describe, expect, it, vi } from "vitest";
import { checkSettledBalance, exitProgressCopy } from "../src/exit-progress.ts";

describe("exit progress and settled balance", () => {
  it("distinguishes the two Ready preparations from consent and submission", () => {
    expect(exitProgressCopy("destination")).toContain("1 of 2");
    expect(exitProgressCopy("setup-consent")).toContain("Afterlight");
    expect(exitProgressCopy("final-proof")).toContain("2 of 2");
    expect(exitProgressCopy("verify-proof")).toContain("No claim has been submitted");
    expect(exitProgressCopy("confirmation")).toContain("Do not claim again");
  });

  it("requires the exact increase, not just any positive private balance", async () => {
    await expect(checkSettledBalance(async () => 10n ** 18n, 0n)).resolves.toEqual({ balance: 10n ** 18n, confirmed: true });
    await expect(checkSettledBalance(async () => 1n, 0n)).resolves.toEqual({ balance: 1n, confirmed: false });
    await expect(checkSettledBalance(async () => 2n * 10n ** 18n, 0n)).resolves.toEqual({ balance: 2n * 10n ** 18n, confirmed: false });
  });

  it("treats an unavailable wallet read as pending, never a failed settlement or retry", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("Ready timeout")).mockResolvedValueOnce(10n ** 18n);
    await expect(checkSettledBalance(read, 0n)).resolves.toEqual({ confirmed: false });
    expect(read).toHaveBeenCalledTimes(1);
    await expect(checkSettledBalance(read, 0n)).resolves.toEqual({ balance: 10n ** 18n, confirmed: true });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("discards a balance arriving after the connected wallet changed", async () => {
    let current = true;
    const read = vi.fn(async () => { current = false; return 10n ** 18n; });
    await expect(checkSettledBalance(read, 0n, () => current)).resolves.toEqual({ confirmed: false });
  });
});
