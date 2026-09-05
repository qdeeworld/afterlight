import { describe, expect, it } from "vitest";
import { roleNavigationUrl } from "../src/navigation.ts";

describe("role navigation", () => {
  it("keeps diagnostic mode when choosing successor", () => {
    expect(roleNavigationUrl("https://afterlight.dolepee.com/?diagnoseExit=1", "successor"))
      .toBe("/?diagnoseExit=1&role=successor");
  });
  it("preserves path, other parameters and hash across both roles", () => {
    const successor = roleNavigationUrl("https://afterlight.dolepee.com/app?role=owner&diagnoseExit=1#recover", "successor");
    expect(successor).toBe("/app?role=successor&diagnoseExit=1#recover");
    expect(roleNavigationUrl(`https://afterlight.dolepee.com${successor}`, "owner"))
      .toBe("/app?role=owner&diagnoseExit=1#recover");
  });
});
