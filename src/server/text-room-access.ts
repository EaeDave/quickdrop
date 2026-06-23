import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeSessionCode } from "./ids";

const ACCESS_TOKEN_PREFIX = "v1";

export type RoomAccessCheck =
  | { ok: true; expiresAt: Date }
  | { ok: false; error: "missing" | "expired" | "invalid" };

export function createRoomAccessCookie(input: {
  code: string;
  pinHash: string;
  ttlMs: number;
  now: Date;
  secure: boolean;
}): string {
  const normalizedCode = normalizeSessionCode(input.code);
  const expiresAt = new Date(input.now.getTime() + input.ttlMs);
  const payload = JSON.stringify({
    room: normalizedCode,
    exp: expiresAt.getTime(),
    nonce: randomBytes(12).toString("base64url"),
  });
  const payloadText = Buffer.from(payload, "utf8").toString("base64url");
  const signature = sign(payloadText, input.pinHash);

  return serializeCookie(cookieName(normalizedCode), `${ACCESS_TOKEN_PREFIX}.${payloadText}.${signature}`, {
    path: `/api/text/${encodeURIComponent(normalizedCode)}`,
    httpOnly: true,
    sameSite: "Lax",
    secure: input.secure,
    maxAgeSeconds: Math.max(1, Math.floor(input.ttlMs / 1000)),
  });
}

export function clearRoomAccessCookie(code: string, secure: boolean): string {
  const normalizedCode = normalizeSessionCode(code);
  return serializeCookie(cookieName(normalizedCode), "", {
    path: `/api/text/${encodeURIComponent(normalizedCode)}`,
    httpOnly: true,
    sameSite: "Lax",
    secure,
    maxAgeSeconds: 0,
  });
}

export function verifyRoomAccessCookie(input: {
  code: string;
  pinHash: string;
  cookieHeader: string | undefined;
  now: Date;
}): RoomAccessCheck {
  const normalizedCode = normalizeSessionCode(input.code);
  const rawValue = readCookieValue(input.cookieHeader, cookieName(normalizedCode));
  if (!rawValue) {
    return { ok: false, error: "missing" };
  }

  const parts = rawValue.split(".");
  if (parts.length !== 3 || parts[0] !== ACCESS_TOKEN_PREFIX) {
    return { ok: false, error: "invalid" };
  }

  const payloadText = parts[1] ?? "";
  const signatureText = parts[2] ?? "";
  const expectedSignature = sign(payloadText, input.pinHash);
  const expectedBuffer = Buffer.from(expectedSignature, "base64url");
  const receivedBuffer = Buffer.from(signatureText, "base64url");

  if (expectedBuffer.length === 0 || expectedBuffer.length !== receivedBuffer.length) {
    return { ok: false, error: "invalid" };
  }

  if (!timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return { ok: false, error: "invalid" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "invalid" };
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("room" in payload) ||
    payload.room !== normalizedCode ||
    !("exp" in payload) ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, error: "invalid" };
  }

  const expiresAt = new Date(payload.exp);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, error: "invalid" };
  }

  if (expiresAt <= input.now) {
    return { ok: false, error: "expired" };
  }

  return { ok: true, expiresAt };
}

function cookieName(code: string): string {
  return `qd_text_access_${code}`;
}

function sign(payloadText: string, pinHash: string): string {
  return createHmac("sha256", pinHash).update(payloadText).digest("base64url");
}

function readCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) {
      continue;
    }

    const value = trimmed.slice(name.length + 1);
    return value.length > 0 ? value : null;
  }

  return null;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    path: string;
    httpOnly: boolean;
    sameSite: "Lax";
    secure: boolean;
    maxAgeSeconds: number;
  },
): string {
  const parts = [`${name}=${value}`, `Path=${options.path}`, `Max-Age=${options.maxAgeSeconds}`, `SameSite=${options.sameSite}`];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
