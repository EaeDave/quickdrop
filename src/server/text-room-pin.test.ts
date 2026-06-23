import { describe, expect, test } from "bun:test";
import { ROOM_PIN_MAX_LENGTH, ROOM_PIN_MIN_LENGTH, hashRoomPin, normalizeRoomPin, verifyRoomPin } from "./text-room-pin";

describe("text room pin", () => {
  test("normalizes blank and trimmed values", () => {
    expect(normalizeRoomPin(undefined)).toBeNull();
    expect(normalizeRoomPin(null)).toBeNull();
    expect(normalizeRoomPin("   ")).toBeNull();
    expect(normalizeRoomPin(" 1234 ")).toBe("1234");
  });

  test("exposes expected pin length bounds", () => {
    expect(ROOM_PIN_MIN_LENGTH).toBe(4);
    expect(ROOM_PIN_MAX_LENGTH).toBe(64);
  });

  test("hashes and verifies the room pin", async () => {
    const pinHash = await hashRoomPin("1234");

    expect(pinHash.startsWith("scrypt:v1:")).toBe(true);
    await expect(verifyRoomPin("1234", pinHash)).resolves.toBe(true);
    await expect(verifyRoomPin("9999", pinHash)).resolves.toBe(false);
  });
});
