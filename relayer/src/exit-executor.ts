import { Account, RpcProvider, transaction, type Call } from "starknet";
import type { BudgetCoordinator } from "./executor.js";
import {
  LOCKED_POOL_CLASS_HASH,
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

export const EXIT_POLICY = Object.freeze({
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
const FUNDING_CHECKPOINT_MAX_AGE_SECONDS = 300n;

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

export type ClaimCapacity = Readonly<{
  status: "ready" | "exhausted" | "unknown";
  reason: "ready" | "allowance" | "balance" | "ledger" | "configuration";
  fundingStatus: "ready" | "exhausted" | "unknown";
  fundingReason: "ready" | "outstanding_liability" | "exit_capacity" | "configuration";
}>;

export async function readClaimCapacity(env: Env, budget?: Pick<BudgetCoordinator, "snapshot" | "activeSnapshot" | "fundingAdmissionSnapshot" | "consumeFundingAdmission">): Promise<ClaimCapacity> {
  try {
    const provider = new RpcProvider({
      nodeUrl: env.EXIT_RPC_URL,
      headers: { authorization: `Bearer ${env.STARKNET_RPC_AUTH_TOKEN}` },
      plugins: false,
    });
    const latest = await provider.getBlockWithTxHashes("latest");
    if (!("block_number" in latest)) return unknownCapacity();
    const block = latest.block_number;
    const call = (contractAddress: string, entrypoint: string, calldata: string[] = []) =>
      provider.callContract({ contractAddress, entrypoint, calldata }, block);
    const [poolClass, neutralClass, afterlightClass, balanceRaw, allowanceRaw, liabilityRaw, feeRaw, collectorRaw, configRaw] = await Promise.all([
      provider.getClassHashAt(POOL, block),
      provider.getClassHashAt(NEUTRAL, block),
      provider.getClassHashAt(AFTERLIGHT, block),
      call(TOKEN, "balance_of", [NEUTRAL]),
      call(TOKEN, "allowance", [NEUTRAL, POOL]),
      call(AFTERLIGHT, "get_locked_by_token", [TOKEN]),
      call(POOL, "get_fee_amount"),
      call(POOL, "get_fee_collector"),
      call(AFTERLIGHT, "get_config"),
    ]);
    if (
      normalizeHex(poolClass) !== normalizeHex(LOCKED_POOL_CLASS_HASH) ||
      normalizeHex(neutralClass) !== normalizeHex(EXIT_POLICY.neutralClassHash) ||
      normalizeHex(afterlightClass) !== normalizeHex(EXIT_POLICY.afterlightClassHash) ||
      normalizeHex(collectorRaw[0] ?? "0x0") !== normalizeHex(EXIT_POLICY.poolFeeCollector) ||
      configRaw.length !== 10 ||
      BigInt(configRaw[9] ?? -1) !== FUNDING_CHECKPOINT_MAX_AGE_SECONDS
    ) return unknownCapacity();
    const fee = BigInt(feeRaw[0] ?? -1);
    if (fee !== BigInt(EXIT_POLICY.poolFeeEachFri)) return unknownCapacity();
    const allowance = parseU256Result(allowanceRaw, "allowance");
    if (allowance !== BigInt(EXIT_POLICY.initialPoolAllowanceFri)) return exhaustedCapacity("allowance");
    const balance = parseU256Result(balanceRaw, "balance");
    const required = fee + BigInt(EXIT_POLICY.maxNetworkFeePerExitFri) + BigInt(EXIT_POLICY.postSpendHealthFloorFri);
    if (balance < required) return exhaustedCapacity("balance");
    const liability = parseU256Result(liabilityRaw, "liability");
    if (liability !== 0n && budget !== undefined) {
      // A nonzero exact contract liability is authoritative evidence that the
      // admitted FUND consumed the one-shot checkpoint. Clear the operational
      // lease; funding remains exhausted by the liability itself.
      await budget.consumeFundingAdmission(Date.now());
    }
    const chainCapacity: ClaimCapacity = liability === 0n
      ? { status: "ready", reason: "ready", fundingStatus: "ready", fundingReason: "ready" }
      : { status: "ready", reason: "ready", fundingStatus: "exhausted", fundingReason: "outstanding_liability" };
    if (budget === undefined) return chainCapacity;
    const dayKey = new Date().toISOString().slice(0, 10);
    const [exitLedger, activeLedger, fundingAdmission] = await Promise.all([
      budget.snapshot(dayKey, "exit"),
      budget.activeSnapshot(),
      budget.fundingAdmissionSnapshot(Date.now()),
    ]);
    return applyLedgerCapacity(chainCapacity, {
      ...exitLedger,
      reservedCount: activeLedger.reservedCount,
      submittedCount: activeLedger.submittedCount,
      sponsorshipFrozen: activeLedger.sponsorshipFrozen,
      fundingAdmissionActive: fundingAdmission.active,
    });
  } catch {
    return unknownCapacity();
  }
}

export function applyLedgerCapacity(
  chainCapacity: ClaimCapacity,
  snapshot: Readonly<{
    reservedTodayFri: string;
    spentTodayFri: string;
    reservedCount: number;
    submittedCount: number;
    sponsorshipFrozen: boolean;
    fundingAdmissionActive?: boolean;
  }>,
): ClaimCapacity {
  if (chainCapacity.status !== "ready") return chainCapacity;
  const active = snapshot.reservedCount + snapshot.submittedCount > 0;
  const projected = BigInt(snapshot.reservedTodayFri) + BigInt(snapshot.spentTodayFri) + BigInt(EXIT_POLICY.maxNetworkFeePerExitFri);
  if (snapshot.sponsorshipFrozen || active || projected > BigInt(EXIT_POLICY.maxNetworkFeePerExitFri)) {
    return { status: "exhausted", reason: "ledger", fundingStatus: "exhausted", fundingReason: "exit_capacity" };
  }
  if (snapshot.fundingAdmissionActive) {
    return { ...chainCapacity, fundingStatus: "exhausted", fundingReason: "exit_capacity" };
  }
  return chainCapacity;
}

function unknownCapacity(): ClaimCapacity {
  return { status: "unknown", reason: "configuration", fundingStatus: "unknown", fundingReason: "configuration" };
}

function exhaustedCapacity(reason: "allowance" | "balance"): ClaimCapacity {
  return { status: "exhausted", reason, fundingStatus: "exhausted", fundingReason: "exit_capacity" };
}

export function validatePreparedExitPayload(payload: string): ValidatedExit {
  let decoded: unknown;
  try { decoded = JSON.parse(payload); } catch { throw new ExitExecutorError("invalid_exit"); }
  try {
    const validated = validatePreparedExitPackage(decoded, EXIT_POLICY);
    if (validated.action !== "CLAIM" && validated.action !== "CANCEL_REFUND") throw new Error("unsupported_exit");
    return validated;
  } catch { throw new ExitExecutorError("invalid_exit"); }
}

export async function executePreparedExit(
  payload: string,
  env: Env,
  budget: BudgetCoordinator,
  prevalidated?: ValidatedExit,
  afterAuthenticated?: () => Promise<void>,
): Promise<ExitResult> {
  const validated = prevalidated ?? validatePreparedExitPayload(payload);

  // The binding is already a domain-separated SHA-256 over the complete exit
  // package. Budget keys deliberately accept only canonical 64-hex digests.
  const semanticKey = validated.bindingSha256;
  const provider = new RpcProvider({
    // Real Ready PROOF1 exit envelopes require the audited RPC 0.10.3 path.
    // Keep its credential-bearing URL in a Worker secret rather than the
    // public Wrangler configuration used by ordinary relay controls.
    nodeUrl: env.EXIT_RPC_URL,
    headers: { authorization: `Bearer ${env.STARKNET_RPC_AUTH_TOKEN}` },
    plugins: false,
  });
  const prior = await budget.lookup(semanticKey);
  if (prior.outcome === "found" && prior.state !== "released") {
    if (
      prior.state === "submitted" &&
      prior.transactionHash !== null &&
      prior.exactFingerprint === validated.bindingSha256
    ) {
      return reconcileSubmittedExit(provider, budget, validated, prior.transactionHash);
    }
    if (
      prior.state === "reserved" &&
      prior.transactionHash !== null &&
      prior.preparedPayload !== null &&
      prior.exactFingerprint === validated.bindingSha256
    ) {
      if (env.SUBMIT_ENABLED !== "true") throw new ExitExecutorError("exit_unavailable");
      return rebroadcastPreparedExit(
        provider,
        budget,
        validated,
        prior.transactionHash,
        prior.preparedPayload,
      );
    }
    return { status: "duplicate", transactionHash: prior.transactionHash };
  }
  // The kill switch blocks every fresh signature and broadcast, but cannot
  // strand a transaction already recorded as SUBMITTED. Receipt-only
  // reconciliation above is safe while submission is disabled.
  if (env.SUBMIT_ENABLED !== "true") throw new ExitExecutorError("exit_unavailable");
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

  // A successful authenticated simulation proves the application signature,
  // proof, exact note and live state before consuming the victim-specific
  // vault/action quota. Invalid callers remain bounded only by global ingress.
  await afterAuthenticated?.();

  const reservation = await budget.reserve({
    budgetClass: "exit",
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
    const preparedPayload = serializeSignedExitForStorage(signed);
    submissionStage = "persist_expected_hash";
    await budget.markPrepared(
      semanticKey,
      validated.bindingSha256,
      expectedHash,
      preparedPayload,
      Date.now(),
    );
    submissionStage = "broadcast";
    broadcastStarted = true;
    let response;
    try {
      response = await provider.invokeSignedTx(signed);
    } catch (error) {
      const failure = classifyBroadcastFailure(error);
      console.error(JSON.stringify({ event: "exit_broadcast_failed", category: failure.category }));
      if (failure.definitiveReject) {
        // A JSON-RPC error response proves that this node rejected the
        // transaction before acceptance. It is safe to release the RESERVED
        // slot; transport failures remain ambiguous and serialized.
        broadcastStarted = false;
        throw new ExitExecutorError("exit_unavailable");
      }
      throw new ExitExecutorError("exit_uncertain");
    }
    const transactionHash = normalizeHex(response.transaction_hash);
    if (transactionHash !== expectedHash) {
      throw new ExitExecutorError("exit_uncertain");
    }
    submissionStage = "mark_submitted";
    await budget.markSubmitted(semanticKey, validated.bindingSha256, transactionHash, Date.now());
    submissionStage = "receipt";
    return await reconcileSubmittedExit(provider, budget, validated, transactionHash);
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

async function rebroadcastPreparedExit(
  provider: RpcProvider,
  budget: BudgetCoordinator,
  validated: ValidatedExit,
  expectedHash: string,
  preparedPayload: string,
): Promise<ExitResult> {
  const signed = parseStoredSignedExit(preparedPayload);
  try {
    validateStoredSignedExit(signed, validated, expectedHash);
  } catch {
    throw new ExitExecutorError("exit_uncertain");
  }
  try {
    const response = await provider.invokeSignedTx(signed as Parameters<RpcProvider["invokeSignedTx"]>[0]);
    if (normalizeHex(response.transaction_hash) !== normalizeHex(expectedHash)) {
      throw new ExitExecutorError("exit_uncertain");
    }
    await budget.markSubmitted(
      validated.bindingSha256,
      validated.bindingSha256,
      expectedHash,
      Date.now(),
    );
  } catch (error) {
    // Replaying the exact persisted transaction is idempotent. A duplicate,
    // validation response, or transport loss may all mean the first broadcast
    // landed, so receipt reconciliation remains authoritative and the durable
    // reservation is never released here.
    console.error(JSON.stringify({
      event: "exit_prepared_rebroadcast_not_acknowledged",
      category: classifyBroadcastFailure(error).category,
    }));
  }
  return reconcileSubmittedExit(provider, budget, validated, expectedHash);
}

type StoredSignedExit = Record<string, unknown>;

export function serializeSignedExitForStorage(signed: unknown): string {
  const serialized = JSON.stringify(signed, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (serialized.length < 2 || serialized.length > 3_000_000) {
    throw new ExitExecutorError("exit_unavailable");
  }
  return serialized;
}

function parseStoredSignedExit(serialized: string): StoredSignedExit {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
    return parsed as StoredSignedExit;
  } catch {
    throw new ExitExecutorError("exit_uncertain");
  }
}

export function validateStoredSignedExit(
  signed: StoredSignedExit,
  validated: ValidatedExit,
  expectedHash: string,
  publicKey: string = EXIT_POLICY.neutralPublicKey,
): true {
  const bounds = parseResourceBounds(signed.resource_bounds);
  assertSignedExitTransaction(signed, {
    nonce: BigInt(String(signed.nonce)),
    executeCalldata: transaction.getExecuteCalldata([{
      contractAddress: validated.call.contractAddress,
      entrypoint: validated.call.entrypoint,
      calldata: validated.call.calldata.map(hex),
    }], "1"),
    proof: validated.proof.data,
    proofFacts: validated.proof.facts.facts.map(hex),
    resourceBounds: bounds,
    networkCapFri: BigInt(EXIT_POLICY.maxNetworkFeePerExitFri),
  });
  if (normalizeHex(assertOuterSignatureMatchesHash(signed, publicKey)) !== normalizeHex(expectedHash)) {
    throw new Error("stored_hash_mismatch");
  }
  return true;
}

export async function reconcileSubmittedExit(
  provider: RpcProvider,
  budget: BudgetCoordinator,
  validated: ValidatedExit,
  transactionHash: string,
): Promise<ExitResult> {
  let receipt;
  try {
    receipt = await provider.waitForTransaction(transactionHash, { retries: 45, retryInterval: 2_000 });
  } catch {
    throw new ExitExecutorError("exit_uncertain");
  }
  if (receipt.isError()) throw new ExitExecutorError("exit_uncertain");
  const raw = receipt.value as unknown as Record<string, unknown>;
  const observedHash = typeof raw.transaction_hash === "string" ? normalizeHex(raw.transaction_hash) : transactionHash;
  if (observedHash !== normalizeHex(transactionHash)) throw new ExitExecutorError("exit_uncertain");
  const fee = readFee(raw.actual_fee);
  await budget.markSubmitted(
    validated.bindingSha256,
    validated.bindingSha256,
    transactionHash,
    Date.now(),
  );
  if (receipt.isReverted()) {
    await budget.finalize(validated.bindingSha256, validated.bindingSha256, transactionHash, fee, "reverted", Date.now());
    throw new ExitExecutorError("exit_reverted");
  }
  await budget.finalize(validated.bindingSha256, validated.bindingSha256, transactionHash, fee, "succeeded", Date.now());
  return { status: "accepted", transactionHash, actualFeeFri: fee };
}

async function readSnapshot(provider: RpcProvider, validated: ValidatedExit, blockNumber: bigint, timestamp: bigint) {
  const call = (contractAddress: string, entrypoint: string, calldata: string[] = []) => provider.callContract({ contractAddress, entrypoint, calldata }, Number(blockNumber));
  const [neutralClass, afterlightClass, poolClass, nonce, balanceRaw, allowanceRaw, feeRaw, collectorRaw, validityRaw, vaultRaw] = await Promise.all([
    provider.getClassHashAt(NEUTRAL, Number(blockNumber)),
    provider.getClassHashAt(AFTERLIGHT, Number(blockNumber)),
    provider.getClassHashAt(POOL, Number(blockNumber)),
    provider.getNonceForAddress(NEUTRAL, Number(blockNumber)),
    call(TOKEN, "balance_of", [NEUTRAL]),
    call(TOKEN, "allowance", [NEUTRAL, POOL]),
    call(POOL, "get_fee_amount"),
    call(POOL, "get_fee_collector"),
    call(POOL, "get_proof_validity_blocks"),
    call(AFTERLIGHT, "get_vault", [hex(validated.metadata.vaultId)]),
  ]);
  if (
    normalizeHex(neutralClass) !== normalizeHex(EXIT_POLICY.neutralClassHash) ||
    normalizeHex(afterlightClass) !== normalizeHex(EXIT_POLICY.afterlightClassHash) ||
    normalizeHex(poolClass) !== normalizeHex(LOCKED_POOL_CLASS_HASH)
  ) throw new ExitExecutorError("exit_unavailable");
  if (BigInt(feeRaw[0] ?? -1) !== 6n * 10n ** 18n || normalizeHex(collectorRaw[0] ?? "0x0") !== normalizeHex(EXIT_POLICY.poolFeeCollector)) throw new ExitExecutorError("exit_unavailable");
  const allowance = parseU256Result(allowanceRaw, "allowance");
  validateAllowanceForAction(validated.action, allowance);
  validateLiveExitState(validated, parseVaultResult(vaultRaw), timestamp);
  assertProofFreshness(validated.proof.facts.baseBlockNumber, blockNumber, BigInt(validityRaw[0] ?? 0));
  return { nonce: BigInt(nonce), balance: parseU256Result(balanceRaw, "balance") };
}

function hex(value: string | bigint): string { return `0x${BigInt(value).toString(16)}`; }

function readFee(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const unit = (value as Record<string, unknown>).unit;
    if (unit !== "FRI") throw new ExitExecutorError("exit_uncertain");
  }
  const amount = typeof value === "string"
    ? value
    : typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).amount
      : undefined;
  if (typeof amount !== "string") throw new ExitExecutorError("exit_uncertain");
  try {
    const fee = BigInt(amount);
    if (fee <= 0n) throw new Error("non_positive_fee");
    return fee.toString();
  } catch {
    throw new ExitExecutorError("exit_uncertain");
  }
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

export function classifyBroadcastFailure(error: unknown): Readonly<{
  category: "rpc_execution" | "rpc_transaction_nonce" | "rpc_validate_resources" | "rpc_account_balance" | "rpc_validation" | "rpc_duplicate" | "rpc_other" | "transport_or_unknown";
  definitiveReject: boolean;
}> {
  const code = rpcErrorCode(error);
  if (code === 41) return { category: "rpc_execution", definitiveReject: true };
  if (code === 52) return { category: "rpc_transaction_nonce", definitiveReject: true };
  if (code === 53) return { category: "rpc_validate_resources", definitiveReject: true };
  if (code === 54) return { category: "rpc_account_balance", definitiveReject: true };
  if (code === 55) return { category: "rpc_validation", definitiveReject: true };
  if (code === 59) return { category: "rpc_duplicate", definitiveReject: false };
  if (code !== undefined) return { category: "rpc_other", definitiveReject: false };
  return { category: "transport_or_unknown", definitiveReject: false };
}
