import type { STRK20_ACTION } from "@starknet-io/types-js";

import {
  CANONICAL_STRK20_POOL,
  MAX_EXIT_AUTH_WINDOW_SECONDS,
  PrivateAction,
  PrivateExitPreflight,
  STARKNET_MAINNET_CHAIN_ID,
  type ExitPreflightInput,
  type PreparedCallAndProof,
  type ReadMainnetBlockPort,
  type WalletBoundary,
} from "../src/index.js";
import { readJsonRpc } from "./read-only-json-rpc.js";
import { createReadyOnlyStore, type ReadyWallet } from "./ready-only-store.js";

const CONNECT = "standard:connect";
const EVENTS = "standard:events";
const WALLET_API = "starknet:walletApi";

type RpcConfig = Readonly<{ id: string; operator: string; url: string }>;

type ToolConfigBase = Readonly<{
  evidence: "AFTERLIGHT_PRIVATE_EXIT_PREFLIGHT_E1";
  mode: "e1-unfunded" | "live-funded";
  expectedReadyAccount: string;
  openNoteRecipient: string;
  chainId: string;
  pool: string;
  contract: string;
  vaultId: string;
  token: string;
  amount: string;
  expectedState: string;
  expectedEpoch: string;
  expectedNonce: string;
  rolePublicKey: string;
  authorizationTtlSeconds: string;
  rpcProviders: readonly RpcConfig[];
}>;

type ToolConfig =
  | (ToolConfigBase & Readonly<{ operation: "CANCEL_REFUND" }>)
  | (ToolConfigBase &
      Readonly<{ operation: "CLAIM"; requestedAt: string; claimAfter: string }>);

const status = required("status");
const output = required("output");
const configFile = requiredInput("config-file");
const configButton = requiredButton("load-config");
const retryButton = requiredButton("retry");
const silentButton = requiredButton("silent");
const connectButton = requiredButton("connect");
const sentinelButton = requiredButton("sentinel");
const completeButton = requiredButton("complete");
const signatureR = requiredInput("signature-r");
const signatureS = requiredInput("signature-s");
const signatureError = required("signature-error");

const store = createReadyOnlyStore();
let ready: ReadyWallet | undefined;
let config: ToolConfig | undefined;
let preflight: PrivateExitPreflight | undefined;
let connectedBoundary: WalletBoundary | undefined;
let removeWalletListener: (() => void) | undefined;
let busy = false;

function findReady(): ReadyWallet | undefined {
  return store.getWallets()[0];
}

function refresh(): void {
  const discovered = findReady();
  if (discovered !== ready) {
    removeWalletListener?.();
    removeWalletListener = undefined;
    preflight?.invalidateWalletBoundary();
    connectedBoundary = undefined;
    ready = discovered;
    if (ready) {
      removeWalletListener = ready.features[EVENTS].on("change", () => {
        preflight?.invalidateWalletBoundary();
        connectedBoundary = undefined;
        signatureR.value = "";
        signatureS.value = "";
        clearSignatureError();
        output.textContent = JSON.stringify(
          {
            evidenceLevel: "E1",
            event: "READY_BOUNDARY_CHANGED",
            sentinelInvalidated: true,
            submitted: false,
          },
          null,
          2,
        );
        refresh();
      });
    }
  }

  status.textContent = !ready
    ? "Ready X is not detected in this browser profile."
    : connectedBoundary
      ? `Ready X ${ready.features[WALLET_API].walletVersion} connected to the locked Mainnet recipient.`
      : `Ready X ${ready.features[WALLET_API].walletVersion} detected. Connect the exact open-note recipient.`;
  configButton.disabled = busy;
  retryButton.disabled = busy;
  silentButton.disabled = busy || !ready;
  connectButton.disabled = busy || !ready;
  sentinelButton.disabled = busy || !ready || !config || !connectedBoundary;
  const sentinelActive = preflight?.hasActiveSentinel === true;
  signatureR.disabled = busy || !sentinelActive;
  signatureS.disabled = busy || !sentinelActive;
  completeButton.disabled =
    busy || !ready || !config || !connectedBoundary || !sentinelActive;
}

