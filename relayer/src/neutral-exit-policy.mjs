import { createHash } from "node:crypto";
import { constants, ec, hash, shortString } from "starknet";
import {
  ROLE_BOUND_SETUP_POLICY,
  SETUP_AUTHORIZATION_SCHEMA,
  setupAuthorizationHash,
} from "../../client/src/setup-authorization.mjs";

export const MAINNET_CHAIN_ID = "0x534e5f4d41494e";
export const LOCKED_NEUTRAL_ADDRESS =
  "0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46";
export const LOCKED_NEUTRAL_PUBLIC_KEY =
  "0x0c041078765f888f2a22a0f68221011641879b222b657cc125014f18c2976ae";
export const LOCKED_AFTERLIGHT_ADDRESS =
  "0x06e8b6e49b4366e0dc6a35eee722b417c718988eca3f4a0c298bdf8785261c25";
export const LOCKED_POOL_ADDRESS =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
export const LOCKED_POOL_CLASS_HASH =
  "0x067dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d";
export const LOCKED_POOL_FEE_COLLECTOR =
  "0x0d79041634625e5288296fbc648088788710ba44903a3a49468a66567749e77";
export const LOCKED_TOKEN_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const LOCKED_AFTERLIGHT_CLASS_HASH =
  "0x05da9866f62cc6dd1e380e8d9206e78a752b460abdb802070e0be1208ec7b1a6";
export const LOCKED_NEUTRAL_CLASS_HASH =
  "0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381";
export const LOCKED_AMOUNT_FRI = 1_000_000_000_000_000_000n;
export const LOCKED_POOL_FEE_FRI = 6_000_000_000_000_000_000n;
export const LOCKED_INITIAL_ALLOWANCE_FRI = 12_000_000_000_000_000_000n;
export const LOCKED_MAX_POOL_ALLOWANCE_FRI = 60_000_000_000_000_000_000n;
export const OPEN_NOTE_PACKED_VALUE = 1n << 128n;
export const LOCKED_HEALTH_FLOOR_FRI = 1_000_000_000_000_000_000n;
export const ABSOLUTE_NETWORK_CAP_PER_EXIT_FRI = 9_027_538_581_262_736_234n;
export const MAX_ESTIMATE_AGE_BLOCKS = 300n;
export const MIN_AUTH_INCLUSION_BUFFER_SECONDS = 180n;
export const MINIMUM_RPC_SPEC = "0.10.1";
export const STARKNETJS_VERSION = "10.7.0";
export const STARKNETJS_PACKAGE_SHA256 =
  "3a3b783706f1adde673f29c3afff69f6e7f57c2cfcff774b99110253e962c8e7";
export const STARKNETJS_MODULE_SHA256 =
  "7aa6f8c6e3df5d7016df991cb61997a76c4f1247e51c722489511712b99cb38a";
export const OPEN_NOTE_DEPOSITED_SELECTOR =
  "0x25b6da03c4858d11cb0708d5cb6be79b190fb32eb7a7ce83804e07cbbb9bead";
export const VAULT_CANCELLED_SELECTOR =
  "0x4a883802e2fa6195c66706431ffafa819d6cdd4b00df619fe567339accfc0d";
export const RECOVERY_CLAIMED_SELECTOR =
  "0xff3a13b99d0d3f8d2e9810175bcf474778d8a17e3321d43dc845ae218f0a13";
export const MAX_PROOF_BYTES = 32 * 1024 * 1024;
export const MAX_CALLDATA_FELTS = 16_384;
export const PROOF0_HEADER = "0x50524f4f4630";
export const PROOF1_HEADER = "0x50524f4f4631";
export const ESTIMATE_VIRTUAL_PROGRAM_HASH =
  "0x03e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473";
export const ESTIMATE_STARKNET_OS_CONFIG_HASH =
  "0x070c7b342f93155315d1cb2da7a4e13a3c2430f51fb5696c1b224c3da5508dfb";

const FELT_RE = /^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i;
const HEX_RE = /^0x[0-9a-f]+$/i;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const STARK_FIELD_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
const U64_MAX = 2n ** 64n - 1n;
const POOL_SINGLETON_STORAGE = [
  "auditor_public_key", "screener_public_key", "fee_amount", "fee_collector", "proof_validity_blocks",
].map((name) => hash.starknetKeccak(name));
const ACTION_POLICY = Object.freeze({
  CANCEL_REFUND: Object.freeze({
    discriminant: 1n,
    requiredState: 1n,
    finalState: 4n,
    roleNonceIndex: 13,
    eventName: "VaultCancelled",
    eventSelector: VAULT_CANCELLED_SELECTOR,
  }),
  CLAIM: Object.freeze({
    discriminant: 2n,
    requiredState: 2n,
    finalState: 3n,
    roleNonceIndex: 14,
    eventName: "RecoveryClaimed",
    eventSelector: RECOVERY_CLAIMED_SELECTOR,
  }),
});

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  const visit = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item)) throw new TypeError("noncanonical_number");
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => {
        if (item[key] === undefined) throw new TypeError("undefined_not_canonical");
        return [key, visit(item[key])];
      }));
    }
    throw new TypeError("unsupported_canonical_json_value");
  };
  return JSON.stringify(visit(value));
}

export function hashCanonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

export function normalizeFelt(value, label = "felt") {
  if (typeof value !== "string" || !FELT_RE.test(value)) {
    throw new TypeError(`invalid_${label}`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= STARK_FIELD_PRIME) throw new RangeError(`${label}_out_of_range`);
  return parsed.toString();
}

export function normalizeHex(value, label = "hex") {
  if (typeof value !== "string" || !HEX_RE.test(value)) {
    throw new TypeError(`invalid_${label}`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= STARK_FIELD_PRIME) throw new RangeError(`${label}_out_of_range`);
  return `0x${parsed.toString(16)}`;
}

export function validateAfterlightConfigResult(configRaw) {
  if (!Array.isArray(configRaw) || configRaw.length !== 10) {
    throw new Error("afterlight_config_shape_drift");
  }
  if (
    normalizeHex(configRaw[0]) !== normalizeHex(LOCKED_POOL_ADDRESS) ||
    normalizeHex(configRaw[1]) !== normalizeHex(LOCKED_TOKEN_ADDRESS) ||
    BigInt(configRaw[2]) !== LOCKED_AMOUNT_FRI
  ) {
    throw new Error("afterlight_config_drift");
  }
}

export function strictDecimal(value, label = "decimal") {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    throw new TypeError(`invalid_${label}`);
  }
  return BigInt(value);
}

function integer(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && (DECIMAL_RE.test(value) || HEX_RE.test(value))) {
    return BigInt(value);
  }
  throw new TypeError(`invalid_${label}`);
}

function feltArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`invalid_${label}`);
  if (value.length > MAX_CALLDATA_FELTS) throw new RangeError(`${label}_too_large`);
  return value.map((item, index) => normalizeFelt(item, `${label}_${index}`));
}

