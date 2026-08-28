import { Account, RpcProvider, ec, transaction, type Call } from "starknet";
import { describe, expect, it, vi } from "vitest";

import {
  assertOuterSignatureMatchesHash,
  assertSignedExitTransaction,
} from "../src/neutral-exit-policy.mjs";

const MAINNET_CHAIN_ID = "0x534e5f4d41494e";
const LOCKED_NEUTRAL_ADDRESS = "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46";
const TEST_SIGNER = "0x12345";

describe("neutral exact-exit signing boundary", () => {
  it("signs the real proof facts and reconstructs the exact outer hash offline", async () => {
    const provider = new RpcProvider({ nodeUrl: "http://127.0.0.1:1", plugins: false });
    vi.spyOn(provider, "getChainId").mockResolvedValue(MAINNET_CHAIN_ID);

    const account = new Account({
      provider,
      address: LOCKED_NEUTRAL_ADDRESS,
      signer: TEST_SIGNER,
      cairoVersion: "1",
      transactionVersion: "0x3",
      plugins: false,
    });
    const call: Call = {
      contractAddress: "0x987654321",
      entrypoint: "privacy_invoke",
      calldata: ["0x1", "0x2", "0x3"],
    };
    const proof = "AQIDBA==";
    const proofFacts = ["0xabc", "0xdef"];
    const resourceBounds = {
      l1_gas: { max_amount: 2n, max_price_per_unit: 3n },
      l1_data_gas: { max_amount: 5n, max_price_per_unit: 7n },
      l2_gas: { max_amount: 11n, max_price_per_unit: 13n },
    };

    const signed = await account.getSignedTransaction(call, {
      nonce: 7n,
      resourceBounds,
      tip: 0,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      proof,
      proofFacts,
    });

    expect(assertSignedExitTransaction(signed, {
      nonce: 7n,
      executeCalldata: transaction.getExecuteCalldata([call], "1"),
      proof,
      proofFacts,
      resourceBounds,
      networkCapFri: 184n,
    })).toBe(true);

    const publicKey = ec.starkCurve.getStarkKey(TEST_SIGNER);
    expect(assertOuterSignatureMatchesHash(signed, publicKey)).toMatch(/^0x[0-9a-f]+$/);
  });
});
