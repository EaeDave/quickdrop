import { basename } from "node:path";

export function generateUploadId(): string {
  return crypto.randomUUID();
}

export function generateShortId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

const SESSION_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CUSTOM_SESSION_CODE_PATTERN = /^[A-Z0-9_-]{1,16}$/;

export function generateSessionCode(length = 6): string {
  const alphabet = SESSION_CODE_ALPHABET;
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  const buffer = new Uint8Array(1);
  let code = "";

  while (code.length < length) {
    crypto.getRandomValues(buffer);
    const byte = buffer[0]!;
    if (byte >= max) {
      continue;
    }
    code += alphabet[byte % alphabet.length];
  }

  return code;
}

export function normalizeSessionCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidCustomSessionCode(input: string): boolean {
  return CUSTOM_SESSION_CODE_PATTERN.test(normalizeSessionCode(input));
}

export function sanitizeFilename(input: string | undefined): string {
  const baseName = basename(input ?? "");
  const sanitized = baseName
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "");

  return sanitized || "file";
}

export function buildR2Key(id: string, originalName: string, createdAt: Date): string {
  const year = createdAt.getUTCFullYear();
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");

  return `uploads/${year}/${month}/${id}-${sanitizeFilename(originalName)}`;
}
