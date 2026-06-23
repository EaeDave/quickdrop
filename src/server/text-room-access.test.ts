import { describe, expect, test } from "bun:test";
import { clearRoomAccessCookie, createRoomAccessCookie, verifyRoomAccessCookie } from "./text-room-access";
import { hashRoomPin } from "./text-room-pin";

describe("text room access cookie", () => {
  test("creates and verifies a room access cookie", async () => {
    const now = new Date("2026-06-23T20:00:00Z");
    const pinHash = await hashRoomPin("1234");
    const cookie = createRoomAccessCookie({
      code: "ROOM01",
      pinHash,
      ttlMs: 60 * 60 * 1000,
      now,
      secure: false,
    });

    const verified = verifyRoomAccessCookie({
      code: "ROOM01",
      pinHash,
      cookieHeader: cookie,
      now: new Date("2026-06-23T20:30:00Z"),
    });

    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.expiresAt.toISOString()).toBe("2026-06-23T21:00:00.000Z");
    }
  });

  test("rejects cookies for another room or after expiry", async () => {
    const now = new Date("2026-06-23T20:00:00Z");
    const pinHash = await hashRoomPin("1234");
    const cookie = createRoomAccessCookie({
      code: "ROOM01",
      pinHash,
      ttlMs: 60 * 1000,
      now,
      secure: false,
    });

    expect(
      verifyRoomAccessCookie({
        code: "ROOM02",
        pinHash,
        cookieHeader: cookie,
        now: new Date("2026-06-23T20:00:30Z"),
      }),
    ).toEqual({ ok: false, error: "missing" });

    expect(
      verifyRoomAccessCookie({
        code: "ROOM01",
        pinHash,
        cookieHeader: cookie,
        now: new Date("2026-06-23T20:02:00Z"),
      }),
    ).toEqual({ ok: false, error: "expired" });
  });

  test("clears the cookie on demand", () => {
    expect(clearRoomAccessCookie("ROOM01", false)).toContain("Max-Age=0");
  });
});
