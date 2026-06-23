import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_KEY_BYTES = 32;
const PIN_HASH_PREFIX = "scrypt:v1";
export const ROOM_PIN_MIN_LENGTH = 4;
export const ROOM_PIN_MAX_LENGTH = 64;

export function normalizeRoomPin(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export async function hashRoomPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(pin, salt, SCRYPT_KEY_BYTES);
  return `${PIN_HASH_PREFIX}:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifyRoomPin(pin: string, pinHash: string): Promise<boolean> {
  const parts = pinHash.split(":");
  if (parts.length !== 4) {
    return false;
  }

  const [prefix, version, saltText, keyText] = parts;
  if (`${prefix}:${version}` !== PIN_HASH_PREFIX) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;

  try {
    salt = Buffer.from(saltText ?? "", "base64url");
    expected = Buffer.from(keyText ?? "", "base64url");
  } catch {
    return false;
  }

  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  const derived = await scrypt(pin, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function scrypt(pin: string, salt: Buffer, length: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  nodeScrypt(pin, salt, length, (error, derivedKey) => {
    if (error) {
      reject(error);
      return;
    }

    if (!(derivedKey instanceof Buffer)) {
      reject(new Error("Derived key must be a Buffer"));
      return;
    }

    resolve(derivedKey);
  });
  return promise;
}
