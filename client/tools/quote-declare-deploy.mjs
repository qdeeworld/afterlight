import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Account,
  RpcProvider,
  TransactionType,
  defaultDeployer,
  hash,
} from "starknet";

// This tool can only call starknet_simulateTransactions. It deliberately has
// no private key, no signing path, and no transaction-submission method.
const clientDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspaceDirectory = path.dirname(clientDirectory);
const compilerProfile = process.env.AFTERLIGHT_COMPILER_PROFILE ?? "spike-inline-8";
const allowedProfiles = new Set([
  "release",
  "spike-size",
  "spike-inline-4",
  "spike-inline-8",
  "spike-inline-12",
  "spike-inline-56",
]);
if (!allowedProfiles.has(compilerProfile)) {
  throw new Error(`Unsupported compiler profile: ${compilerProfile}`);
}
const artifactDirectory = path.join(
  workspaceDirectory,
  "target",
  compilerProfile,
);

const sierraPath = path.join(
  artifactDirectory,
  "afterlight_spike_Afterlight.contract_class.json",
);
const casmPath = path.join(
  artifactDirectory,
  "afterlight_spike_Afterlight.compiled_contract_class.json",
);

if (!fs.existsSync(sierraPath) || !fs.existsSync(casmPath)) {
  throw new Error(
    `Missing ${compilerProfile} artifacts; build that profile first.`,
  );
}

const contract = JSON.parse(fs.readFileSync(sierraPath, "utf8"));
const casm = JSON.parse(fs.readFileSync(casmPath, "utf8"));

const rpcUrl =
  process.env.AFTERLIGHT_STARKNET_RPC_URL ?? "https://rpc.starknet.lava.build";
const provider = new RpcProvider({ nodeUrl: rpcUrl });

// Existing Cairo-1 public account used only to give the simulator a valid
// execution context. SKIP_VALIDATE and SKIP_FEE_CHARGE mean no account secret,
// balance, signature, or fee is required.
const simulationSender =
  "0x0aedfe7ef03e220aba548dfc4f59c6ab8aa3030d6b8556527a6600fa87ae2d7";
const account = new Account({
  provider,
  address: simulationSender,
  signer: "0x1",
  cairoVersion: "1",
});

const classHash = hash.computeContractClassHash(contract);
const compiledClassHash = hash.computeCompiledClassHash(casm);
const nonce = await provider.getNonceForAddress(simulationSender);
const block = await provider.getBlock("latest");

const pool =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const strk =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const constructorCalldata = [
  pool,
  strk,
  simulationSender,
  10_000_000_000_000_000_000n,
  2_592_000n,
  604_800n,
  300n,
  300n,
  31_536_000n,
  900n,
  300n,
];
const deployPayload = {
  classHash,
  salt: "0x41465445524c49474854",
  unique: true,
  constructorCalldata,
};
const deployment = defaultDeployer.buildDeployerCall(
  deployPayload,
  simulationSender,
);

const result = await account.simulateTransaction(
  [
    {
      type: TransactionType.DECLARE,
      payload: { contract, casm },
    },
    {
      type: TransactionType.DEPLOY,
      payload: deployPayload,
    },
    {
      type: TransactionType.INVOKE,
      payload: [
        {
          contractAddress: deployment.addresses[0],
          entrypoint: "sync_funding_checkpoint",
          calldata: [],
        },
      ],
    },
  ],
  { nonce, skipValidate: true },
);

const simulations = result.simulated_transactions;
if (simulations.length !== 3) {
  throw new Error(`Expected three simulation results, received ${simulations.length}.`);
}

const [declaration, deploy, checkpointSync] = simulations;
if (declaration === undefined || deploy === undefined || checkpointSync === undefined) {
  throw new Error("Declaration, deployment, or checkpoint simulation result is missing.");
}
if (
  declaration.transaction_trace.type !== "DECLARE" ||
  deploy.transaction_trace.type !== "INVOKE" ||
  checkpointSync.transaction_trace.type !== "INVOKE" ||
  "revert_reason" in deploy.transaction_trace ||
  "revert_reason" in checkpointSync.transaction_trace
) {
  throw new Error("Sequential declaration/deployment/checkpoint simulation did not succeed.");
}

const declarationFee = BigInt(declaration.overall_fee);
const deploymentFee = BigInt(deploy.overall_fee);
const checkpointSyncFee = BigInt(checkpointSync.overall_fee);
const formatStrk = (fri) => {
  const whole = fri / 1_000_000_000_000_000_000n;
  const fraction = (fri % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0");
  return `${whole}.${fraction}`;
};

console.log(
  JSON.stringify(
    {
      evidence: "NO_SUBMIT_SIMULATION",
      blockNumber: block.block_number,
      simulationSender,
      nonce,
      compilerProfile,
      sierraWords: contract.sierra_program.length,
      casmWords: casm.bytecode.length,
      classHash,
      compiledClassHash,
      deterministicDeploymentAddress: deployment.addresses[0],
      declarationFeeFri: declarationFee,
      declarationFeeStrk: formatStrk(declarationFee),
      deploymentFeeFri: deploymentFee,
      deploymentFeeStrk: formatStrk(deploymentFee),
      checkpointSyncFeeFri: checkpointSyncFee,
      checkpointSyncFeeStrk: formatStrk(checkpointSyncFee),
      combinedFeeFri: declarationFee + deploymentFee,
      combinedFeeStrk: formatStrk(declarationFee + deploymentFee),
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ),
);
