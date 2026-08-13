import { describe, expect, test } from "bun:test";
import { formatRoomExpiry } from "./text-client";

describe("room expiry labels", () => {
  test("describes a held-open room and a live countdown", () => {
    expect(
      formatRoomExpiry(
        { expiresAfterMinutes: 30, expiresAt: null, presence: 1 },
        new Date("2026-06-23T20:00:00Z"),
      ),
    ).toBe("Segura · some 30 min depois que todos saírem");

    expect(
      formatRoomExpiry(
        { expiresAfterMinutes: 30, expiresAt: "2026-06-23T20:12:34.000Z", presence: 0 },
        new Date("2026-06-23T20:00:00Z"),
      ),
    ).toBe("Some em 12:34");

    expect(
      formatRoomExpiry(
        { expiresAfterMinutes: 30, expiresAt: "2026-06-23T20:00:00.000Z", presence: 0 },
        new Date("2026-06-23T20:00:01Z"),
      ),
    ).toBe("Encerrando…");
  });
});
