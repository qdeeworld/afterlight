import { transaction } from "starknet";
import { describe, expect, it } from "vitest";

import type { RelayPlan } from "../src/core.js";
import {
  executeCalldataMatchesPlan,
  resourceBoundsCapFri,
} from "../src/starknet-adapter.js";
import type { ExactFeeQuote } from "../src/executor.js";

const plan: RelayPlan = {
  schema: "afterlight-relay-plan/1",
  operation: "HEARTBEAT",
  chainId: "0x534e5f4d41494e",
  fingerprint: "a".repeat(64),
  semanticKey: "b".repeat(64),
  call: {
    contractAddress: "0x1234",
    entrypoint: "heartbeat",
    calldata: ["0x1", "0x2"],
  },
  requiresContractSimulation: true,
  contractVerificationAuthoritative: true,
  maxSponsoredFeeFri: "1000",
  dailySponsorBudgetFri: "10000",
};

describe("Starknet v3 exactness helpers", () => {
  it("computes the complete signed resource-bounds cap", () => {
    const quote: ExactFeeQuote = {
      nonce: "7",
      resourceBounds: {
        l1_gas: { max_amount: "2", max_price_per_unit: "3" },
        l1_data_gas: { max_amount: "5", max_price_per_unit: "7" },
        l2_gas: { max_amount: "11", max_price_per_unit: "13" },
      },
    };
    expect(resourceBoundsCapFri(quote)).toBe(184n);
    expect(() =>
      resourceBoundsCapFri({
        ...quote,
        resourceBounds: {
          ...quote.resourceBounds,
          l1_gas: { max_amount: "01", max_price_per_unit: "3" },
        },
      }),
    ).toThrow();
  });

  it("matches only the exact Cairo account execute calldata", () => {
    const exact = transaction.getExecuteCalldata(
      [{ ...plan.call, calldata: [...plan.call.calldata] }],
      "1",
    );
    expect(executeCalldataMatchesPlan(plan, "1", exact)).toBe(true);
    expect(executeCalldataMatchesPlan(plan, "1", [...exact, "0x0"])).toBe(false);
    const redirected = [...exact];
    redirected[redirected.length - 1] = "0x999";
    expect(executeCalldataMatchesPlan(plan, "1", redirected)).toBe(false);
  });
});
