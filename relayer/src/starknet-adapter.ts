import {
  Account,
  RpcProvider,
  stark,
  transaction,
  type Call,
  type CairoVersion,
  type ResourceBoundsBN,
} from "starknet";

import type { RelayPlan } from "./core.js";
import { assertOuterSignatureMatchesHash } from "./neutral-exit-policy.mjs";
import {
  type ExactFeeQuote,
  type ExactReceipt,
  type ExactSimulation,
  type ExactSubmission,
  type StarknetRelayAdapter,
  type SuccessfulExactSimulation,
} from "./executor.js";

/** Starknet v3 adapter. It never estimates again after the budget reservation. */
export class StarknetV3RelayAdapter implements StarknetRelayAdapter {
  private readonly provider: RpcProvider;
  private readonly account: Account;
  private readonly chainId: string;
  private readonly cairoVersion: CairoVersion;
  private readonly token: string;

  constructor(env: Env) {
    this.provider = new RpcProvider({
      nodeUrl: env.STARKNET_RPC_URL,
      headers: { authorization: `Bearer ${env.STARKNET_RPC_AUTH_TOKEN}` },
      plugins: false,
    });
    this.cairoVersion = env.RELAYER_ACCOUNT_CAIRO_VERSION as CairoVersion;
    this.account = new Account({
      provider: this.provider,
      address: env.RELAYER_ACCOUNT_ADDRESS,
      signer: env.RELAYER_ACCOUNT_PRIVATE_KEY,
      cairoVersion: this.cairoVersion,
    });
    this.chainId = normalizeHex(env.STARKNET_CHAIN_ID);
    this.token = normalizeHex(env.STRK_TOKEN);
  }

  async simulateExact(plan: RelayPlan): Promise<ExactSimulation> {
    try {
      await this.assertChain(plan);
      const nonce = await this.account.getNonce("pre_confirmed");
      const estimate = await this.account.estimateInvokeFee(toCall(plan), { nonce });
      const quotedFeeFri = stark.resourceBoundsToEstimateFeeResponse(
        estimate.resourceBounds,
      ).overall_fee;
      if (quotedFeeFri <= 0n) return { ok: false };
      return {
        ok: true,
        callFingerprint: plan.fingerprint,
        quotedFeeFri: quotedFeeFri.toString(),
        feeQuote: Object.freeze({
          nonce: BigInt(nonce).toString(),
          resourceBounds: freezeBounds(estimate.resourceBounds),
        }),
      };
    } catch {
      return { ok: false };
    }
  }

  async signAndSubmitExact(
    plan: RelayPlan,
    simulation: SuccessfulExactSimulation,
    transactionMaxFeeFri: string,
    persistPrepared: (expectedTransactionHash: string, preparedPayload: string) => Promise<void>,
  ): Promise<ExactSubmission> {
    let signed;
    let expectedHash: string;
    try {
      await this.assertChain(plan);
      if (simulation.callFingerprint !== plan.fingerprint) return { submitted: false };
      const bounds = parseBounds(simulation.feeQuote);
      if (resourceCap(bounds) > strictPositiveDecimal(transactionMaxFeeFri)) {
        return { submitted: false };
      }
      const liveNonce = BigInt(await this.account.getNonce("pre_confirmed"));
      const quotedNonce = strictNonNegativeDecimal(simulation.feeQuote.nonce);
      if (liveNonce !== quotedNonce) return { submitted: false };

      const expectedCalldata = transaction.getExecuteCalldata([toCall(plan)], this.cairoVersion);
      signed = await this.account.getSignedTransaction(toCall(plan), {
        nonce: quotedNonce,
        resourceBounds: bounds,
      });
      if (
        normalizeHex(signed.sender_address) !== normalizeHex(this.account.address) ||
        !sameFelts(signed.calldata, expectedCalldata) ||
        resourceCap(stark.resourceBoundsToBigInt(signed.resource_bounds)) >
          strictPositiveDecimal(transactionMaxFeeFri)
      ) {
        return { submitted: false };
      }
      expectedHash = normalizeHex(assertOuterSignatureMatchesHash(signed));
      await persistPrepared(expectedHash, serializeSignedTransaction(signed));
    } catch {
      // Every operation above precedes broadcast, including durable persistence
      // of the exact signed artifact and deterministic transaction hash.
      return { submitted: false };
    }
    const response = await this.provider.invokeSignedTx(signed);
    if (normalizeHex(response.transaction_hash) !== expectedHash) throw new Error("submission_mismatch");
    return {
      submitted: true,
      transactionHash: expectedHash,
      callFingerprint: plan.fingerprint,
      transactionMaxFeeFri,
    };
  }

