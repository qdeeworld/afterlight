import type { CompiledSierra } from "starknet";

export type ReadyLegacyDeclarationPayload = Readonly<{
  contract: CompiledSierra;
  classHash: string;
  compiledClassHash: string;
}>;

export function buildReadyLegacyDeclarationPayload(
  contract: CompiledSierra,
  classHash: string,
  compiledClassHash: string,
): ReadyLegacyDeclarationPayload {
  if (!Array.isArray(contract.abi)) {
    throw new Error("The Ready legacy declaration path requires the unstringified Sierra ABI.");
  }
  return Object.freeze({ contract, classHash, compiledClassHash });
}
