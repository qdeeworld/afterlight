import { hash, shortString } from "starknet";

export const ROLE_BOUND_SETUP_POLICY = "afterlight-role-bound-setup/1";
export const SETUP_AUTHORIZATION_SCHEMA = "afterlight-setup-authorization/1";

/**
 * Additional sponsor-policy consent, NOT a replacement for the onchain exit
 * signature. The digest covers canonical JSON of the complete FINAL package,
 * excluding only `locks` and `setupAuthorization`. Both SHA-256 limbs are
 * retained; reducing a 256-bit digest modulo the Stark field is not permitted.
 *
 * This binds the exact optional setup bytes. It does not establish that an
 * encrypted subchannel belongs to the exit token or the recipient.
 */
export function setupAuthorizationHash(unsignedPayloadSha256) {
  if (typeof unsignedPayloadSha256 !== "string" || !/^[0-9a-f]{64}$/.test(unsignedPayloadSha256)) {
    throw new TypeError("setup authorization requires a canonical SHA-256 digest");
  }
  return hash.computeHashOnElements([
    shortString.encodeShortString("AFTERLIGHT_SETUP_V1"),
    "0x534e5f4d41494e", // Mainnet
    "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46", // sponsor
    "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a", // pool
    "0x067dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d", // pool class
    "0x06e8b6e49b4366e0dc6a35eee722b417c718988eca3f4a0c298bdf8785261c25", // Afterlight
    "0x05da9866f62cc6dd1e380e8d9206e78a752b460abdb802070e0be1208ec7b1a6", // Afterlight class
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", // STRK
    `0x${unsignedPayloadSha256.slice(0, 32)}`,
    `0x${unsignedPayloadSha256.slice(32)}`,
  ]);
}
