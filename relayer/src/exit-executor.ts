import { Account, RpcProvider, transaction, type Call } from "starknet";
import type { BudgetCoordinator } from "./executor.js";
import {
  addResourceMargins,
  assertOuterSignatureMatchesHash,
  assertProofFreshness,
  assertSignedExitTransaction,
  normalizeHex,
  parseResourceBounds,
  parseU256Result,
  parseVaultResult,
  proofFactsForFeeEstimate,
  resourceCapFri,
  validateAllowanceForAction,
  validateAuthorizationInclusionWindow,
  validateBalanceForExit,
  validateLiveExitState,
  validatePolicy,
  validatePreparedExitPackage,
  type ValidatedExit,
} from "./neutral-exit-policy.mjs";

const EXIT_POLICY = Object.freeze({
  schema: "afterlight-neutral-exit-policy/1",
  chainId: "0x534e5f4d41494e",
  neutralAddress: "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46",
  neutralPublicKey: "0x0c041078765f888f2a22a0f68221011641879b222b657cc125014f18c2976ae",
  afterlightAddress: "0x06e8b6e49b4366e0dc6a35eee722b417c718988eca3f4a0c298bdf8785261c25",
  afterlightClassHash: "0x05da9866f62cc6dd1e380e8d9206e78a752b460abdb802070e0be1208ec7b1a6",
  poolAddress: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
  poolFeeCollector: "0x0d79041634625e5288296fbc648088788710ba44903a3a49468a66567749e77",
  tokenAddress: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  neutralClassHash: "0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381",
  fixedAmountFri: "1000000000000000000",
  poolFeeEachFri: "6000000000000000000",
  initialPoolAllowanceFri: "12000000000000000000",
  postSpendHealthFloorFri: "1000000000000000000",
  // The accepted E2 claim consumed about 2.832 STRK, while its full validated
  // resource-bounds reservation was 7.436710911292439270 STRK. Keep a narrow,
  // explicit ceiling above that proven reservation without weakening the
  // separate 1 STRK post-spend health floor.
  maxNetworkFeePerExitFri: "7500000000000000000",
  // The RPC response already supplies full resource bounds. Reusing those
  // exact bounds avoids compounding a 3% amount pad with a second 3% price pad
  // after the user-approved 7.5 STRK hard ceiling.
  amountMarginBps: "10000",
  priceMarginBps: "10000",
  maxEstimateAgeBlocks: "300",
  minimumRpcSpec: "0.10.1",
  starknetJsVersion: "10.7.0",
  starknetJsPackageSha256: "3a3b783706f1adde673f29c3afff69f6e7f57c2cfcff774b99110253e962c8e7",
  starknetJsModuleSha256: "7aa6f8c6e3df5d7016df991cb61997a76c4f1247e51c722489511712b99cb38a",
});

const POOL = EXIT_POLICY.poolAddress;
const TOKEN = EXIT_POLICY.tokenAddress;
const AFTERLIGHT = EXIT_POLICY.afterlightAddress;
const NEUTRAL = EXIT_POLICY.neutralAddress;

export class ExitExecutorError extends Error {
  constructor(readonly code: "invalid_exit" | "exit_unavailable" | "exit_busy" | "exit_uncertain" | "exit_reverted") {
    super(code);
    this.name = "ExitExecutorError";
  }
}

export type ExitResult = Readonly<{
  status: "accepted" | "duplicate";
  transactionHash: string | null;
  actualFeeFri?: string;
}>;