async function loadConfiguration(): Promise<void> {
  resetConfigurationState();
  const file = configFile.files?.[0];
  if (!file) throw new Error("Choose a local private-exit JSON file first.");
  if (file.size > 65_536) throw new Error("Local private-exit configuration exceeds 64 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error("Local private-exit configuration is not valid JSON.");
  }
  const loaded = parseConfig(parsed);
  const readers = loaded.rpcProviders.map(createRpcReader);
  config = loaded;
  preflight = new PrivateExitPreflight(
    {
      readBoundary: readDirectWalletBoundary,
      prepare: async (actions, simulate) => prepareWithReady(actions, simulate),
    },
    readers,
  );
  connectedBoundary = undefined;
  signatureR.value = "";
  signatureS.value = "";
  output.textContent = JSON.stringify(
    {
      evidence: loaded.evidence,
      evidenceLevel: "E1",
      operation: loaded.operation,
      mode: loaded.mode,
      readyAccount: redactAddress(loaded.expectedReadyAccount),
      rpcProviderCount: readers.length,
      applicationSignatureVerified: false,
      walletTransactionSigned: false,
      submitted: false,
    },
    null,
    2,
  );
}

async function connect(silent: boolean): Promise<void> {
  if (!ready || !config || !preflight) {
    throw new Error("Detect Ready X and load the local E1 configuration first.");
  }
  resetConnectionState();
  const result = await ready.features[CONNECT].connect({ silent });
  const account = result.accounts[0]?.address;
  if (!account) throw new Error("Ready X did not return an authorized account.");
  const boundary = await readDirectWalletBoundary();
  if (normalizeFelt(account) !== normalizeFelt(boundary.account)) {
    throw new Error("Wallet Standard and direct Ready account reads disagree.");
  }
  if (!preflight.observeWalletBoundary(boundary)) {
    throw new Error("Ready account or network changed; prepare a new sentinel.");
  }
  assertConfiguredBoundary(config, boundary);
  connectedBoundary = boundary;
  output.textContent = JSON.stringify(
    {
      evidenceLevel: "E1",
      operation: silent ? "silent_connect" : "connect",
      readyAccount: redactAddress(account),
      mainnet: normalizeFelt(boundary.chainId) === normalizeFelt(STARKNET_MAINNET_CHAIN_ID),
      walletTransactionSigned: false,
      submitted: false,
    },
    null,
    2,
  );
}

async function prepareSentinel(): Promise<void> {
  const active = requiredActiveContext();
  clearSignatureError();
  const metadata = await active.preflight.prepareSentinel(toCoreInput(active.config));
  output.textContent = JSON.stringify(metadata, null, 2);
}

async function completePreflight(): Promise<void> {
  const active = requiredActiveContext();
  clearSignatureError();
  try {
    const metadata = await active.preflight.complete({
      sig_r: signatureR.value.trim(),
      sig_s: signatureS.value.trim(),
    });
    signatureR.value = "";
    signatureS.value = "";
    output.textContent = JSON.stringify(metadata, null, 2);
  } catch (error) {
    active.preflight.invalidateWalletBoundary();
    if (error instanceof Error && /signature/i.test(error.message)) {
      signatureR.setAttribute("aria-invalid", "true");
      signatureS.setAttribute("aria-invalid", "true");
      signatureError.textContent =
        "The application signature does not match the required role key and exact authorization. Prepare a new sentinel before retrying.";
    }
    signatureR.value = "";
    signatureS.value = "";
    throw error;
  }
}

async function readDirectWalletBoundary(): Promise<WalletBoundary> {
  if (!ready) throw new Error("Ready X is unavailable.");
  const accounts = await ready.features[WALLET_API].request({
    type: "wallet_requestAccounts",
    params: { silent_mode: true },
  });
  if (accounts.length !== 1 || !accounts[0]) {
    throw new Error("Ready X must expose exactly one silently authorized account.");
  }
  const chainId = await ready.features[WALLET_API].request({ type: "wallet_requestChainId" });
  return Object.freeze({ account: accounts[0], chainId });
}

async function prepareWithReady(
  actions: readonly STRK20_ACTION[],
  simulate: boolean,
): Promise<PreparedCallAndProof> {
  if (!ready) throw new Error("Ready X is unavailable.");
  const result = await ready.features[WALLET_API].request({
    type: "wallet_strk20PrepareInvoke",
    params: { actions: [...actions], simulate },
  });
  const call =
    result.call.calldata === undefined
      ? {
          contractAddress: result.call.contract_address,
          entrypoint: result.call.entry_point,
        }
      : {
          contractAddress: result.call.contract_address,
          entrypoint: result.call.entry_point,
          calldata: result.call.calldata,
        };
  return {
    call,
    proof: {
      data: result.proof.data,
      output: [...result.proof.output],
      proof_facts: [...result.proof.proof_facts],
    },
  };
}

