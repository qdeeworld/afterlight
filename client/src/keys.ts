import { ec } from "starknet";

import { felt, toBigInt, type FeltInput } from "./encoding.js";

export type StarkSignature = Readonly<{ sig_r: string; sig_s: string }>;

export const BACKUP_CONFIRMATION = "EXPORT_AFTERLIGHT_APPLICATION_SECRET" as const;
const BACKUP_FORMAT = "afterlight-stark-key-v1" as const;

type BackupEnvelope = {
  format: typeof BACKUP_FORMAT;
  private_key: string;
};

/**
 * A fresh per-vault application key. The private scalar is held in a native
 * JavaScript private field and can leave this object only through the explicit
 * backup method. Relayer payloads accept signatures, never this object.
 */
export class LocalStarkKey {
  readonly publicKey: string;
  #privateKey: Uint8Array;
  #destroyed = false;

  private constructor(privateKey: Uint8Array) {
    if (!ec.starkCurve.utils.isValidPrivateKey(privateKey)) {
      throw new RangeError("invalid Stark private key");
    }
    this.#privateKey = Uint8Array.from(privateKey);
    this.publicKey = felt(ec.starkCurve.getStarkKey(this.#privateKey), "public key");
  }

  static generate(): LocalStarkKey {
    const generated = ec.starkCurve.utils.randomPrivateKey();
    try {
      return new LocalStarkKey(generated);
    } finally {
      generated.fill(0);
    }
  }

  static restore(serializedBackup: string): LocalStarkKey {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serializedBackup);
    } catch {
      throw new TypeError("invalid Afterlight key backup JSON");
    }
    if (!isBackupEnvelope(parsed)) {
      throw new TypeError("invalid Afterlight key backup envelope");
    }
    const scalar = toBigInt(parsed.private_key, "backup private key");
    const bytes = bigintTo32Bytes(scalar);
    try {
      return new LocalStarkKey(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  sign(messageHash: FeltInput): StarkSignature {
    this.#assertLive();
    const signature = ec.starkCurve.sign(felt(messageHash, "message hash"), this.#privateKey);
    return Object.freeze({
      sig_r: felt(signature.r, "signature r"),
      sig_s: felt(signature.s, "signature s"),
    });
  }

  serializeBackup(confirmation: typeof BACKUP_CONFIRMATION): string {
    this.#assertLive();
    if (confirmation !== BACKUP_CONFIRMATION) {
      throw new Error("explicit application-secret backup confirmation required");
    }
    const envelope: BackupEnvelope = {
      format: BACKUP_FORMAT,
      private_key: `0x${bytesToHex(this.#privateKey)}`,
    };
    return JSON.stringify(envelope);
  }

  destroy(): void {
    this.#privateKey.fill(0);
    this.#destroyed = true;
  }

  /** JSON serialization is deliberately public-only. */
  toJSON(): Readonly<{ public_key: string }> {
    return Object.freeze({ public_key: this.publicKey });
  }

  #assertLive(): void {
    if (this.#destroyed) throw new Error("application key has been destroyed");
  }
}

function isBackupEnvelope(value: unknown): value is BackupEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.format === BACKUP_FORMAT &&
    typeof record.private_key === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(record.private_key)
  );
}

function bigintTo32Bytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