function sameFelts(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((item, index) => normalizeFelt(item) === normalizeFelt(right[index]))
  );
}

export function decodeCanonicalProofData(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROOF_BYTES * 2) {
    throw new Error("invalid_proof_data");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("proof_data_not_canonical_base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > MAX_PROOF_BYTES) throw new Error("proof_data_size");
  if (decoded.toString("base64") !== value) throw new Error("proof_data_not_canonical_base64");
  return decoded;
}

export function parseProofFacts(raw) {
  const facts = feltArray(raw, "proof_facts");
  if (facts.length < 9) throw new Error("proof_facts_too_short");
  const messageCount = Number(BigInt(facts[7]));
  if (!Number.isSafeInteger(messageCount) || messageCount !== 1 || facts.length !== 8 + messageCount) {
    throw new Error("proof_facts_message_shape");
  }
  const baseBlockNumber = BigInt(facts[4]);
  if (baseBlockNumber === 0n) throw new Error("proof_facts_zero_base_block");
  if (BigInt(facts[8]) === 0n) throw new Error("proof_facts_zero_message_hash");
  return Object.freeze({ facts, baseBlockNumber, messageHash: facts[8] });
}

// Starknet's fee-estimation path accepts the current SDK mock-proof envelope,
// while Ready's real mainnet proofs and accepted transactions use a PROOF1
// envelope. Keep the real facts immutable for signing/broadcast and normalize
// only the three versioned envelope fields in the quote copy. The base block,
// block hash, message count, and action-bound message hash remain byte-for-byte.
export function proofFactsForFeeEstimate(raw) {
  const parsed = parseProofFacts(raw);
  if (BigInt(parsed.facts[0]) !== BigInt(PROOF1_HEADER)) {
    throw new Error("fee_estimate_requires_real_proof1_input");
  }
  const facts = [...parsed.facts];
  facts[0] = normalizeFelt(PROOF0_HEADER);
  facts[2] = normalizeFelt(ESTIMATE_VIRTUAL_PROGRAM_HASH);
  facts[6] = normalizeFelt(ESTIMATE_STARKNET_OS_CONFIG_HASH);
  return Object.freeze(facts);
}

export function parseServerActions(rawCalldata) {
  const raw = feltArray(rawCalldata, "pool_calldata").map(BigInt);
  let cursor = 0;
  const take = (label) => {
    if (cursor >= raw.length) throw new Error(`truncated_${label}`);
    return raw[cursor++];
  };
  const takeCount = (label) => {
    const value = take(label);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`oversized_${label}`);
    return Number(value);
  };
  const takeFields = (count, label) => {
    if (cursor + count > raw.length) throw new Error(`truncated_${label}`);
    const fields = raw.slice(cursor, cursor + count);
    cursor += count;
    return fields;
  };

  const count = takeCount("server_action_count");
  if (count === 0 || count > 256) throw new Error("invalid_server_action_count");
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const start = cursor;
    const variant = take(`server_action_${index}_variant`);
    let fields;
    if (variant === 0n) {
      const storageAddress = take(`server_action_${index}_storage_address`);
      const length = takeCount(`server_action_${index}_value_length`);
      fields = [storageAddress, BigInt(length), ...takeFields(length, `server_action_${index}_value`)];
    } else if (variant === 1n) {
      fields = takeFields(4, `server_action_${index}_append`);
    } else if (variant === 2n || variant === 3n || variant === 6n) {
      fields = takeFields(3, `server_action_${index}_fixed`);
    } else if (variant === 4n || variant === 7n) {
      fields = takeFields(5, `server_action_${index}_fixed`);
    } else if (variant === 5n) {
      fields = takeFields(6, `server_action_${index}_withdrawal`);
    } else if (variant === 8n) {
      fields = takeFields(2, `server_action_${index}_enc_note`);
    } else if (variant === 9n) {
      fields = takeFields(1, `server_action_${index}_note_used`);
    } else if (variant === 10n || variant === 11n) {
      const target = take(`server_action_${index}_target`);
      const length = takeCount(`server_action_${index}_calldata_length`);
      fields = [target, BigInt(length), ...takeFields(length, `server_action_${index}_calldata`)];
    } else {
      throw new Error(`unknown_server_action_${variant}`);
    }
    actions.push(Object.freeze({ index, variant, fields: Object.freeze(fields), start, end: cursor }));
  }
  const actionsEnd = cursor;
  const suffix = raw.slice(cursor);
  if (suffix.length !== 1 || suffix[0] !== 1n) {
    throw new Error("exit_requires_none_screening_suffix");
  }
  return Object.freeze({
    raw: Object.freeze(raw),
    actions: Object.freeze(actions),
    actionsEnd,
    serializedActions: Object.freeze(raw.slice(0, actionsEnd)),
    screeningSuffix: Object.freeze(suffix),
  });
}

function normalizePreparedCall(call) {
  if (typeof call !== "object" || call === null) throw new Error("missing_prepared_call");
  const targets = [call.contractAddress, call.contract_address]
    .filter((item) => item !== undefined)
    .map((item) => normalizeHex(item, "prepared_call_target"));
  if (targets.length === 0 || targets.some((item) => item !== targets[0])) {
    throw new Error("prepared_call_target_conflict");
  }
  const entrypoints = [call.entrypoint, call.entry_point]
    .filter((item) => item !== undefined);
  if (
    entrypoints.length === 0 ||
    entrypoints.some((item) => typeof item !== "string" || item !== entrypoints[0])
  ) {
    throw new Error("prepared_call_entrypoint_conflict");
  }
  return Object.freeze({
    contractAddress: targets[0],
    entrypoint: entrypoints[0],
    calldata: Object.freeze(feltArray(call.calldata, "prepared_call_calldata")),
  });
}

export function buildExitLocks(input) {
  if (typeof input !== "object" || input === null) throw new Error("missing_exit_package");
  const call = input.prepared?.call;
  const proof = input.prepared?.proof;
  if (typeof proof !== "object" || proof === null) throw new Error("missing_prepared_proof");
  const proofBytes = decodeCanonicalProofData(proof.data);
  const { locks: _ignored, ...bound } = input;
  return Object.freeze({
    callSha256: hashCanonical(call),
    proofDataSha256: sha256Bytes(proofBytes),
    proofOutputSha256: hashCanonical(proof.output),
    proofFactsSha256: hashCanonical(proof.proof_facts),
    bindingSha256: hashCanonical(bound),
  });
}

