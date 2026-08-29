import { describe, expect, it } from "vitest";
import { CONTRACT } from "../src/config.ts";
import { isCompatibleReadyVersion } from "../src/compatibility.ts";
import { parseInvitation } from "../src/model.ts";

const invitation = {
  version: 1,
  chain: "SN_MAIN",
  contract: CONTRACT,
  vaultId: "0x123",
  ownerKey: "0x456",
  successorKey: "0x789",
  token: "STRK",
  amount: "1",
  mode: "NORMAL",
  inactivitySeconds: "2592000",
  graceSeconds: "604800",
};

describe("public product compatibility", () => {
  it.each(["5.33.9", "5.34.0", "5.99.1", "5.33.9+ready.1"])("accepts compatible Ready %s", (version) => {
    expect(isCompatibleReadyVersion(version)).toBe(true);
  });

  it.each(["5.33.8", "5.33.9-beta.1", "4.99.0", "6.0.0", "latest", ""])("rejects incompatible Ready %s", (version) => {
    expect(isCompatibleReadyVersion(version)).toBe(false);
  });

  it("accepts the exact NORMAL terms exposed as the canonical product", () => {
    expect(parseInvitation(JSON.stringify(invitation))).toMatchObject({ valid: true });
  });

  it("accepts only the exact contract-enforced Recovery Drill terms", () => {
    expect(parseInvitation(JSON.stringify({
      ...invitation,
      mode: "FAST_DEMO",
      inactivitySeconds: "300",
      graceSeconds: "300",
    }))).toMatchObject({ valid: true });
    expect(parseInvitation(JSON.stringify({
      ...invitation,
      mode: "FAST_DEMO",
      inactivitySeconds: "301",
      graceSeconds: "300",
    }))).toMatchObject({ valid: false });
  });
});