function createRpcReader(provider: RpcConfig): ReadMainnetBlockPort {
  const endpoint = new URL(provider.url);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
    throw new Error(`RPC provider ${provider.id} must use HTTPS.`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`RPC provider ${provider.id} must not place credentials in URL userinfo.`);
  }
  return Object.freeze({
    providerId: provider.id,
    endpointId: normalizeHostname(endpoint.hostname),
    operatorId: provider.operator.trim().toLowerCase(),
    async readAcceptedBlock(number: string) {
      const parsedNumber = BigInt(number);
      if (parsedNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("proof base block number exceeds the safe JSON-RPC range");
      }
      const [chainId, block] = await Promise.all([
        readJsonRpc<string>(provider.url, "starknet_chainId", []),
        readJsonRpc<Record<string, unknown>>(provider.url, "starknet_getBlockWithTxHashes", [
          { block_number: Number(parsedNumber) },
        ]),
      ]);
      const status = requiredString(block, "status");
      if (status !== "ACCEPTED_ON_L1" && status !== "ACCEPTED_ON_L2") {
        throw new Error(`RPC provider ${provider.id} returned a non-accepted block.`);
      }
      return {
        chainId,
        number: requiredScalar(block, "block_number"),
        hash: requiredScalar(block, "block_hash"),
        status,
      };
    },
  });
}

function toCoreInput(loaded: ToolConfig): ExitPreflightInput {
  const base = {
    mode: loaded.mode,
    expectedReadyAccount: loaded.expectedReadyAccount,
    openNoteRecipient: loaded.openNoteRecipient,
    chainId: loaded.chainId,
    pool: loaded.pool,
    contract: loaded.contract,
    vaultId: loaded.vaultId,
    token: loaded.token,
    amount: loaded.amount,
    expectedState: loaded.expectedState,
    expectedEpoch: loaded.expectedEpoch,
    expectedNonce: loaded.expectedNonce,
    rolePublicKey: loaded.rolePublicKey,
    validUntil: (
      BigInt(Math.floor(Date.now() / 1_000)) + BigInt(loaded.authorizationTtlSeconds)
    ).toString(),
  } as const;
  return loaded.operation === "CANCEL_REFUND"
    ? { ...base, kind: PrivateAction.CancelRefund }
    : {
        ...base,
        kind: PrivateAction.Claim,
        requestedAt: loaded.requestedAt,
        claimAfter: loaded.claimAfter,
      };
}

function parseConfig(value: unknown): ToolConfig {
  if (!isRecord(value)) throw new Error("Local private-exit configuration must be an object.");
  if (value.evidence !== "AFTERLIGHT_PRIVATE_EXIT_PREFLIGHT_E1") {
    throw new Error("Local configuration is not an E1 private-exit preflight package.");
  }
  const operation = requiredString(value, "operation");
  if (operation !== "CANCEL_REFUND" && operation !== "CLAIM") {
    throw new Error("Local configuration operation must be CANCEL_REFUND or CLAIM.");
  }
  const mode = requiredString(value, "mode");
  if (mode !== "e1-unfunded" && mode !== "live-funded") {
    throw new Error("Local configuration mode must be e1-unfunded or live-funded.");
  }
  if (!Array.isArray(value.rpcProviders)) {
    throw new Error("Local configuration requires an RPC provider array.");
  }
  const rpcProviders = value.rpcProviders.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`RPC provider ${index} must be an object.`);
    return Object.freeze({
      id: requiredString(entry, "id"),
      operator: requiredString(entry, "operator"),
      url: requiredString(entry, "url"),
    });
  });
  const base: ToolConfigBase = Object.freeze({
    evidence: value.evidence,
    mode,
    expectedReadyAccount: requiredString(value, "expectedReadyAccount"),
    openNoteRecipient: requiredString(value, "openNoteRecipient"),
    chainId: requiredString(value, "chainId"),
    pool: requiredString(value, "pool"),
    contract: requiredString(value, "contract"),
    vaultId: requiredString(value, "vaultId"),
    token: requiredString(value, "token"),
    amount: requiredString(value, "amount"),
    expectedState: requiredString(value, "expectedState"),
    expectedEpoch: requiredString(value, "expectedEpoch"),
    expectedNonce: requiredString(value, "expectedNonce"),
    rolePublicKey: requiredString(value, "rolePublicKey"),
    authorizationTtlSeconds: requiredString(value, "authorizationTtlSeconds"),
    rpcProviders: Object.freeze(rpcProviders),
  });
  let ttl: bigint;
  try {
    ttl = BigInt(base.authorizationTtlSeconds);
  } catch {
    throw new Error("authorizationTtlSeconds must be a decimal integer.");
  }
  if (ttl <= 0n || ttl > MAX_EXIT_AUTH_WINDOW_SECONDS) {
    throw new Error("authorizationTtlSeconds must be between 1 and 900 seconds.");
  }
  return operation === "CANCEL_REFUND"
    ? Object.freeze({ ...base, operation })
    : Object.freeze({
        ...base,
        operation,
        requestedAt: requiredString(value, "requestedAt"),
        claimAfter: requiredString(value, "claimAfter"),
      });
}