export function validatePolicy(policy) {
  if (policy?.schema !== "afterlight-neutral-exit-policy/1") throw new Error("bad_policy_schema");
  const exactHex = (field, expected) => {
    if (normalizeHex(policy[field], field) !== normalizeHex(expected)) throw new Error(`wrong_${field}`);
  };
  exactHex("chainId", MAINNET_CHAIN_ID);
  exactHex("neutralAddress", LOCKED_NEUTRAL_ADDRESS);
  exactHex("neutralPublicKey", LOCKED_NEUTRAL_PUBLIC_KEY);
  exactHex("afterlightAddress", LOCKED_AFTERLIGHT_ADDRESS);
  exactHex("poolAddress", LOCKED_POOL_ADDRESS);
  exactHex("poolFeeCollector", LOCKED_POOL_FEE_COLLECTOR);
  exactHex("tokenAddress", LOCKED_TOKEN_ADDRESS);
  exactHex("afterlightClassHash", LOCKED_AFTERLIGHT_CLASS_HASH);
  exactHex("neutralClassHash", LOCKED_NEUTRAL_CLASS_HASH);
  if (strictDecimal(policy.fixedAmountFri, "fixed_amount") !== LOCKED_AMOUNT_FRI) {
    throw new Error("wrong_fixed_amount");
  }
  if (strictDecimal(policy.poolFeeEachFri, "pool_fee") !== LOCKED_POOL_FEE_FRI) {
    throw new Error("wrong_pool_fee");
  }
  if (strictDecimal(policy.initialPoolAllowanceFri, "initial_allowance") !== LOCKED_INITIAL_ALLOWANCE_FRI) {
    throw new Error("wrong_initial_allowance");
  }
  if (strictDecimal(policy.maxPoolAllowanceFri, "max_pool_allowance") !== LOCKED_MAX_POOL_ALLOWANCE_FRI) {
    throw new Error("wrong_max_pool_allowance");
  }
  if (strictDecimal(policy.postSpendHealthFloorFri, "health_floor") < LOCKED_HEALTH_FLOOR_FRI) {
    throw new Error("health_floor_too_low");
  }
  const networkCapFri = strictDecimal(policy.maxNetworkFeePerExitFri, "network_cap");
  if (networkCapFri <= 0n || networkCapFri > ABSOLUTE_NETWORK_CAP_PER_EXIT_FRI) {
    throw new Error("network_cap_out_of_range");
  }
  const amountMarginBps = strictDecimal(policy.amountMarginBps, "amount_margin_bps");
  const priceMarginBps = strictDecimal(policy.priceMarginBps, "price_margin_bps");
  if (
    amountMarginBps < 10_000n || amountMarginBps > 12_500n ||
    priceMarginBps < 10_000n || priceMarginBps > 12_500n
  ) {
    throw new Error("margin_out_of_range");
  }
  if (strictDecimal(policy.maxEstimateAgeBlocks, "max_estimate_age") !== MAX_ESTIMATE_AGE_BLOCKS) {
    throw new Error("wrong_max_estimate_age");
  }
  if (policy.minimumRpcSpec !== MINIMUM_RPC_SPEC) throw new Error("wrong_minimum_rpc_spec");
  if (policy.starknetJsVersion !== STARKNETJS_VERSION) throw new Error("wrong_starknetjs_version");
  if (policy.starknetJsPackageSha256 !== STARKNETJS_PACKAGE_SHA256) {
    throw new Error("wrong_starknetjs_package_hash");
  }
  if (policy.starknetJsModuleSha256 !== STARKNETJS_MODULE_SHA256) {
    throw new Error("wrong_starknetjs_module_hash");
  }
  return Object.freeze({ policy, networkCapFri, amountMarginBps, priceMarginBps });
}

