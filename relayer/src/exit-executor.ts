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
  // The proven E2 CLAIM used 2.832236 STRK of network fee. A 4 STRK hard cap
  // leaves 41% headroom while keeping the public E3 sponsor budget bounded.
  maxNetworkFeePerExitFri: "4000000000000000000",
  amountMarginBps: "10300",
  priceMarginBps: "10300",
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
  let estimate;
  try {
    estimate = await account.estimateInvokeFee(call, {
      nonce: snapshot.nonce,
      blockIdentifier: Number(blockNumber),
      skipValidate: false,
      proof: validated.proof.data,
      proofFacts,
      tip: 0,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
    });
  } catch { throw exitStage("estimate"); }
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
  try {
    const freshNonce = BigInt(await account.getNonce("pre_confirmed"));
    const freshBlock = await provider.getBlockWithTxHashes("latest");
    if (!("block_number" in freshBlock) || freshNonce !== snapshot.nonce || BigInt(freshBlock.block_number) - blockNumber > 300n) throw new Error("snapshot_changed");
    await readSnapshot(provider, validated, BigInt(freshBlock.block_number), BigInt(freshBlock.timestamp));
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
    assertSignedExitTransaction(signed, {
      nonce: snapshot.nonce,
      executeCalldata: transaction.getExecuteCalldata([call], "1"),
      proof: validated.proof.data,
      proofFacts,
      resourceBounds: bounds,
      networkCapFri: policy.networkCapFri,
    });
    const expectedHash = assertOuterSignatureMatchesHash(signed);
    const response = await provider.invokeSignedTx(signed);
    const transactionHash = normalizeHex(response.transaction_hash);
    if (transactionHash !== expectedHash) throw new ExitExecutorError("exit_uncertain");
    await budget.markSubmitted(semanticKey, validated.bindingSha256, transactionHash, Date.now());
    const receipt = await provider.waitForTransaction(transactionHash, { retries: 45, retryInterval: 2_000 });
    if (receipt.isError()) throw new ExitExecutorError("exit_uncertain");
    const raw = receipt.value as unknown as Record<string, unknown>;
    const fee = readFee(raw.actual_fee);
    if (receipt.isReverted()) {
      await budget.finalize(semanticKey, validated.bindingSha256, transactionHash, fee, "reverted", Date.now());
      throw new ExitExecutorError("exit_reverted");
    }
    await budget.finalize(semanticKey, validated.bindingSha256, transactionHash, fee, "succeeded", Date.now());
    return { status: "accepted", transactionHash, actualFeeFri: fee };
  } catch (error) {
    if (signed === undefined) await budget.release(semanticKey, validated.bindingSha256, Date.now());
    if (error instanceof ExitExecutorError) throw error;
    throw signed === undefined ? new ExitExecutorError("exit_unavailable") : new ExitExecutorError("exit_uncertain");
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
