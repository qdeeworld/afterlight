import { createStore } from "@starknet-io/get-starknet-discovery";
import {
  CallData,
  RpcProvider,
  defaultDeployer,
  hash,
  num,
  type CairoAssembly,
  type CompiledSierra,
} from "starknet";

import { buildReadyLegacyDeclarationPayload } from "../src/operator-declaration.js";
import { verifyDeploymentState, type VerifiedDeploymentState } from "../src/operator-validation.js";

const READY_IDS = new Set(["ready", "readywallet", "readyx", "argentx"]);
const CONNECT = "standard:connect";
const WALLET_API = "starknet:walletApi";
const MAINNET = "0x534e5f4d41494e";

type ReadyWallet = ReturnType<typeof createStore>["getWallets"] extends () => (infer W)[]
  ? W
  : never;

type ReadyLegacyAccount = Readonly<{
  address: string;
  declare(payload: ReturnType<typeof buildReadyLegacyDeclarationPayload>): Promise<{
    transaction_hash: string;
    class_hash: string;
  }>;
}>;

declare global {
  interface Window {
    starknet_argentX?: Readonly<{
      account?: ReadyLegacyAccount;
      chainId?: string;
      enable(options: { starknetVersion: "v5" }): Promise<string[]>;
      selectedAddress?: string;
    }>;
  }
}

type OperatorConfig = Readonly<{
  evidence: "PREPARED_NOT_SIGNED_NOT_SUBMITTED";
  chainId: string;
  rpcUrl: string;
  intendedDeployer: string;
  compilerProfile: string;
  sierraArtifact: string;
  casmArtifact: string;
  classHash: string;
  compiledClassHash: string;
  salt: string;
  unique: boolean;
  deterministicAddress: string;
  constructorCalldata: readonly string[];
  quotedDeclarationStrk: string;
  quotedDeploymentStrk: string;
}>;

const status = required("status");
const review = required("review");
const output = required("output");
const retryButton = requiredButton("retry");
const silentButton = requiredButton("silent");
const connectButton = requiredButton("connect");
const previewButton = requiredButton("preview");
const networkButton = requiredButton("network");
const declareButton = requiredButton("declare");
const deployButton = requiredButton("deploy");

const store = createStore();
let ready: ReadyWallet | undefined;
let config: OperatorConfig | undefined;
let sierra: CompiledSierra | undefined;
let connectedAccount: string | undefined;
let reviewPassed = false;
let classDeclared = false;
let contractDeployed = false;
let deploymentVerification: VerifiedDeploymentState | undefined;

function normalized(value: string): string {
  if (value.trim().toUpperCase() === "SN_MAIN") return MAINNET.toLowerCase();
  return num.toHex(BigInt(value)).toLowerCase();
}

function walletId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findReady(): ReadyWallet | undefined {
  return store.getWallets().find((wallet) => {
    const feature = wallet.features[WALLET_API];
    const id = feature && "id" in feature ? String(feature.id) : "";
    return READY_IDS.has(walletId(wallet.name)) || READY_IDS.has(walletId(id));
  });
}

function refresh(): void {
  ready = findReady();
  const walletReady = Boolean(ready && connectedAccount && config);
  status.textContent = !ready
    ? "Ready X is not detected in this Chrome profile."
    : !connectedAccount
      ? `Ready X ${ready.features[WALLET_API].walletVersion} detected. Connect the intended deployer before requesting a wallet review.`
      : `Ready X ${ready.features[WALLET_API].walletVersion} connected as ${connectedAccount}.`;
  silentButton.disabled = !ready;
  connectButton.disabled = !ready;
  networkButton.disabled = !walletReady || !reviewPassed;
  declareButton.disabled = !walletReady || !reviewPassed || classDeclared;
  deployButton.disabled = !walletReady || !reviewPassed || !classDeclared || contractDeployed;
}