export function validatePreparedExitPackage(input, policy, options = {}) {
  validatePolicy(policy);
  const hasSetup = input?.schema === "afterlight-prepared-neutral-exit/2";
  if (!hasSetup && input?.schema !== "afterlight-prepared-neutral-exit/1") throw new Error("bad_exit_schema");
  if (hasSetup && options.allowSetup !== true) throw new Error("first_use_setup_disabled");
  if (!hasSetup && (input.setupPolicy !== undefined || input.setupAuthorization !== undefined)) {
    throw new Error("setup_requires_versioned_exit");
  }
  let setupAuthorization;
  if (hasSetup) {
    if (input.setupPolicy !== ROLE_BOUND_SETUP_POLICY) throw new Error("wrong_setup_policy");
    const auth = input.setupAuthorization;
    if (
      typeof auth !== "object" || auth === null || Array.isArray(auth) ||
      Object.keys(auth).sort().join(",") !== "schema,sig_r,sig_s" ||
      auth.schema !== SETUP_AUTHORIZATION_SCHEMA
    ) throw new Error("invalid_setup_authorization");
    const sigR = normalizeFelt(auth.sig_r, "setup_signature_r");
    const sigS = normalizeFelt(auth.sig_s, "setup_signature_s");
    if (BigInt(sigR) === 0n || BigInt(sigS) === 0n) throw new Error("zero_setup_signature");
    const { locks: _locks, setupAuthorization: _auth, ...unsigned } = input;
    setupAuthorization = Object.freeze({
      messageHash: setupAuthorizationHash(hashCanonical(unsigned)), sigR, sigS,
    });
  }
  if (input.evidence !== "APPLICATION_AUTHORIZED_OUTER_UNSIGNED_NOT_SUBMITTED") {
    throw new Error("bad_exit_evidence_class");
  }
  const actionPolicy = ACTION_POLICY[input.action];
  if (!actionPolicy) throw new Error("unsupported_exit_action");
  const exactAddress = (field, expected) => {
    if (normalizeHex(input[field], field) !== normalizeHex(expected)) throw new Error(`wrong_${field}`);
  };
  exactAddress("chainId", MAINNET_CHAIN_ID);
  exactAddress("neutralAddress", LOCKED_NEUTRAL_ADDRESS);
  exactAddress("afterlightAddress", LOCKED_AFTERLIGHT_ADDRESS);
  exactAddress("poolAddress", LOCKED_POOL_ADDRESS);
  exactAddress("tokenAddress", LOCKED_TOKEN_ADDRESS);
  if (strictDecimal(input.amountFri, "amount") !== LOCKED_AMOUNT_FRI) throw new Error("wrong_amount");
  const metadata = Object.freeze({
    vaultId: normalizeFelt(input.vaultId, "vault_id"),
    expectedState: normalizeFelt(input.expectedState, "expected_state"),
    expectedEpoch: normalizeFelt(input.expectedEpoch, "expected_epoch"),
    expectedRoleNonce: normalizeFelt(input.expectedRoleNonce, "expected_role_nonce"),
    destinationNoteId: normalizeFelt(input.destinationNoteId, "destination_note_id"),
    validUntil: normalizeFelt(input.validUntil, "valid_until"),
    preparedAtBlock: strictDecimal(input.preparedAtBlock, "prepared_at_block"),
  });
  if (BigInt(metadata.vaultId) === 0n || BigInt(metadata.destinationNoteId) === 0n) {
    throw new Error("zero_vault_or_note");
  }
  if (BigInt(metadata.expectedState) !== actionPolicy.requiredState) {
    throw new Error("wrong_expected_state_for_action");
  }
  if (
    BigInt(metadata.expectedEpoch) > U64_MAX ||
    BigInt(metadata.expectedRoleNonce) > U64_MAX ||
    BigInt(metadata.validUntil) > U64_MAX ||
    metadata.preparedAtBlock > U64_MAX
  ) {
    throw new Error("exit_u64_out_of_range");
  }
  if (metadata.preparedAtBlock === 0n) throw new Error("zero_prepared_block");

  const call = normalizePreparedCall(input.prepared?.call);
  if (call.contractAddress !== normalizeHex(LOCKED_POOL_ADDRESS)) throw new Error("wrong_pool_call");
  if (call.entrypoint !== "apply_actions") throw new Error("wrong_pool_entrypoint");
  const parsed = parseServerActions(call.calldata);
  const exactVariants = hasSetup ? [0n, 0n, 0n, 7n, 10n] : [0n, 7n, 10n];
  if (
    parsed.actions.length !== exactVariants.length ||
    parsed.actions.some((item, index) => item.variant !== exactVariants[index])
  ) throw new Error("exit_requires_exact_write_note_invoke_shape");
  const writes = parsed.actions.filter((item) => item.variant === 0n);
  const notes = parsed.actions.filter((item) => item.variant === 7n);
  const invokes = parsed.actions.filter((item) => item.variant === 10n);
  if (writes.length !== (hasSetup ? 3 : 1) || notes.length !== 1 || invokes.length !== 1) throw new Error("exit_action_cardinality");
  const setupStorageSlots = [];
  if (hasSetup) {
    if (writes[0].fields.length !== 4 || writes[0].fields[1] !== 2n || writes[0].fields[2] === 0n) {
      throw new Error("setup_requires_two_felts_nonzero_salt");
    }
    if (writes[1].fields.length !== 3 || writes[1].fields[1] !== 1n || writes[1].fields[2] !== 1n) {
      throw new Error("setup_requires_boolean_true");
    }
    const occupied = new Set();
    for (const [index, write] of writes.entries()) {
      const base = write.fields[0];
      // The protocol bounds StorageBaseAddress, then permits small field
      // offsets; a two-felt write at ADDR_BOUND - 1 is valid.
      if (base === 0n || base >= constants.ADDR_BOUND) throw new Error("setup_storage_out_of_range");
      for (let offset = 0n; offset < write.fields[1]; offset += 1n) {
        const slot = base + offset;
        if (occupied.has(slot)) throw new Error("setup_storage_overlap");
        if (index < 2 && POOL_SINGLETON_STORAGE.includes(slot)) throw new Error("setup_configuration_storage");
        occupied.add(slot);
        if (index < 2) setupStorageSlots.push(slot);
      }
    }
  }
  const note = notes[0];
  if (
    normalizeHex(`0x${note.fields[3].toString(16)}`) !== normalizeHex(LOCKED_TOKEN_ADDRESS) ||
    note.fields[4].toString() !== metadata.destinationNoteId
  ) {
    throw new Error("open_note_token_or_id_mismatch");
  }
  const write = writes.at(-1);
  const noteId = BigInt(metadata.destinationNoteId);
  const expectedStorageAddress = BigInt(
    hash.computePedersenHash(hash.starknetKeccak("notes"), noteId),
  ) % constants.ADDR_BOUND;
  if (
    write.fields.length !== 4 ||
    write.fields[0] !== expectedStorageAddress ||
    write.fields[1] !== 2n ||
    write.fields[2] !== OPEN_NOTE_PACKED_VALUE ||
    normalizeHex(`0x${write.fields[3].toString(16)}`) !== normalizeHex(LOCKED_TOKEN_ADDRESS)
  ) throw new Error("wrong_open_note_write_once");
  const invoke = invokes[0];
  if (note.index >= invoke.index) throw new Error("open_note_must_precede_invoke");
  if (normalizeHex(`0x${invoke.fields[0].toString(16)}`) !== normalizeHex(LOCKED_AFTERLIGHT_ADDRESS)) {
    throw new Error("wrong_afterlight_invoke_target");
  }
  const invokeWidth = Number(invoke.fields[1]);
  const exitCalldata = invoke.fields.slice(2);
  if (invokeWidth !== 11 || exitCalldata.length !== 11) throw new Error("wrong_exit_calldata_width");
  const expected = [
    actionPolicy.discriminant,
    BigInt(metadata.vaultId),
    BigInt(LOCKED_TOKEN_ADDRESS),
    LOCKED_AMOUNT_FRI,
    actionPolicy.requiredState,
    BigInt(metadata.expectedEpoch),
    BigInt(metadata.expectedRoleNonce),
    BigInt(metadata.destinationNoteId),
    BigInt(metadata.validUntil),
  ];
  for (let index = 0; index < expected.length; index += 1) {
    if (exitCalldata[index] !== expected[index]) throw new Error(`exit_calldata_mismatch_${index}`);
  }
  if (exitCalldata[9] === 0n || exitCalldata[10] === 0n) throw new Error("zero_application_signature");

  const proof = input.prepared?.proof;
  if (typeof proof !== "object" || proof === null) throw new Error("missing_prepared_proof");
  const proofBytes = decodeCanonicalProofData(proof.data);
  const proofOutput = feltArray(proof.output, "proof_output").map(BigInt);
  if (
    proofOutput.length !== parsed.serializedActions.length + 1 ||
    normalizeHex(`0x${proofOutput[0].toString(16)}`) !== normalizeHex(LOCKED_POOL_CLASS_HASH)
  ) {
    throw new Error("proof_output_shape");
  }
  for (let index = 0; index < parsed.serializedActions.length; index += 1) {
    if (proofOutput[index + 1] !== parsed.serializedActions[index]) {
      throw new Error(`proof_output_action_mismatch_${index}`);
    }
  }
  const proofFacts = parseProofFacts(proof.proof_facts);
  if (hasSetup && BigInt(proofFacts.facts[0]) !== BigInt(PROOF1_HEADER)) {
    throw new Error("setup_requires_real_proof1");
  }
  if (hasSetup) {
    // Program/config metadata (facts[2]/facts[6]) is authenticated by canonical
    // gateway admission, not guessed from SDK/mock-estimator constants. These
    // local checks bind the exact pool output but do not verify raw proof bytes.
    const expectedMessageHash = ec.starkCurve.poseidonHashMany([
      BigInt(LOCKED_POOL_ADDRESS), 0n, BigInt(proofOutput.length), ...proofOutput,
    ]);
    if (
      BigInt(proofFacts.facts[1]) !== BigInt(shortString.encodeShortString("VIRTUAL_SNOS")) ||
      BigInt(proofFacts.facts[3]) !== BigInt(shortString.encodeShortString("VIRTUAL_SNOS0")) ||
      BigInt(proofFacts.facts[5]) === 0n ||
      BigInt(proofFacts.messageHash) !== expectedMessageHash
    ) throw new Error("setup_proof_facts_binding_mismatch");
  }
  if (typeof input.locks !== "object" || input.locks === null) throw new Error("missing_locks");
  const actualLocks = buildExitLocks(input);
  for (const [name, actual] of Object.entries(actualLocks)) {
    if (!SHA256_RE.test(input.locks[name] ?? "") || input.locks[name] !== actual) {
      throw new Error(`lock_mismatch_${name}`);
    }
  }
  return Object.freeze({
    input,
    action: input.action,
    actionPolicy,
    metadata,
    call,
    parsed,
    proof: Object.freeze({
      data: proof.data,
      decodedBytes: proofBytes.length,
      output: Object.freeze(proofOutput),
      facts: proofFacts,
    }),
    bindingSha256: actualLocks.bindingSha256,
    hasSetup,
    setupAuthorization,
    setupStorageSlots: Object.freeze(setupStorageSlots),
    locks: actualLocks,
  });
}