export async function executePreparedClaim(payload: string, env: Env, budget: BudgetCoordinator): Promise<ExitResult> {
  let decoded: unknown;
  try { decoded = JSON.parse(payload); } catch { throw new ExitExecutorError("invalid_exit"); }
  let validated: ValidatedExit;
  try {
    validated = validatePreparedExitPackage(decoded, EXIT_POLICY);
    if (validated.action !== "CLAIM") throw new Error("only_claim_is_public");
  } catch { throw new ExitExecutorError("invalid_exit"); }

  // The binding is already a domain-separated SHA-256 over the complete exit
  // package. Budget keys deliberately accept only canonical 64-hex digests.
  const semanticKey = validated.bindingSha256;
  const prior = await budget.lookup(semanticKey);
  if (prior.outcome === "found" && prior.state !== "released") {
    return { status: "duplicate", transactionHash: prior.transactionHash };
  }

  const provider = new RpcProvider({
    nodeUrl: env.STARKNET_RPC_URL,
    headers: { authorization: `Bearer ${env.STARKNET_RPC_AUTH_TOKEN}` },
    plugins: false,
  });
  try {
    if (normalizeHex(await provider.getChainId()) !== normalizeHex(EXIT_POLICY.chainId)) throw new Error("wrong_chain");
  } catch { throw exitStage("chain"); }
  const account = new Account({ provider, address: NEUTRAL, signer: env.RELAYER_ACCOUNT_PRIVATE_KEY, cairoVersion: "1", transactionVersion: "0x3", plugins: false });
  let policy;
  try { policy = validatePolicy(EXIT_POLICY); } catch { throw exitStage("policy"); }
  let estimateBlock;
  try { estimateBlock = await provider.getBlockWithTxHashes("latest"); } catch { throw exitStage("estimate_block"); }
  if (!("block_number" in estimateBlock) || !("block_hash" in estimateBlock)) throw new ExitExecutorError("exit_unavailable");
  const blockNumber = BigInt(estimateBlock.block_number);
  const blockTimestamp = BigInt(estimateBlock.timestamp);
  let snapshot;
  try { snapshot = await readSnapshot(provider, validated, blockNumber, blockTimestamp); } catch { throw exitStage("snapshot"); }
  try {
    validateAuthorizationInclusionWindow(validated.metadata.validUntil, blockTimestamp, BigInt(Math.floor(Date.now() / 1_000)));
  } catch { throw exitStage("inclusion_window"); }
  const proofFacts = validated.proof.facts.facts.map(hex);
  const call: Call = { contractAddress: validated.call.contractAddress, entrypoint: validated.call.entrypoint, calldata: validated.call.calldata.map(hex) };
  const estimateDetails = (facts: readonly string[]) => ({
    nonce: snapshot.nonce,
    blockIdentifier: Number(blockNumber),
    skipValidate: false,
    proof: validated.proof.data,
    proofFacts: [...facts],
    tip: 0,
    paymasterData: [],
    accountDeploymentData: [],
    nonceDataAvailabilityMode: "L1" as const,
    feeDataAvailabilityMode: "L1" as const,
  });
  let estimate;
  try {
    estimate = await account.estimateInvokeFee(call, estimateDetails(proofFacts));
  } catch (error) {
    if (rpcErrorCode(error) !== 41) throw exitStage(`estimate_${classifyEstimateFailure(error)}`);
    try {
      // Some Starknet estimators execute the SDK proof envelope (PROOF0), even
      // though accepted STRK20 transactions carry Ready's real PROOF1 facts.
      // Normalize only the estimate copy. The signed and broadcast transaction
      // below remains bound to the untouched real proof facts.
      const estimateFacts = proofFactsForFeeEstimate(validated.proof.facts.facts).map(hex);
      estimate = await account.estimateInvokeFee(call, estimateDetails(estimateFacts));
    } catch (fallbackError) {
      throw exitStage(`estimate_fallback_${classifyEstimateFailure(fallbackError)}`);
    }
  }
  let bounds;
  let networkCap;
  try {
    const sourceBounds = parseResourceBounds(estimate.resourceBounds);
    bounds = addResourceMargins(sourceBounds, policy.amountMarginBps, policy.priceMarginBps);
    networkCap = resourceCapFri(bounds);
    if (networkCap > policy.networkCapFri) throw new Error("network_cap");
    validateBalanceForExit(snapshot.balance, networkCap, BigInt(EXIT_POLICY.postSpendHealthFloorFri));
  } catch { throw exitStage("fee_and_balance"); }

  const reservation = await budget.reserve({
    dayKey: new Date().toISOString().slice(0, 10),
    semanticKey,
    exactFingerprint: validated.bindingSha256,
    maxFeeFri: networkCap.toString(),
    perCallCapFri: policy.networkCapFri.toString(),
    dailyBudgetFri: policy.networkCapFri.toString(),
    nowMs: Date.now(),
  });
  if (reservation.outcome !== "reserved") {
    const duplicate = await budget.lookup(semanticKey);
    return { status: "duplicate", transactionHash: duplicate.outcome === "found" ? duplicate.transactionHash : null };
  }

  let signed;
  let broadcastStarted = false;
  let submissionStage = "fresh_nonce";
  try {
    const freshNonce = BigInt(await account.getNonce("pre_confirmed"));
    submissionStage = "fresh_block";
    const freshBlock = await provider.getBlockWithTxHashes("latest");
    if (!("block_number" in freshBlock) || freshNonce !== snapshot.nonce || BigInt(freshBlock.block_number) - blockNumber > 300n) throw new Error("snapshot_changed");
    submissionStage = "fresh_snapshot";
    await readSnapshot(provider, validated, BigInt(freshBlock.block_number), BigInt(freshBlock.timestamp));
    submissionStage = "sign";
    signed = await account.getSignedTransaction(call, {
      nonce: snapshot.nonce,
      resourceBounds: bounds,
      tip: 0,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      proof: validated.proof.data,
      proofFacts,
    });
    submissionStage = "signed_assertions";
    assertSignedExitTransaction(signed, {
      nonce: snapshot.nonce,
      executeCalldata: transaction.getExecuteCalldata([call], "1"),
      proof: validated.proof.data,
      proofFacts,
      resourceBounds: bounds,
      networkCapFri: policy.networkCapFri,
    });
    submissionStage = "outer_hash";
    const expectedHash = assertOuterSignatureMatchesHash(signed);
    submissionStage = "broadcast";
    broadcastStarted = true;
    const response = await provider.invokeSignedTx(signed);
    const transactionHash = normalizeHex(response.transaction_hash);
    if (transactionHash !== expectedHash) throw new ExitExecutorError("exit_uncertain");
    submissionStage = "mark_submitted";
    await budget.markSubmitted(semanticKey, validated.bindingSha256, transactionHash, Date.now());
    submissionStage = "receipt";
    const receipt = await provider.waitForTransaction(transactionHash, { retries: 45, retryInterval: 2_000 });
    if (receipt.isError()) throw new ExitExecutorError("exit_uncertain");
    const raw = receipt.value as unknown as Record<string, unknown>;
    const fee = readFee(raw.actual_fee);
    if (receipt.isReverted()) {
      await budget.finalize(semanticKey, validated.bindingSha256, transactionHash, fee, "reverted", Date.now());
      throw new ExitExecutorError("exit_reverted");
    }
    submissionStage = "finalize";
    await budget.finalize(semanticKey, validated.bindingSha256, transactionHash, fee, "succeeded", Date.now());
    return { status: "accepted", transactionHash, actualFeeFri: fee };
  } catch (error) {
    if (!broadcastStarted) {
      try {
        await budget.release(semanticKey, validated.bindingSha256, Date.now());
      } catch {
        // Preserve the original pre-broadcast failure. Cleanup diagnostics are
        // payload-free and must never turn a safe failed attempt into a generic
        // response that hides whether signing began.
        console.error(JSON.stringify({ event: "exit_reservation_release_failed", stage: submissionStage }));
      }
    }
    if (error instanceof ExitExecutorError) throw error;
    console.error(JSON.stringify({ event: "exit_submission_failed", stage: submissionStage }));
    throw broadcastStarted ? new ExitExecutorError("exit_uncertain") : new ExitExecutorError("exit_unavailable");
  }
}

