import { felt, type FeltInput } from "./encoding.js";

export type VerifiedDeploymentState = Readonly<{
  classHash: string;
  config: readonly string[];
}>;

/**
 * Fail closed unless Mainnet's deployed class and every constructor-derived
 * config field match the locked unsigned package exactly.
 */
export function verifyDeploymentState(
  expectedClassHash: FeltInput,
  expectedConfig: readonly FeltInput[],
  actualClassHash: FeltInput,
  actualConfig: readonly FeltInput[],
): VerifiedDeploymentState {
  const expectedHash = felt(expectedClassHash, "expected class hash");
  const observedHash = felt(actualClassHash, "deployed class hash");
  if (observedHash !== expectedHash) {
    throw new Error("the deployed contract has the wrong class hash");
  }
  if (actualConfig.length !== expectedConfig.length) {
    throw new Error(
      `the deployed config has ${actualConfig.length} fields; expected ${expectedConfig.length}`,
    );
  }

  const expected = expectedConfig.map((value, index) => felt(value, `expected config[${index}]`));
  const observed = actualConfig.map((value, index) => felt(value, `deployed config[${index}]`));
  for (let index = 0; index < expected.length; index += 1) {
    if (observed[index] !== expected[index]) {
      throw new Error(`the deployed config differs at field ${index}`);
    }
  }

  return Object.freeze({
    classHash: observedHash,
    config: Object.freeze(observed),
  });
}