async function loadReviewPackage(): Promise<void> {
  const loadedConfig = await fetchJson<OperatorConfig>("./mainnet-operator-config.local.json");
  if (loadedConfig.evidence !== "PREPARED_NOT_SIGNED_NOT_SUBMITTED") {
    throw new Error("The local configuration is not an unsigned Afterlight review package.");
  }
  if (normalized(loadedConfig.chainId) !== normalized(MAINNET)) {
    throw new Error("The operator configuration is not for Starknet Mainnet.");
  }
  if (loadedConfig.constructorCalldata.length !== 10) {
    throw new Error("Expected exactly ten Afterlight constructor fields.");
  }

  const [loadedSierra, loadedCasm] = await Promise.all([
    fetchJson<CompiledSierra>(loadedConfig.sierraArtifact),
    fetchJson<CairoAssembly>(loadedConfig.casmArtifact),
  ]);
  const computedClassHash = hash.computeContractClassHash(loadedSierra);
  const computedCompiledClassHash = hash.computeCompiledClassHash(loadedCasm);
  if (normalized(computedClassHash) !== normalized(loadedConfig.classHash)) {
    throw new Error("The Sierra artifact does not match the locked class hash.");
  }
  if (normalized(computedCompiledClassHash) !== normalized(loadedConfig.compiledClassHash)) {
    throw new Error("The CASM artifact does not match the locked compiled class hash.");
  }

  const deployment = defaultDeployer.buildDeployerCall(
    {
      classHash: loadedConfig.classHash,
      salt: loadedConfig.salt,
      unique: loadedConfig.unique,
      constructorCalldata: [...loadedConfig.constructorCalldata],
    },
    loadedConfig.intendedDeployer,
  );
  const derivedAddress = deployment.addresses[0];
  if (!derivedAddress || normalized(derivedAddress) !== normalized(loadedConfig.deterministicAddress)) {
    throw new Error("The UDC address does not match the locked deployment address.");
  }

  config = loadedConfig;
  sierra = loadedSierra;
  reviewPassed = true;
  review.textContent = JSON.stringify(
    {
      evidence: "AFTERLIGHT_UNSIGNED_OPERATOR_REVIEW_PASS",
      chainId: loadedConfig.chainId,
      intendedDeployer: normalized(loadedConfig.intendedDeployer),
      compilerProfile: loadedConfig.compilerProfile,
      classHash: normalized(computedClassHash),
      compiledClassHash: normalized(computedCompiledClassHash),
      deterministicAddress: normalized(derivedAddress),
      constructorCalldata: loadedConfig.constructorCalldata,
      quotedDeclarationStrk: loadedConfig.quotedDeclarationStrk,
      quotedDeploymentStrk: loadedConfig.quotedDeploymentStrk,
      declarationTransport: "ready_injected_v5_exact_sn_main_bigint_adapter",
      signed: false,
      submitted: false,
    },
    null,
    2,
  );
  await refreshNetworkState();
  refresh();
}

async function connect(silent: boolean): Promise<void> {
  if (!ready) throw new Error("Ready X is not available in this Chrome profile.");
  const result = await ready.features[CONNECT].connect({ silent });
  const account = result.accounts[0]?.address;
  if (!account) throw new Error("Ready X did not return an account.");
  connectedAccount = normalized(account);
  if (config && connectedAccount !== normalized(config.intendedDeployer)) {
    connectedAccount = undefined;
    throw new Error("Ready X is connected to the wrong deployer account. Switch accounts and reconnect.");
  }
  output.textContent = JSON.stringify(
    { operation: silent ? "silent_connect" : "connect", account: normalized(account) },
    null,
    2,
  );
  refresh();
}

async function assertWalletBoundary(): Promise<OperatorConfig> {
  if (!ready || !config || !connectedAccount || !reviewPassed) {
    throw new Error("Load the review package and connect the intended Ready X account first.");
  }
  const chainId = await ready.features[WALLET_API].request({ type: "wallet_requestChainId" });
  if (normalized(chainId) !== normalized(config.chainId)) {
    throw new Error("Ready X is not on Starknet Mainnet. Switch networks before continuing.");
  }
  if (connectedAccount !== normalized(config.intendedDeployer)) {
    throw new Error("The connected Ready X account is not the locked deployer.");
  }
  return config;
}

async function refreshNetworkState(): Promise<void> {
  if (!config) throw new Error("Load the unsigned review package first.");
  const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
  classDeclared = await exists(async () => provider.getClassByHash(config!.classHash));
  const deployedClassHash = await optional(async () =>
    provider.getClassHashAt(config!.deterministicAddress),
  );
  contractDeployed = deployedClassHash !== undefined;
  deploymentVerification = undefined;
  if (deployedClassHash !== undefined) {
    const deployedConfig = await provider.callContract({
      contractAddress: config.deterministicAddress,
      entrypoint: "get_config",
    });
    deploymentVerification = verifyDeploymentState(
      config.classHash,
      config.constructorCalldata,
      deployedClassHash,
      deployedConfig,
    );
  }
  output.textContent = JSON.stringify(
    {
      evidence: "AFTERLIGHT_MAINNET_READ_ONLY_STATE",
      classHash: config.classHash,
      classDeclared,
      contract: config.deterministicAddress,
      contractDeployed,
      deploymentVerified: deploymentVerification !== undefined,
      deployedClassHash: deploymentVerification?.classHash ?? null,
      deployedConfig: deploymentVerification?.config ?? null,
      signed: false,
      submitted: false,
    },
    null,
    2,
  );
  refresh();
}