export function parseRpcSpec(value) {
  if (typeof value !== "string") throw new Error("invalid_rpc_spec");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) throw new Error("invalid_rpc_spec");
  const parsed = match.slice(1).map(Number);
  const minimum = MINIMUM_RPC_SPEC.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] > minimum[index]) return Object.freeze({ raw: value, compatible: true });
    if (parsed[index] < minimum[index]) throw new Error("rpc_spec_too_old_for_snip36");
  }
  return Object.freeze({ raw: value, compatible: true });
}

export function parseResourceBounds(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid_resource_bounds");
  const parse = (name) => {
    const item = raw[name];
    if (typeof item !== "object" || item === null) throw new Error(`missing_${name}`);
    const maxAmount = integer(item.max_amount ?? item.maxAmount, `${name}_max_amount`);
    const maxPrice = integer(
      item.max_price_per_unit ?? item.maxPricePerUnit,
      `${name}_max_price_per_unit`,
    );
    if (maxAmount < 0n || maxPrice < 0n) throw new Error(`negative_${name}`);
    return Object.freeze({ max_amount: maxAmount, max_price_per_unit: maxPrice });
  };
  return Object.freeze({ l1_gas: parse("l1_gas"), l1_data_gas: parse("l1_data_gas"), l2_gas: parse("l2_gas") });
}

export function resourceCapFri(bounds) {
  const parsed = parseResourceBounds(bounds);
  return [parsed.l1_gas, parsed.l1_data_gas, parsed.l2_gas]
    .reduce((sum, item) => sum + item.max_amount * item.max_price_per_unit, 0n);
}

export function addResourceMargins(bounds, amountMarginBps, priceMarginBps) {
  const parsed = parseResourceBounds(bounds);
  const amountBps = integer(amountMarginBps, "amount_margin_bps");
  const priceBps = integer(priceMarginBps, "price_margin_bps");
  if (
    amountBps < 10_000n || amountBps > 12_500n ||
    priceBps < 10_000n || priceBps > 12_500n
  ) {
    throw new Error("margin_out_of_range");
  }
  const ceil = (value, bps) => (value * bps + 9_999n) / 10_000n;
  const apply = (item) => Object.freeze({
    max_amount: ceil(item.max_amount, amountBps),
    max_price_per_unit: ceil(item.max_price_per_unit, priceBps),
  });
  return Object.freeze({ l1_gas: apply(parsed.l1_gas), l1_data_gas: apply(parsed.l1_data_gas), l2_gas: apply(parsed.l2_gas) });
}

export function serializeResourceBounds(bounds) {
  const parsed = parseResourceBounds(bounds);
  const item = (value) => ({
    max_amount: value.max_amount.toString(),
    max_price_per_unit: value.max_price_per_unit.toString(),
  });
  return { l1_gas: item(parsed.l1_gas), l1_data_gas: item(parsed.l1_data_gas), l2_gas: item(parsed.l2_gas) };
}

export function assertFreshEstimate(estimateBlock, liveBlock, maxAge = MAX_ESTIMATE_AGE_BLOCKS) {
  const estimated = integer(estimateBlock, "estimate_block");
  const live = integer(liveBlock, "live_block");
  const limit = integer(maxAge, "max_age");
  if (estimated > live || live - estimated > limit) throw new Error("estimate_stale");
  return live - estimated;
}

export function assertProofFreshness(baseBlock, liveBlock, validityBlocks) {
  const base = integer(baseBlock, "proof_base_block");
  const live = integer(liveBlock, "live_block");
  const validity = integer(validityBlocks, "proof_validity_blocks");
  if (validity === 0n || base >= live || live > base + validity) throw new Error("proof_not_live");
  return base + validity - live;
}

export function parseU256Result(result, label = "u256") {
  const values = feltArray(result, label).map(BigInt);
  if (values.length !== 2) throw new Error(`wrong_${label}_width`);
  if (values[0] >= 2n ** 128n || values[1] >= 2n ** 128n) throw new Error(`${label}_limb_out_of_range`);
  return values[0] + (values[1] << 128n);
}

export function parseVaultResult(result) {
  const values = feltArray(result, "vault_result").map(BigInt);
  if (values.length !== 15) throw new Error("wrong_vault_width");
  return Object.freeze({
    exists: values[0], state: values[1], mode: values[2], ownerKey: values[3],
    successorKey: values[4], token: values[5], amount: values[6],
    inactivitySeconds: values[7], graceSeconds: values[8], lastHeartbeat: values[9],
    requestedAt: values[10], claimAfter: values[11], epoch: values[12],
    ownerNonce: values[13], successorNonce: values[14], raw: Object.freeze(values),
  });
}

export function validateLiveExitState(validated, vault, blockTimestamp) {
  const parsed = vault.raw ? vault : parseVaultResult(vault);
  if (parsed.exists !== 1n || parsed.state !== validated.actionPolicy.requiredState) {
    throw new Error("vault_wrong_live_state");
  }
  if (parsed.token !== BigInt(LOCKED_TOKEN_ADDRESS) || parsed.amount !== LOCKED_AMOUNT_FRI) {
    throw new Error("vault_token_or_amount_drift");
  }
  if (parsed.epoch !== BigInt(validated.metadata.expectedEpoch)) throw new Error("vault_epoch_drift");
  const liveRoleNonce = validated.action === "CANCEL_REFUND" ? parsed.ownerNonce : parsed.successorNonce;
  if (liveRoleNonce !== BigInt(validated.metadata.expectedRoleNonce)) throw new Error("vault_role_nonce_drift");
  const timestamp = integer(blockTimestamp, "block_timestamp");
  if (timestamp > BigInt(validated.metadata.validUntil)) throw new Error("application_authorization_expired");
  if (validated.action === "CLAIM" && timestamp < parsed.claimAfter) throw new Error("claim_too_early");
  if (validated.hasSetup) {
    const authorization = validated.setupAuthorization;
    const publicKey = validated.action === "CLAIM" ? parsed.successorKey : parsed.ownerKey;
    let valid = false;
    try {
      const signature = new ec.starkCurve.Signature(BigInt(authorization.sigR), BigInt(authorization.sigS));
      const x = publicKey.toString(16).padStart(64, "0");
      valid = ["02", "03"].some((prefix) => {
        try { return ec.starkCurve.verify(signature, authorization.messageHash, `${prefix}${x}`); }
        catch { return false; }
      });
    } catch { /* Invalid curve scalars must fail closed before sponsorship. */ }
    if (!valid) throw new Error("setup_role_authorization_invalid");
  }
  return parsed;
}