async function readSnapshot(provider: RpcProvider, validated: ValidatedExit, blockNumber: bigint, timestamp: bigint) {
  const call = (contractAddress: string, entrypoint: string, calldata: string[] = []) => provider.callContract({ contractAddress, entrypoint, calldata }, Number(blockNumber));
  const [neutralClass, afterlightClass, nonce, balanceRaw, allowanceRaw, feeRaw, collectorRaw, validityRaw, vaultRaw] = await Promise.all([
    provider.getClassHashAt(NEUTRAL, Number(blockNumber)),
    provider.getClassHashAt(AFTERLIGHT, Number(blockNumber)),
    provider.getNonceForAddress(NEUTRAL, Number(blockNumber)),
    call(TOKEN, "balance_of", [NEUTRAL]),
    call(TOKEN, "allowance", [NEUTRAL, POOL]),
    call(POOL, "get_fee_amount"),
    call(POOL, "get_fee_collector"),
    call(POOL, "get_proof_validity_blocks"),
    call(AFTERLIGHT, "get_vault", [hex(validated.metadata.vaultId)]),
  ]);
  if (normalizeHex(neutralClass) !== normalizeHex(EXIT_POLICY.neutralClassHash) || normalizeHex(afterlightClass) !== normalizeHex(EXIT_POLICY.afterlightClassHash)) throw new ExitExecutorError("exit_unavailable");
  if (BigInt(feeRaw[0] ?? -1) !== 6n * 10n ** 18n || normalizeHex(collectorRaw[0] ?? "0x0") !== normalizeHex(EXIT_POLICY.poolFeeCollector)) throw new ExitExecutorError("exit_unavailable");
  const allowance = parseU256Result(allowanceRaw, "allowance");
  validateAllowanceForAction(validated.action, allowance);
  validateLiveExitState(validated, parseVaultResult(vaultRaw), timestamp);
  assertProofFreshness(validated.proof.facts.baseBlockNumber, blockNumber, BigInt(validityRaw[0] ?? 0));
  return { nonce: BigInt(nonce), balance: parseU256Result(balanceRaw, "balance") };
}