function assertConfiguredBoundary(loaded: ToolConfig, boundary: WalletBoundary): void {
  if (normalizeFelt(boundary.account) !== normalizeFelt(loaded.expectedReadyAccount)) {
    throw new Error("Connected Ready account is not the configured open-note recipient.");
  }
  if (normalizeFelt(boundary.chainId) !== normalizeFelt(STARKNET_MAINNET_CHAIN_ID)) {
    throw new Error("Ready X is not on Starknet Mainnet.");
  }
  if (normalizeFelt(loaded.chainId) !== normalizeFelt(STARKNET_MAINNET_CHAIN_ID)) {
    throw new Error("Local configuration is not locked to Starknet Mainnet.");
  }
  if (normalizeFelt(loaded.pool) !== normalizeFelt(CANONICAL_STRK20_POOL)) {
    throw new Error("Local configuration is not locked to the canonical STRK20 pool.");
  }
  if (normalizeFelt(loaded.openNoteRecipient) !== normalizeFelt(loaded.expectedReadyAccount)) {
    throw new Error("Configured open-note recipient differs from the expected Ready account.");
  }
}

function requiredActiveContext(): Readonly<{
  config: ToolConfig;
  preflight: PrivateExitPreflight;
}> {
  if (!config || !preflight || !connectedBoundary) {
    throw new Error("Load the E1 configuration and connect the exact Ready account first.");
  }
  return { config, preflight };
}

async function guarded(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  refresh();
  status.setAttribute("aria-busy", "true");
  try {
    await action();
  } catch (error) {
    output.textContent = JSON.stringify(
      {
        evidenceLevel: "E1",
        error: safeErrorMessage(error),
        walletTransactionSigned: false,
        submitted: false,
      },
      null,
      2,
    );
  } finally {
    busy = false;
    status.removeAttribute("aria-busy");
    refresh();
  }
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Private exit preflight failed.";
  const redacted = raw
    .replace(/0x[0-9a-fA-F]{16,}/g, "<redacted-hex>")
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, "<redacted-data>")
    .replace(/https?:\/\/[^\s]+/g, "<redacted-url>");
  return redacted.length <= 240 ? redacted : `${redacted.slice(0, 237)}…`;
}

configButton.addEventListener("click", () => void guarded(loadConfiguration));
silentButton.addEventListener("click", () => void guarded(() => connect(true)));
connectButton.addEventListener("click", () => void guarded(() => connect(false)));
sentinelButton.addEventListener("click", () => void guarded(prepareSentinel));
completeButton.addEventListener("click", () => void guarded(completePreflight));
retryButton.addEventListener("click", () => {
  store.refreshInjectedWallets();
  refresh();
});
for (const input of [signatureR, signatureS]) {
  input.addEventListener("input", clearSignatureError);
}
store.subscribe(refresh);
refresh();

function resetConfigurationState(): void {
  preflight?.invalidateWalletBoundary();
  config = undefined;
  preflight = undefined;
  connectedBoundary = undefined;
  signatureR.value = "";
  signatureS.value = "";
  clearSignatureError();
}

function resetConnectionState(): void {
  preflight?.invalidateWalletBoundary();
  connectedBoundary = undefined;
  signatureR.value = "";
  signatureS.value = "";
  clearSignatureError();
}

function clearSignatureError(): void {
  signatureR.removeAttribute("aria-invalid");
  signatureS.removeAttribute("aria-invalid");
  signatureError.textContent = "";
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

function normalizeFelt(value: string | bigint): string {
  return `0x${BigInt(value).toString(16)}`;
}

function redactAddress(value: string): string {
  const normalized = `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  return `${normalized.slice(0, 10)}…${normalized.slice(-8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requiredScalar(record: Record<string, unknown>, field: string): string | bigint {
  const value = record[field];
  if (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") {
    throw new Error(`RPC ${field} must be an integer scalar.`);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`RPC ${field} is outside the safe integer range.`);
    }
    return BigInt(value);
  }
  return value;
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = required(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} is not a button`);
  return element;
}

function requiredInput(id: string): HTMLInputElement {
  const element = required(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`);
  return element;
}