  async rebroadcastPreparedExact(
    plan: RelayPlan,
    transactionMaxFeeFri: string,
    expectedTransactionHash: string,
    preparedPayload: string,
  ): Promise<void> {
    const signed = parseSignedTransaction(preparedPayload);
    if (
      normalizeHex(String(signed.sender_address)) !== normalizeHex(this.account.address) ||
      !Array.isArray(signed.calldata) ||
      !sameFelts(signed.calldata as string[], transaction.getExecuteCalldata([toCall(plan)], this.cairoVersion)) ||
      resourceCap(stark.resourceBoundsToBigInt(
        signed.resource_bounds as Parameters<typeof stark.resourceBoundsToBigInt>[0],
      )) > strictPositiveDecimal(transactionMaxFeeFri) ||
      normalizeHex(assertOuterSignatureMatchesHash(signed)) !== normalizeHex(expectedTransactionHash)
    ) {
      throw new Error("prepared_submission_mismatch");
    }
    const response = await this.provider.invokeSignedTx(signed as Parameters<RpcProvider["invokeSignedTx"]>[0]);
    if (normalizeHex(response.transaction_hash) !== normalizeHex(expectedTransactionHash)) {
      throw new Error("submission_mismatch");
    }
  }

  async reconcileReceipt(transactionHash: string, plan: RelayPlan): Promise<ExactReceipt> {
    await this.assertChain(plan);
    const normalizedHash = normalizeHex(transactionHash);
    let receipt: Awaited<ReturnType<RpcProvider["getTransactionReceipt"]>> | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const candidate = await this.provider.getTransactionReceipt(normalizedHash);
        if (!candidate.isError()) {
          receipt = candidate;
          break;
        }
      } catch {
        // RPC propagation can lag the accepted broadcast. Keep the single
        // submitted reservation serialized while waiting for its receipt.
      }
      if (attempt < 29) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (receipt === undefined) return { status: "pending" };
    const submitted = await this.provider.getTransactionByHash(normalizedHash);
    const candidate = submitted as unknown as Record<string, unknown>;
    if (
      candidate.type !== "INVOKE" ||
      typeof candidate.sender_address !== "string" ||
      normalizeHex(candidate.sender_address) !== normalizeHex(this.account.address) ||
      !Array.isArray(candidate.calldata) ||
      !sameFelts(
        candidate.calldata as string[],
        transaction.getExecuteCalldata([toCall(plan)], this.cairoVersion),
      )
    ) {
      return { status: "rejected" };
    }
    const raw = receipt.value as unknown as Record<string, unknown>;
    const actualFeeFri = readActualFeeFri(raw.actual_fee);
    if (actualFeeFri === undefined) return { status: "pending" };
    return {
      status: "accepted",
      execution: receipt.isReverted() ? "reverted" : "succeeded",
      transactionHash: normalizedHash,
      callFingerprint: plan.fingerprint,
      actualFeeFri,
    };
  }

  async readRelayerBalance(): Promise<string> {
    const result = await this.provider.callContract({
      contractAddress: this.token,
      entrypoint: "balanceOf",
      calldata: [this.account.address],
    });
    if (result.length < 2 || result[0] === undefined || result[1] === undefined) {
      throw new Error("receipt_unreconciled");
    }
    return (BigInt(result[0]) + (BigInt(result[1]) << 128n)).toString();
  }

  private async assertChain(plan: RelayPlan): Promise<void> {
    const rpcChain = normalizeHex(await this.provider.getChainId());
    if (rpcChain !== this.chainId || normalizeHex(plan.chainId) !== this.chainId) {
      throw new Error("executor_config_incomplete");
    }
  }
}

