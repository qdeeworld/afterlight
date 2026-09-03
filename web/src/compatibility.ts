import { READY_MIN_VERSION } from "./config.ts";

const READY_WALLET_NAMES = new Set([
  "ready",
  "readyx",
  "readywallet",
  "argentx",
  "argentxwallet",
]);

export function isRecognizedReadyName(value: unknown): boolean {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  return READY_WALLET_NAMES.has(normalized);
}

export function isCompatibleReadyVersion(value: unknown): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(String(value));
  if (!match) return false;
  if (match[4]?.startsWith("-")) return false;
  const observed = match.slice(1, 4).map(Number);
  const minimum = READY_MIN_VERSION.split(".").map(Number);
  if (observed[0] !== minimum[0]) return false;
  for (let index = 0; index < 3; index += 1) {
    if (observed[index]! > minimum[index]!) return true;
    if (observed[index]! < minimum[index]!) return false;
  }
  return true;
}