export function validateAuthorizationInclusionWindow(
  validUntil,
  blockTimestamp,
  wallClockTimestamp,
  minimumBuffer = MIN_AUTH_INCLUSION_BUFFER_SECONDS,
) {
  const deadline = integer(validUntil, "valid_until");
  const blockTime = integer(blockTimestamp, "block_timestamp");
  const wallTime = integer(wallClockTimestamp, "wall_clock_timestamp");
  const buffer = integer(minimumBuffer, "minimum_auth_inclusion_buffer");
  const reference = blockTime > wallTime ? blockTime : wallTime;
  if (deadline < reference + buffer) throw new Error("application_authorization_inclusion_window_too_short");
  return deadline - reference;
}

export function validateAllowanceForAction(action, allowance, maximum = LOCKED_MAX_POOL_ALLOWANCE_FRI) {
  const actionPolicy = ACTION_POLICY[action];
  if (!actionPolicy) throw new Error("unsupported_exit_action");
  const actual = integer(allowance, "allowance");
  const cap = integer(maximum, "maximum_allowance");
  if (
    actual < LOCKED_POOL_FEE_FRI ||
    actual > cap ||
    actual % LOCKED_POOL_FEE_FRI !== 0n
  ) throw new Error("wrong_bounded_pool_allowance");
  return actual - LOCKED_POOL_FEE_FRI;
}

export function validateBalanceForExit(balance, resourceCap, healthFloor = LOCKED_HEALTH_FLOOR_FRI) {
  const actual = integer(balance, "balance");
  const cap = integer(resourceCap, "resource_cap");
  const floor = integer(healthFloor, "health_floor");
  const required = LOCKED_POOL_FEE_FRI + cap + floor;
  if (actual < required) throw new Error("neutral_balance_below_exit_reservation");
  return Object.freeze({ balance: actual, required, headroom: actual - required });
}

function daMode(value, label) {
  if (value === "L1" || value === 0 || value === "0x0") return 0;
  if (value === "L2" || value === 1 || value === "0x1") return 1;
  throw new Error(`invalid_${label}`);
}

export function buildSignedInvokeHashInput(signed) {
  if (typeof signed !== "object" || signed === null) throw new Error("missing_signed_transaction");
  return {
    senderAddress: normalizeHex(signed.sender_address, "signed_sender"),
    version: normalizeHex(signed.version, "signed_version"),
    compiledCalldata: feltArray(signed.calldata, "signed_calldata"),
    chainId: MAINNET_CHAIN_ID,
    nonce: integer(signed.nonce, "signed_nonce"),
    accountDeploymentData: feltArray(signed.account_deployment_data ?? [], "account_deployment_data"),
    nonceDataAvailabilityMode: daMode(signed.nonce_data_availability_mode, "nonce_da_mode"),
    feeDataAvailabilityMode: daMode(signed.fee_data_availability_mode, "fee_da_mode"),
    resourceBounds: parseResourceBounds(signed.resource_bounds),
    tip: integer(signed.tip ?? 0, "tip"),
    paymasterData: feltArray(signed.paymaster_data ?? [], "paymaster_data"),
    proofFacts: feltArray(signed.proof_facts ?? [], "proof_facts"),
  };
}

