import fs from "node:fs";

import { Account, RpcProvider, constants, hash, num } from "starknet";

// Read-only DEPLOY_ACCOUNT fee estimator. It accepts only the public payload
// returned by wallet_deploymentData, skips account validation, and never calls
// a signing or transaction-submission method.
const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Usage: npm run quote:ready-deploy -- /path/to/deployment-data.json");
}

const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const requiredFelt = (name) => {
  const value = input[name];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new TypeError(`${name} must be a hexadecimal felt`);
  }
  return value;
};

if (input.evidence !== "READY_WALLET_READ_ONLY_DEPLOYMENT_DATA") {
  throw new Error("Input is not the read-only Ready deployment-data envelope");
}
if (!Array.isArray(input.calldata) || input.calldata.some((value) =>
  typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))) {
  throw new TypeError("calldata must be an array of hexadecimal felts");
}
if (input.chainId !== constants.StarknetChainId.SN_MAIN) {
  throw new Error(`Expected Starknet Mainnet chain ID, received ${input.chainId}`);
}

const address = requiredFelt("address");
const classHash = requiredFelt("class_hash");
const addressSalt = requiredFelt("salt");
const constructorCalldata = input.calldata;
const derivedAddress = hash.calculateContractAddressFromHash(
  addressSalt,
  classHash,
  constructorCalldata,
  0,
);
if (num.toHex(BigInt(address)).toLowerCase() !== num.toHex(BigInt(derivedAddress)).toLowerCase()) {
  throw new Error(`Ready address does not match its deployment payload: ${address}`);
}

const rpcUrl =
  process.env.AFTERLIGHT_STARKNET_RPC_URL ?? "https://rpc.starknet.lava.build";
const provider = new RpcProvider({ nodeUrl: rpcUrl });

class NoSignSigner {
  async getPubKey() { return "0x0"; }
  async signMessage() { throw new Error("Signing is disabled"); }
  async signTransaction() { throw new Error("Signing is disabled"); }
  async signDeployAccountTransaction() { throw new Error("Signing is disabled"); }
  async signDeclareTransaction() { throw new Error("Signing is disabled"); }
}

const account = new Account({
  provider,
  address,
  signer: new NoSignSigner(),
});

let deployedClassHash = null;
try {
  deployedClassHash = await provider.getClassHashAt(address);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/contract not found|requested contract address is not deployed/i.test(message)) {
    throw error;
  }
}
if (deployedClassHash !== null) {
  throw new Error(`Account is already deployed with class hash ${deployedClassHash}`);
}

const block = await provider.getBlock("latest");
const fee = await account.estimateAccountDeployFee(
  { classHash, addressSalt, constructorCalldata, contractAddress: address },
  { nonce: 0, skipValidate: true, blockIdentifier: "latest" },
);

const formatStrk = (fri) => {
  const value = BigInt(fri);
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0");
  return `${whole}.${fraction}`;
};

console.log(JSON.stringify({
  evidence: "READY_DEPLOY_ACCOUNT_NO_SIGN_ESTIMATE",
  blockNumber: block.block_number,
  address,
  classHash,
  addressSalt,
  constructorCalldataLength: constructorCalldata.length,
  walletName: input.walletName ?? null,
  walletVersion: input.walletVersion ?? null,
  overallFeeFri: fee.overall_fee.toString(),
  overallFeeStrk: formatStrk(fee.overall_fee),
  unit: fee.unit,
  resourceBounds: fee.resourceBounds,
}, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