async function requestDeclarationReview(): Promise<void> {
  const locked = await assertWalletBoundary();
  if (!sierra) throw new Error("The verified Sierra artifact is unavailable.");
  await refreshNetworkState();
  if (classDeclared) throw new Error("The locked Afterlight class is already declared.");
  // Ready 5.33.9's standard handler serializes the Sierra class before its
  // internal action and cannot complete fee estimation. Its legacy v5 route
  // preserves the exact class and hashes, but initializes Starknet.js with the
  // textual chain ID `SN_MAIN`, which that bundled version passes to BigInt.
  // Adapt only that exact equivalent value during initialization, then restore
  // the native global before any wallet review or transaction signing.
  const legacy = window.starknet_argentX;
  if (!legacy) throw new Error("Ready X did not expose its injected declaration provider.");
  const nativeBigInt = window.BigInt;
  const compatibleBigInt = ((value: string | number | bigint | boolean) =>
    nativeBigInt(typeof value === "string" && value.trim().toUpperCase() === "SN_MAIN" ? locked.chainId : value)) as BigIntConstructor;
  compatibleBigInt.asIntN = nativeBigInt.asIntN;
  compatibleBigInt.asUintN = nativeBigInt.asUintN;
  let enabledAddress: string | undefined;
  try {
    window.BigInt = compatibleBigInt;
    [enabledAddress] = await legacy.enable({ starknetVersion: "v5" });
  } finally {
    window.BigInt = nativeBigInt;
  }
  if (!enabledAddress || normalized(enabledAddress) !== normalized(locked.intendedDeployer)) {
    throw new Error("Ready X initialized the wrong injected declaration account.");
  }
  if (!legacy.account || normalized(legacy.account.address) !== normalized(locked.intendedDeployer)) {
    throw new Error("Ready X did not initialize the locked declaration account.");
  }
  if (legacy.chainId && normalized(legacy.chainId) !== normalized(locked.chainId)) {
    throw new Error("Ready X's injected declaration account is not on Starknet Mainnet.");
  }
  const result = await legacy.account.declare(
    buildReadyLegacyDeclarationPayload(sierra, locked.classHash, locked.compiledClassHash),
  );
  if (normalized(result.class_hash) !== normalized(locked.classHash)) {
    throw new Error(`Ready returned an unexpected declared class hash: ${result.class_hash}`);
  }
  output.textContent = JSON.stringify(
    {
      operation: "declaration_submitted_by_ready",
      transactionHash: result.transaction_hash,
      classHash: result.class_hash,
    },
    null,
    2,
  );
}

async function requestDeploymentReview(): Promise<void> {
  const locked = await assertWalletBoundary();
  await refreshNetworkState();
  if (!classDeclared) throw new Error("Declare the locked class before requesting deployment.");
  if (contractDeployed) throw new Error("The locked Afterlight contract is already deployed.");
  if (!ready) throw new Error("Ready X is unavailable.");
  const deployment = defaultDeployer.buildDeployerCall(
    {
      classHash: locked.classHash,
      salt: locked.salt,
      unique: locked.unique,
      constructorCalldata: [...locked.constructorCalldata],
    },
    locked.intendedDeployer,
  );
  const result = await ready.features[WALLET_API].request({
    type: "wallet_addInvokeTransaction",
    params: {
      calls: deployment.calls.map((call) => ({
        contract_address: call.contractAddress,
        entry_point: call.entrypoint,
        calldata: CallData.compile(call.calldata ?? []),
      })),
    },
  });
  output.textContent = JSON.stringify(
    {
      operation: "deployment_submitted_by_ready",
      transactionHash: result.transaction_hash,
      expectedContract: locked.deterministicAddress,
    },
    null,
    2,
  );
}

async function exists(action: () => Promise<unknown>): Promise<boolean> {
  return (await optional(action)) !== undefined;
}

async function optional<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|not declared|requested contract address is not deployed/i.test(message)) {
      return undefined;
    }
    throw error;
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
  return (await response.json()) as T;
}

async function guarded(action: () => Promise<void>): Promise<void> {
  for (const button of [previewButton, silentButton, connectButton, networkButton, declareButton, deployButton]) {
    button.disabled = true;
  }
  try {
    await action();
  } catch (error) {
    output.textContent = JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        recovery: "Correct the stated account, network, artifact, or onchain-state issue, then retry the same step.",
      },
      null,
      2,
    );
  } finally {
    refresh();
  }
}

retryButton.addEventListener("click", () => {
  store._refreshInjectedWallets();
  refresh();
});
previewButton.addEventListener("click", () => void guarded(loadReviewPackage));
silentButton.addEventListener("click", () => void guarded(() => connect(true)));
connectButton.addEventListener("click", () => void guarded(() => connect(false)));
networkButton.addEventListener("click", () => void guarded(refreshNetworkState));
declareButton.addEventListener("click", () => void guarded(requestDeclarationReview));
deployButton.addEventListener("click", () => void guarded(requestDeploymentReview));
store.subscribe(refresh);
refresh();

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = required(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} is not a button.`);
  return element;
}