export function assertOuterSignatureMatchesHash(signed, publicKey = LOCKED_NEUTRAL_PUBLIC_KEY) {
  if (!Array.isArray(signed?.signature) || signed.signature.length !== 2) {
    throw new Error("invalid_outer_signature_shape");
  }
  const messageHash = hash.calculateInvokeTransactionHash(buildSignedInvokeHashInput(signed));
  const signature = new ec.starkCurve.Signature(
    BigInt(signed.signature[0]),
    BigInt(signed.signature[1]),
  );
  const x = BigInt(publicKey).toString(16).padStart(64, "0");
  const valid = ["02", "03"].some((prefix) => {
    try {
      return ec.starkCurve.verify(signature, messageHash, `${prefix}${x}`);
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error("outer_signature_hash_mismatch");
  return normalizeHex(messageHash);
}

export function assertSignedExitTransaction(signed, expected) {
  if (normalizeHex(signed.sender_address) !== normalizeHex(LOCKED_NEUTRAL_ADDRESS)) {
    throw new Error("signed_sender_mismatch");
  }
  if (normalizeHex(signed.version) !== "0x3") throw new Error("signed_not_v3");
  if (integer(signed.nonce, "signed_nonce") !== integer(expected.nonce, "expected_nonce")) {
    throw new Error("signed_nonce_mismatch");
  }
  if (!sameFelts(signed.calldata, expected.executeCalldata)) throw new Error("signed_calldata_mismatch");
  if (!sameFelts(signed.proof_facts, expected.proofFacts)) throw new Error("signed_proof_facts_mismatch");
  if (signed.proof !== expected.proof) throw new Error("signed_proof_mismatch");
  if ((signed.signature ?? []).length === 0) throw new Error("missing_account_signature");
  if ((signed.account_deployment_data ?? []).length !== 0 || (signed.paymaster_data ?? []).length !== 0) {
    throw new Error("unexpected_paymaster_or_deployment_data");
  }
  if (integer(signed.tip ?? 0, "tip") !== 0n) throw new Error("nonzero_tip");
  if (daMode(signed.nonce_data_availability_mode, "nonce_da_mode") !== 0 || daMode(signed.fee_data_availability_mode, "fee_da_mode") !== 0) {
    throw new Error("non_l1_data_availability");
  }
  const actualBounds = serializeResourceBounds(signed.resource_bounds);
  const expectedBounds = serializeResourceBounds(expected.resourceBounds);
  if (canonicalJson(actualBounds) !== canonicalJson(expectedBounds)) throw new Error("signed_bounds_mismatch");
  if (resourceCapFri(actualBounds) > expected.networkCapFri) throw new Error("signed_network_cap_exceeded");
  return true;
}

export function makeEmptyLedger() {
  return {
    schema: "afterlight-neutral-exit-ledger/1",
    slots: {
      CANCEL_REFUND: { state: "UNUSED" },
      CLAIM: { state: "UNUSED" },
    },
  };
}

export function reserveLedgerSlot(ledger, action, bindingSha256, at) {
  if (ledger?.schema !== "afterlight-neutral-exit-ledger/1") throw new Error("bad_ledger_schema");
  if (!ACTION_POLICY[action]) throw new Error("unsupported_exit_action");
  const prior = ledger.slots?.[action];
  if (!["UNUSED", "RECONCILED_FAILED"].includes(prior?.state)) {
    throw new Error("exit_slot_already_consumed");
  }
  if (!SHA256_RE.test(bindingSha256)) throw new Error("bad_binding_hash");
  return {
    ...ledger,
    slots: {
      ...ledger.slots,
      [action]: {
        state: "RESERVED",
        bindingSha256,
        reservedAt: at,
        ...(prior.state === "RECONCILED_FAILED"
          ? { history: [...(prior.history ?? []), { ...prior, history: undefined }] }
          : {}),
      },
    },
  };
}

export function markLedgerSigned(ledger, action, signedArtifactSha256, expectedTransactionHash, at) {
  const slot = ledger?.slots?.[action];
  if (slot?.state !== "RESERVED") throw new Error("slot_not_reserved");
  if (!SHA256_RE.test(signedArtifactSha256)) throw new Error("bad_signed_artifact_hash");
  return {
    ...ledger,
    slots: {
      ...ledger.slots,
      [action]: {
        ...slot,
        state: "SIGNED",
        signedArtifactSha256,
        expectedTransactionHash: normalizeHex(expectedTransactionHash),
        signedAt: at,
      },
    },
  };
}

export function markBroadcastAttempt(ledger, action, expectedTransactionHash, snapshotSha256, at) {
  const slot = ledger?.slots?.[action];
  if (slot?.state !== "SIGNED") throw new Error("slot_not_signed_or_already_attempted");
  if (normalizeHex(slot.expectedTransactionHash) !== normalizeHex(expectedTransactionHash)) {
    throw new Error("broadcast_hash_mismatch");
  }
  if (!SHA256_RE.test(snapshotSha256)) throw new Error("bad_snapshot_hash");
  return {
    ...ledger,
    slots: {
      ...ledger.slots,
      [action]: { ...slot, state: "BROADCAST_ATTEMPTED", snapshotSha256, attemptedAt: at },
    },
  };
}

export function markBroadcastResult(ledger, action, state, at, detail = {}) {
  const allowed = new Set(["SUBMITTED", "BROADCAST_UNKNOWN", "HASH_MISMATCH", "RECONCILED_SUCCEEDED", "RECONCILED_FAILED"]);
  if (!allowed.has(state)) throw new Error("invalid_broadcast_state");
  const current = ledger?.slots?.[action]?.state;
  const reconciliation = state.startsWith("RECONCILED_");
  if ((!reconciliation && current !== "BROADCAST_ATTEMPTED") || (reconciliation && !["SUBMITTED", "BROADCAST_UNKNOWN", "HASH_MISMATCH"].includes(current))) {
    throw new Error("invalid_broadcast_transition");
  }
  return {
    ...ledger,
    slots: {
      ...ledger.slots,
      [action]: { ...ledger.slots[action], ...detail, state, updatedAt: at },
    },
  };
}

export function expectedBroadcastAcknowledgement(action, transactionHash) {
  if (!ACTION_POLICY[action]) throw new Error("unsupported_exit_action");
  return `BROADCAST_ONCE_${action}_${normalizeHex(transactionHash)}`;
}

export function verifyReceiptEvidence(input) {
  const { validated, signedArtifact, transaction, receipt, before, after } = input;
  const expectedHash = normalizeHex(signedArtifact.expectedTransactionHash);
  if (normalizeHex(receipt.transaction_hash) !== expectedHash) throw new Error("receipt_hash_mismatch");
  if (transaction.transaction_hash !== undefined && normalizeHex(transaction.transaction_hash) !== expectedHash) {
    throw new Error("transaction_hash_mismatch");
  }
  if (normalizeHex(transaction.sender_address) !== normalizeHex(LOCKED_NEUTRAL_ADDRESS)) {
    throw new Error("receipt_sender_mismatch");
  }
  if (normalizeHex(transaction.version) !== "0x3") throw new Error("receipt_not_v3");
  if (!sameFelts(transaction.calldata, signedArtifact.signedTransaction.calldata)) {
    throw new Error("receipt_calldata_mismatch");
  }
  if (!sameFelts(transaction.proof_facts, signedArtifact.signedTransaction.proof_facts)) {
    throw new Error("receipt_proof_facts_mismatch");
  }
  if (receipt.execution_status !== "SUCCEEDED") throw new Error("exit_receipt_not_succeeded");
  if (!String(receipt.finality_status ?? "").startsWith("ACCEPTED_ON_")) {
    throw new Error("exit_receipt_not_accepted");
  }
  const actualFee = typeof receipt.actual_fee === "string"
    ? BigInt(receipt.actual_fee)
    : BigInt(receipt.actual_fee?.amount ?? -1);
  if (receipt.actual_fee?.unit !== undefined && receipt.actual_fee.unit !== "FRI") {
    throw new Error("actual_fee_not_fri");
  }
  if (actualFee < 0n || actualFee > BigInt(signedArtifact.networkFeeCapFri)) {
    throw new Error("actual_fee_outside_cap");
  }
  const coerceVault = (value) => {
    if (
      value &&
      Array.isArray(value.raw) &&
      typeof value.state === "bigint" &&
      typeof value.epoch === "bigint"
    ) {
      return value;
    }
    const raw = Array.isArray(value?.raw) ? value.raw : value;
    if (!Array.isArray(raw)) throw new Error("invalid_reconciliation_vault");
    return parseVaultResult(raw.map((item, index) => integer(item, `reconciliation_vault_${index}`).toString()));
  };
  const beforeVault = coerceVault(before.vault);
  const afterVault = coerceVault(after.vault);
  if (beforeVault.state !== validated.actionPolicy.requiredState || afterVault.state !== validated.actionPolicy.finalState) {
    throw new Error("vault_final_state_mismatch");
  }
  if (beforeVault.epoch !== afterVault.epoch || beforeVault.epoch !== BigInt(validated.metadata.expectedEpoch)) {
    throw new Error("vault_epoch_changed");
  }
  const roleIndex = validated.actionPolicy.roleNonceIndex;
  if (afterVault.raw[roleIndex] !== beforeVault.raw[roleIndex] + 1n) {
    throw new Error("role_nonce_not_incremented_once");
  }
  const otherIndex = roleIndex === 13 ? 14 : 13;
  if (afterVault.raw[otherIndex] !== beforeVault.raw[otherIndex]) throw new Error("other_role_nonce_changed");
  if (BigInt(before.lockedLiabilityFri) - BigInt(after.lockedLiabilityFri) !== LOCKED_AMOUNT_FRI) {
    throw new Error("liability_delta_mismatch");
  }
  const expectedAllowanceAfter = validateAllowanceForAction(validated.action, BigInt(before.allowanceFri));
  if (BigInt(after.allowanceFri) !== expectedAllowanceAfter) {
    throw new Error("allowance_delta_mismatch");
  }
  if (
    BigInt(before.poolFeeFri) !== LOCKED_POOL_FEE_FRI ||
    BigInt(after.poolFeeFri) !== LOCKED_POOL_FEE_FRI
  ) {
    throw new Error("pool_fee_reconciliation_mismatch");
  }
  if (
    normalizeHex(before.poolFeeCollector) !== normalizeHex(LOCKED_POOL_FEE_COLLECTOR) ||
    normalizeHex(after.poolFeeCollector) !== normalizeHex(LOCKED_POOL_FEE_COLLECTOR)
  ) {
    throw new Error("pool_fee_collector_reconciliation_mismatch");
  }
  const expectedBalanceDelta = LOCKED_POOL_FEE_FRI + actualFee;
  if (BigInt(before.neutralBalanceFri) - BigInt(after.neutralBalanceFri) !== expectedBalanceDelta) {
    throw new Error("neutral_balance_delta_mismatch");
  }
  if (BigInt(after.neutralNonce) !== BigInt(before.neutralNonce) + 1n) throw new Error("neutral_nonce_delta_mismatch");

  const events = Array.isArray(receipt.events) ? receipt.events : [];
  const exactEvent = (event, emitter, keys, data) =>
    normalizeHex(event.from_address) === normalizeHex(emitter) &&
    sameFelts(event.keys, keys) &&
    sameFelts(event.data, data);
  if (!events.some((event) => exactEvent(
    event,
    LOCKED_POOL_ADDRESS,
    [OPEN_NOTE_DEPOSITED_SELECTOR, LOCKED_AFTERLIGHT_ADDRESS, LOCKED_TOKEN_ADDRESS, validated.metadata.destinationNoteId],
    [LOCKED_AMOUNT_FRI.toString()],
  ))) {
    throw new Error("pool_event_missing_exact_note_deposit");
  }
  if (!events.some((event) => exactEvent(
    event,
    LOCKED_AFTERLIGHT_ADDRESS,
    [validated.actionPolicy.eventSelector, validated.metadata.vaultId],
    [validated.metadata.expectedEpoch, validated.metadata.destinationNoteId, LOCKED_AMOUNT_FRI.toString()],
  ))) {
    throw new Error("afterlight_event_missing_exact_exit");
  }
  return Object.freeze({
    action: validated.action,
    transactionHash: expectedHash,
    sender: normalizeHex(LOCKED_NEUTRAL_ADDRESS),
    destinationNoteId: validated.metadata.destinationNoteId,
    actualNetworkFeeFri: actualFee.toString(),
    poolFeeFri: LOCKED_POOL_FEE_FRI.toString(),
    poolFeeCollector: normalizeHex(LOCKED_POOL_FEE_COLLECTOR),
    finalState: validated.actionPolicy.finalState.toString(),
    liabilityDeltaFri: LOCKED_AMOUNT_FRI.toString(),
  });
}

export function verifyEmptyProofFactsTransportRevert(input) {
  const { validated, signedArtifact, transaction, receipt, before, after } = input;
  const expectedHash = normalizeHex(signedArtifact.expectedTransactionHash);
  if (normalizeHex(receipt.transaction_hash) !== expectedHash) throw new Error("receipt_hash_mismatch");
  if (transaction.transaction_hash !== undefined && normalizeHex(transaction.transaction_hash) !== expectedHash) {
    throw new Error("transaction_hash_mismatch");
  }
  if (normalizeHex(transaction.sender_address) !== normalizeHex(LOCKED_NEUTRAL_ADDRESS)) throw new Error("receipt_sender_mismatch");
  if (normalizeHex(transaction.version) !== "0x3") throw new Error("receipt_not_v3");
  if (!sameFelts(transaction.calldata, signedArtifact.signedTransaction.calldata)) throw new Error("receipt_calldata_mismatch");
  if (Array.isArray(transaction.proof_facts) && transaction.proof_facts.length !== 0) {
    throw new Error("transport_revert_transaction_contains_proof_facts");
  }
  if (receipt.execution_status !== "REVERTED") throw new Error("transport_revert_not_reverted");
  if (!String(receipt.finality_status ?? "").startsWith("ACCEPTED_ON_")) throw new Error("transport_revert_not_accepted");
  if (!/EMPTY_PROOF_FACTS/.test(String(receipt.revert_reason ?? ""))) throw new Error("transport_revert_wrong_reason");
  const actualFee = typeof receipt.actual_fee === "string" ? BigInt(receipt.actual_fee) : BigInt(receipt.actual_fee?.amount ?? -1);
  if (receipt.actual_fee?.unit !== undefined && receipt.actual_fee.unit !== "FRI") throw new Error("actual_fee_not_fri");
  if (actualFee < 0n || actualFee > BigInt(signedArtifact.networkFeeCapFri)) throw new Error("actual_fee_outside_cap");
  const beforeVault = Array.isArray(before.vault?.raw) ? before.vault.raw : before.vault;
  const afterVault = Array.isArray(after.vault?.raw) ? after.vault.raw : after.vault;
  if (
    !Array.isArray(beforeVault) ||
    !Array.isArray(afterVault) ||
    !sameFelts(beforeVault.map(String), afterVault.map(String))
  ) {
    throw new Error("transport_revert_vault_changed");
  }
  if (BigInt(before.lockedLiabilityFri) !== BigInt(after.lockedLiabilityFri)) throw new Error("transport_revert_liability_changed");
  if (BigInt(before.allowanceFri) !== BigInt(after.allowanceFri)) throw new Error("transport_revert_allowance_changed");
  if (BigInt(before.poolFeeFri) !== BigInt(after.poolFeeFri)) throw new Error("transport_revert_pool_fee_changed");
  if (normalizeHex(before.poolFeeCollector) !== normalizeHex(after.poolFeeCollector)) throw new Error("transport_revert_fee_collector_changed");
  if (BigInt(after.neutralNonce) !== BigInt(before.neutralNonce) + 1n) throw new Error("transport_revert_nonce_delta_mismatch");
  if (BigInt(before.neutralBalanceFri) - BigInt(after.neutralBalanceFri) !== actualFee) {
    throw new Error("transport_revert_balance_delta_mismatch");
  }
  return {
    evidence: "ACCEPTED_REVERT_EMPTY_PROOF_FACTS",
    action: validated.action,
    transactionHash: expectedHash,
    actualNetworkFeeFri: actualFee.toString(),
    vaultStateUnchanged: true,
    liabilityUnchanged: true,
    allowanceUnchanged: true,
    neutralNonceConsumed: true,
    replacementArtifactPermitted: true,
  };
}

export function safePublicError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, "[RPC_URL_REDACTED]");
}

export function validateExactSimulationResult(simulations, requireValidation = true) {
  if (!Array.isArray(simulations) || simulations.length !== 1) {
    throw new Error("unexpected_simulation_result_count");
  }
  const simulation = simulations[0];
  const trace = simulation?.transaction_trace;
  if (!trace || trace.type !== "INVOKE" || (requireValidation && !trace.validate_invocation) || !trace.execute_invocation) {
    throw new Error("simulation_missing_validation_or_execution_trace");
  }
  if (trace.revert_reason || trace.execute_invocation?.revert_reason) {
    throw new Error("simulation_reverted");
  }
  return Object.freeze({ validationExecuted: requireValidation, executionExecuted: true });
}

export function actionPolicy(action) {
  const value = ACTION_POLICY[action];
  if (!value) throw new Error("unsupported_exit_action");
  return value;
}
