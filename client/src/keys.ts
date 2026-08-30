import { ec } from "starknet";

import { felt, toBigInt, type FeltInput } from "./encoding.js";

export type StarkSignature = Readonly<{ sig_r: string; sig_s: string }>;

export const BACKUP_CONFIRMATION = "EXPORT_AFTERLIGHT_APPLICATION_SECRET" as const;
const BACKUP_FORMAT = "afterlight-stark-key-v1" as const;
const ENCRYPTED_BACKUP_FORMAT = "afterlight-stark-key-v2" as const;
const BACKUP_KDF = "PBKDF2-SHA256" as const;
const BACKUP_CIPHER = "AES-256-GCM" as const;
const BACKUP_ITERATIONS = 600_000;
const BACKUP_AAD_PREFIX = "afterlight-stark-key-v2";

type BackupEnvelope = {
  format: typeof BACKUP_FORMAT;
  private_key: string;
};

type EncryptedBackupEnvelope = {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  kdf: typeof BACKUP_KDF;
  iterations: typeof BACKUP_ITERATIONS;
  salt: string;
  cipher: typeof BACKUP_CIPHER;
  iv: string;
  public_key: string;
  ciphertext: string;
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

  static async restoreEncrypted(serializedBackup: string, passphrase: string): Promise<LocalStarkKey> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serializedBackup);
    } catch {
      throw new TypeError("invalid Afterlight encrypted backup JSON");
    }
    if (!isEncryptedBackupEnvelope(parsed)) {
      throw new TypeError("invalid Afterlight encrypted backup envelope");
    }
    const password = passphraseBytes(passphrase);
    const salt = decodeBase64(parsed.salt, 16, "salt");
    const iv = decodeBase64(parsed.iv, 12, "iv");
    const ciphertext = decodeBase64(parsed.ciphertext, undefined, "ciphertext");
    try {
      const key = await deriveBackupKey(password, salt, ["decrypt"]);
      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: ownedBuffer(iv),
            additionalData: ownedBuffer(backupAad(parsed.public_key)),
            tagLength: 128,
          },
          key,
          ownedBuffer(ciphertext),
        );
      } catch {
        throw new Error("incorrect backup password or damaged backup");
      }
      const bytes = new Uint8Array(plaintext);
      try {
        if (bytes.length !== 32) throw new Error("invalid decrypted application key");
        const restored = new LocalStarkKey(bytes);
        if (restored.publicKey !== felt(parsed.public_key, "backup public key")) {
          restored.destroy();
          throw new Error("encrypted backup public key mismatch");
        }
        return restored;
      } finally {
        bytes.fill(0);
      }
    } finally {
      password.fill(0);
      salt.fill(0);
      iv.fill(0);
      ciphertext.fill(0);
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

  async serializeEncryptedBackup(
    confirmation: typeof BACKUP_CONFIRMATION,
    passphrase: string,
  ): Promise<string> {
    this.#assertLive();
    if (confirmation !== BACKUP_CONFIRMATION) {
      throw new Error("explicit application-secret backup confirmation required");
    }
    const password = passphraseBytes(passphrase);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    try {
      const key = await deriveBackupKey(password, salt, ["encrypt"]);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: ownedBuffer(iv),
          additionalData: ownedBuffer(backupAad(this.publicKey)),
          tagLength: 128,
        },
        key,
        ownedBuffer(this.#privateKey),
      ));
      try {
        const envelope: EncryptedBackupEnvelope = {
          format: ENCRYPTED_BACKUP_FORMAT,
          kdf: BACKUP_KDF,
          iterations: BACKUP_ITERATIONS,
          salt: encodeBase64(salt),
          cipher: BACKUP_CIPHER,
          iv: encodeBase64(iv),
          public_key: this.publicKey,
          ciphertext: encodeBase64(ciphertext),
        };
        return JSON.stringify(envelope);
      } finally {
        ciphertext.fill(0);
      }
    } finally {
      password.fill(0);
      salt.fill(0);
      iv.fill(0);
    }
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

function isEncryptedBackupEnvelope(value: unknown): value is EncryptedBackupEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 8 &&
    record.format === ENCRYPTED_BACKUP_FORMAT &&
    record.kdf === BACKUP_KDF &&
    record.iterations === BACKUP_ITERATIONS &&
    typeof record.salt === "string" &&
    record.cipher === BACKUP_CIPHER &&
    typeof record.iv === "string" &&
    typeof record.public_key === "string" &&
    /^0x[0-9a-fA-F]{1,64}$/.test(record.public_key) &&
    typeof record.ciphertext === "string"
  );
}

function passphraseBytes(passphrase: string): Uint8Array {
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 256) {
    throw new Error("backup password must contain between 12 and 256 characters");
  }
  const bytes = new TextEncoder().encode(passphrase);
  if (bytes.length < 12 || bytes.length > 1024) {
    bytes.fill(0);
    throw new Error("backup password has an invalid encoded length");
  }
  return bytes;
}

async function deriveBackupKey(
  passphrase: Uint8Array,
  salt: Uint8Array,
  usages: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", ownedBuffer(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: ownedBuffer(salt), iterations: BACKUP_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function backupAad(publicKey: string): Uint8Array {
  return new TextEncoder().encode(`${BACKUP_AAD_PREFIX}:${felt(publicKey, "backup public key")}`);
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string, exactLength: number | undefined, label: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new TypeError(`invalid encrypted backup ${label}`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError(`invalid encrypted backup ${label}`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if ((exactLength !== undefined && bytes.length !== exactLength) || (exactLength === undefined && bytes.length < 48)) {
    bytes.fill(0);
    throw new TypeError(`invalid encrypted backup ${label}`);
  }
  return bytes;
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
