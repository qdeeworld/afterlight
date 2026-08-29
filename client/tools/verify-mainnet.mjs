import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RpcProvider } from "starknet";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const RPC_URL = process.env.STARKNET_RPC_URL ?? "https://rpc.starknet.lava.build";
const provider = new RpcProvider({ nodeUrl: RPC_URL });
const RECEIPT_RPC_URLS = [
  RPC_URL,
  process.env.STARKNET_FALLBACK_RPC_URL ?? "https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_10",
];
const receiptRpcUrls = [...new Set(RECEIPT_RPC_URLS)];
const receiptProviders = receiptRpcUrls.map(
  (nodeUrl) => new RpcProvider({ nodeUrl }),
);

const expected = {
  chainId: "0x534e5f4d41494e",
  contract: "0x06e8b6e49b4366e0dc6a35eee722b417c718988eca3f4a0c298bdf8785261c25",
  classHash: "0x05da9866f62cc6dd1e380e8d9206e78a752b460abdb802070e0be1208ec7b1a6",
  pool: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
  token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  neutral: "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46",
  qualifyingSenders: {
    "0x030ea14ac22e5806e382658971b686692af280bf2f02173a430f572921121722":
      "0x073c97f6049ecfaac9284686454550e6d74769eb6ebd8fc014c12eba4ca0dd7",
    "0x69e2345ae8816986a709de84f0dcb571b5d092400d6c53bf90197480102c0fb":
      "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46",
    "0x036e003396fe360ae7fe4766646f493c0eb579d82509652559d40e460770682a":
      "0x03dc021b06b8f0a5038b238b71ef5dd6d94b3efdbb7c5dafa1d914c5e89fa55a",
    "0x11c990aea864e755630d41fd1292620c313b3f64407fc0b3a902544c67c8098":
      "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46",
    "0x722033f7fd0397ff4d3845428c98cad885b6a63824f7c78a2b7e1d7d6f5c1b6":
      "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46",
  },
  config: [
    "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    "1000000000000000000", "2592000", "604800", "300", "300", "31536000", "900", "300",
  ],
  vaults: [
    { name: "Vault A", id: "0x06d6c75f3625806e4e186e94e98c36074cb6a53b990cf8b5d98b91f1b9931d7", state: 4n },
    { name: "Vault B", id: "0x00df091b09941850386624da955ea4b9a7bedea70b1fe03734a5ddfa291fa5b2", state: 3n },
    { name: "Public E3 vault", id: "0x03ace87fc2d2fc6b1849ce77de6460900a34168541e4cea04e09e34e04d2b0", state: 3n },
  ],
  controls: [
    "0x0500ea24d721ce9c051ee7ef44bb4f786f26b0363fbfbe7c1b71facf62f9f7ab",
    "0x02a5d7cd844e5dbae9b6c6a3f1ab53a2d2cedce33c5b20a53f04db247d69b437",
    "0x06cb079f8415e74f609e05df8ce5357c5706f1f266b00539e236a76624a0b513",
    "0x041a44e82131392092b54edc305bb6dc20708301623ceb519ed0006ee044fc90",
  ],
};

const sameFelt = (left, right) => BigInt(left) === BigInt(right);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const unwrapRpcValue = (response) => response?.value ?? response;
const succeeded = (receipt) =>
  receipt.execution_status === "SUCCEEDED" && receipt.finality_status === "ACCEPTED_ON_L1";
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const getL1Receipt = async (transactionHash) => {
  let receipt;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const receiptProvider of receiptProviders) {
      try {
        receipt = unwrapRpcValue(await receiptProvider.getTransactionReceipt(transactionHash));
        if (succeeded(receipt)) return receipt;
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt < 2) await wait(250 * (attempt + 1));
  }
  throw new Error(
    `${transactionHash} is not SUCCEEDED / ACCEPTED_ON_L1 ` +
      `(observed ${receipt?.execution_status ?? "unknown"} / ${receipt?.finality_status ?? "unknown"}; ` +
      `last RPC error: ${lastError instanceof Error ? lastError.message : "none"}).`,
  );
};
const hasEventFrom = (receipt, address) =>
  receipt.events.some((event) => sameFelt(event.from_address, address));
const calldataContains = (transaction, address) =>
  Array.isArray(transaction.calldata) && transaction.calldata.some((felt) => sameFelt(felt, address));

assert(sameFelt(await provider.getChainId(), expected.chainId), "RPC is not Starknet Mainnet.");
assert(sameFelt(await provider.getClassHashAt(expected.contract), expected.classHash), "Deployed class hash mismatch.");

const config = await provider.callContract({ contractAddress: expected.contract, entrypoint: "get_config", calldata: [] });
assert(config.length === expected.config.length, "Unexpected deployed configuration length.");
expected.config.forEach((felt, index) =>
  assert(sameFelt(config[index], felt), `Deployed configuration mismatch at index ${index}.`),
);

const locked = await provider.callContract({
  contractAddress: expected.contract,
  entrypoint: "get_locked_by_token",
  calldata: [expected.token],
});
assert(locked.length === 2 && locked.every((felt) => BigInt(felt) === 0n), "Afterlight liability is not zero.");

const declaration = JSON.parse(fs.readFileSync(path.join(ROOT, "strk20.json"), "utf8"));
assert(declaration.contracts.length === 1 && sameFelt(declaration.contracts[0], expected.contract), "strk20.json contract mismatch.");
assert(declaration.demo_url === "https://afterlight.dolepee.com", "strk20.json demo URL mismatch.");
assert(declaration.transactions.length === 5, "Expected exactly five qualifying transactions.");

for (const transactionHash of declaration.transactions) {
  const [receipt, transaction] = await Promise.all([
    getL1Receipt(transactionHash), provider.getTransactionByHash(transactionHash),
  ]);
  assert(hasEventFrom(receipt, expected.pool), `${transactionHash} does not touch the canonical pool.`);
  assert(hasEventFrom(receipt, expected.contract) || calldataContains(transaction, expected.contract), `${transactionHash} is not owned by Afterlight.`);
  assert(
    sameFelt(transaction.sender_address, expected.qualifyingSenders[transactionHash]),
    `${transactionHash} outer sender does not match the audited release.`,
  );
}

for (const transactionHash of expected.controls) {
  const [receipt, transaction] = await Promise.all([
    getL1Receipt(transactionHash), provider.getTransactionByHash(transactionHash),
  ]);
  assert(sameFelt(transaction.sender_address, expected.neutral), `${transactionHash} was not submitted by the neutral relayer.`);
  assert(hasEventFrom(receipt, expected.contract), `${transactionHash} has no Afterlight event.`);
}

for (const vault of expected.vaults) {
  const state = await provider.callContract({ contractAddress: expected.contract, entrypoint: "get_vault", calldata: [vault.id] });
  assert(BigInt(state[0]) === 1n, `${vault.name} does not exist.`);
  assert(BigInt(state[1]) === vault.state, `${vault.name} is not terminal in the expected state.`);
}

process.stdout.write(`${JSON.stringify({
  evidence: "AFTERLIGHT_MAINNET_VERIFIED",
  chainId: expected.chainId,
  contract: expected.contract,
  classHash: expected.classHash,
  qualifyingTransactions: declaration.transactions.length,
  neutralControls: expected.controls.length,
  terminalVaults: expected.vaults.length,
  lockedLiability: "0",
  rpcOrigins: receiptRpcUrls.map((url) => new URL(url).origin),
})}\n`);
