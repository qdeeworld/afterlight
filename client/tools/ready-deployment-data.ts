import { createStore } from "@starknet-io/get-starknet-discovery";

const READY_IDS = new Set(["ready", "readywallet", "readyx", "argentx"]);
const CONNECT = "standard:connect";
const WALLET_API = "starknet:walletApi";

type ReadyWallet = ReturnType<typeof createStore>["getWallets"] extends () => (infer W)[]
  ? W
  : never;

const status = required("status");
const output = required("output");
const walletHelp = required("wallet-help");
const retryButton = requiredButton("retry");
const silentButton = requiredButton("silent");
const connectButton = requiredButton("connect");
const deploymentButton = requiredButton("deployment");
const capabilitiesButton = requiredButton("capabilities");

const store = createStore();
let ready: ReadyWallet | undefined;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findReady(): ReadyWallet | undefined {
  return store.getWallets().find((wallet) => {
    const feature = wallet.features[WALLET_API];
    const id = feature && "id" in feature ? String(feature.id) : "";
    return READY_IDS.has(normalize(wallet.name)) || READY_IDS.has(normalize(id));
  });
}

function refresh(): void {
  const discovered = store.getWallets();
  ready = findReady();
  status.textContent = ready
    ? `Ready X ${ready.features[WALLET_API].walletVersion} discovered. No transaction will be signed.`
    : discovered.length === 0
      ? "Waiting for Ready X Wallet Standard registration…"
      : `Ready X not found. Discovered: ${discovered.map((wallet) => wallet.name).join(", ")}`;
  silentButton.disabled = !ready;
  connectButton.disabled = !ready;
  deploymentButton.disabled = !ready;
  capabilitiesButton.disabled = !ready;
  walletHelp.hidden = Boolean(ready);
}

async function connect(silent: boolean): Promise<void> {
  if (!ready) throw new Error("Ready X is not available");
  const result = await ready.features[CONNECT].connect({ silent });
  output.textContent = JSON.stringify(
    {
      operation: silent ? "silent_connect" : "connect",
      accounts: result.accounts.map((account) => account.address),
    },
    null,
    2,
  );
  refresh();
}

async function readDeploymentData(): Promise<void> {
  if (!ready) throw new Error("Ready X is not available");
  const request = ready.features[WALLET_API].request;
  const [chainId, deployment] = await Promise.all([
    request({ type: "wallet_requestChainId" }),
    request({ type: "wallet_deploymentData" }),
  ]);
  output.textContent = JSON.stringify(
    {
      evidence: "READY_WALLET_READ_ONLY_DEPLOYMENT_DATA",
      walletName: ready.name,
      walletVersion: ready.features[WALLET_API].walletVersion,
      chainId,
      address: deployment.address,
      class_hash: deployment.class_hash,
      salt: deployment.salt,
      calldata: deployment.calldata,
      version: deployment.version,
      sigdataLength: deployment.sigdata?.length ?? 0,
    },
    null,
    2,
  );
}

async function readApiSupport(): Promise<void> {
  if (!ready) throw new Error("Ready X is not available");
  const request = ready.features[WALLET_API].request;
  const [chainId, specifications, walletApiVersions] = await Promise.all([
    request({ type: "wallet_requestChainId" }),
    request({ type: "wallet_supportedSpecs" }),
    request({ type: "wallet_supportedWalletApi" }),
  ]);
  output.textContent = JSON.stringify(
    {
      evidence: "READY_WALLET_READ_ONLY_API_SUPPORT",
      walletName: ready.name,
      walletVersion: ready.features[WALLET_API].walletVersion,
      chainId,
      specifications,
      walletApiVersions,
    },
    null,
    2,
  );
}

async function guarded(action: () => Promise<void>): Promise<void> {
  for (const button of [
    silentButton,
    connectButton,
    deploymentButton,
    capabilitiesButton,
  ]) {
    button.disabled = true;
  }
  try {
    await action();
  } catch (error) {
    output.textContent = JSON.stringify(
      { error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    );
  } finally {
    refresh();
  }
}

silentButton.addEventListener("click", () => void guarded(() => connect(true)));
connectButton.addEventListener("click", () => void guarded(() => connect(false)));
deploymentButton.addEventListener("click", () => void guarded(readDeploymentData));
capabilitiesButton.addEventListener("click", () => void guarded(readApiSupport));
retryButton.addEventListener("click", () => {
  store._refreshInjectedWallets();
  refresh();
});
store.subscribe(refresh);
refresh();

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