/** Pure audit hook: maximum FRI encoded by one frozen simulation quote. */
export function resourceBoundsCapFri(quote: ExactFeeQuote): bigint {
  return resourceCap(parseBounds(quote));
}

/** Pure audit hook for exact account execute calldata reconciliation. */
export function executeCalldataMatchesPlan(
  plan: RelayPlan,
  cairoVersion: CairoVersion,
  calldata: readonly string[],
): boolean {
  return sameFelts(calldata, transaction.getExecuteCalldata([toCall(plan)], cairoVersion));
}

function toCall(plan: RelayPlan): Call {
  return {
    contractAddress: plan.call.contractAddress,
    entrypoint: plan.call.entrypoint,
    calldata: [...plan.call.calldata],
  };
}

function freezeBounds(bounds: ResourceBoundsBN): ExactFeeQuote["resourceBounds"] {
  const normalized = {
    l1_gas: normalizeBound(bounds.l1_gas),
    l1_data_gas: normalizeBound(bounds.l1_data_gas),
    l2_gas: normalizeBound(bounds.l2_gas),
  };
  Object.freeze(normalized.l1_gas);
  Object.freeze(normalized.l1_data_gas);
  Object.freeze(normalized.l2_gas);
  return Object.freeze(normalized);
}

function normalizeBound(bound: { max_amount: bigint; max_price_per_unit: bigint }) {
  return {
    max_amount: bound.max_amount.toString(),
    max_price_per_unit: bound.max_price_per_unit.toString(),
  };
}

function parseBounds(quote: ExactFeeQuote): ResourceBoundsBN {
  const parse = (bound: ExactFeeQuote["resourceBounds"]["l1_gas"]) => ({
    max_amount: strictNonNegativeDecimal(bound.max_amount),
    max_price_per_unit: strictNonNegativeDecimal(bound.max_price_per_unit),
  });
  return {
    l1_gas: parse(quote.resourceBounds.l1_gas),
    l1_data_gas: parse(quote.resourceBounds.l1_data_gas),
    l2_gas: parse(quote.resourceBounds.l2_gas),
  };
}

function resourceCap(bounds: ResourceBoundsBN): bigint {
  return stark.resourceBoundsToEstimateFeeResponse(bounds).overall_fee;
}

function sameFelts(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((felt, index) => {
    const wanted = expected[index];
    return wanted !== undefined && normalizeFelt(felt) === normalizeFelt(wanted);
  });
}

function normalizeFelt(value: string): string {
  if (!/^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(value)) {
    throw new TypeError("invalid felt value");
  }
  return BigInt(value).toString();
}

function normalizeHex(value: string): string {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new TypeError("invalid hex value");
  return `0x${BigInt(value).toString(16)}`;
}

function strictPositiveDecimal(value: string): bigint {
  const parsed = strictNonNegativeDecimal(value);
  if (parsed === 0n) throw new TypeError("zero is not a positive decimal");
  return parsed;
}

function strictNonNegativeDecimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError("invalid decimal");
  return BigInt(value);
}

export function readActualFeeFri(value: unknown): string | undefined {
  if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value).toString();
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const amount = record.amount;
  if (record.unit !== "FRI") return undefined;
  return typeof amount === "string" && /^0x[0-9a-f]+$/i.test(amount)
    ? BigInt(amount).toString()
    : undefined;
}

function serializeSignedTransaction(signed: unknown): string {
  const payload = JSON.stringify(signed, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  if (payload.length < 2 || payload.length > 100_000) throw new TypeError("invalid prepared transaction");
  return payload;
}

function parseSignedTransaction(payload: string): Record<string, unknown> {
  if (payload.length < 2 || payload.length > 100_000) throw new TypeError("invalid prepared transaction");
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("invalid prepared transaction");
  }
  return parsed as Record<string, unknown>;
}
