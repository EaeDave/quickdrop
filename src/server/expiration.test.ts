import { describe, expect, test } from "bun:test";
import { computeExpiresAt, computeSignedUrlExpirySeconds, isExpired } from "./expiration";

describe("expiration rules", () => {
  test("computes default 24h expiry", () => {
    const createdAt = new Date("2026-06-22T12:00:00Z");

    expect(computeExpiresAt(createdAt, 24).toISOString()).toBe("2026-06-23T12:00:00.000Z");
  });

  test("treats equality as expired", () => {
    const expiresAt = new Date("2026-06-22T12:00:00Z");

    expect(isExpired(expiresAt, new Date("2026-06-22T12:00:00Z"))).toBe(true);
  });

  test("clamps signed URL TTL", () => {
    const now = new Date("2026-06-22T12:00:00Z");

    expect(computeSignedUrlExpirySeconds(new Date("2026-06-22T12:00:00.500Z"), now)).toBe(1);
    expect(computeSignedUrlExpirySeconds(new Date("2026-06-22T14:00:00Z"), now)).toBe(3600);
    expect(computeSignedUrlExpirySeconds(new Date("2026-06-22T12:15:00Z"), now)).toBe(900);
  });
});