function hex(value: string | bigint): string { return `0x${BigInt(value).toString(16)}`; }

function readFee(value: unknown): string {
  if (typeof value === "string") return BigInt(value).toString();
  if (typeof value !== "object" || value === null) return "0";
  const amount = (value as Record<string, unknown>).amount;
  return typeof amount === "string" ? BigInt(amount).toString() : "0";
}

function exitStage(stage: string): ExitExecutorError {
  // Never include request material, proof fields, note IDs, signatures, vaults,
  // wallet addresses, IPs, RPC payloads, or raw exception messages.
  console.error(JSON.stringify({ event: "exit_preflight_rejected", stage }));
  return new ExitExecutorError("exit_unavailable");
}

function classifyEstimateFailure(error: unknown): string {
  // Emit only a fixed category. Never log the upstream message because RPC
  // execution errors can echo calldata, proof material, note IDs or signatures.
  const code = rpcErrorCode(error);
  if (code === 41) return "rpc_execution";
  if (code === 52) return "rpc_transaction_nonce";
  if (code === 53) return "rpc_validate_resources";
  if (code === 54) return "rpc_account_balance";
  if (code === 55) return "rpc_validation";
  if (code !== undefined) return "rpc_other";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("insufficient") && (message.includes("balance") || message.includes("fee"))) return "insufficient_balance";
  if (message.includes("nonce")) return "nonce";
  if (message.includes("proof") || message.includes("validate")) return "proof_or_validation";
  if (message.includes("revert") || message.includes("execution")) return "execution";
  if (message.includes("timeout") || message.includes("network") || message.includes("fetch")) return "transport";
  return "unknown";
}

function rpcErrorCode(error: unknown): number | undefined {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  const base = typeof record?.baseError === "object" && record.baseError !== null
    ? record.baseError as Record<string, unknown>
    : undefined;
  return typeof record?.code === "number" ? record.code : typeof base?.code === "number" ? base.code : undefined;
}
