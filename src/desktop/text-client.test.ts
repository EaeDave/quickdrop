import { afterEach, describe, expect, test } from "bun:test";
import { formatRoomExpiry, openRoom, setTextClientBaseUrl } from "./text-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setTextClientBaseUrl("");
});

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

describe("desktop text API base URL", () => {
  test("opens public rooms through the configured production backend without cookies", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Response.json({
        code: "DEV",
        protected: false,
        created: false,
        accessExpiresAt: null,
        kind: "custom",
        expiresAfterMinutes: 30,
        expiresAt: null,
        presence: 1,
      });
    }) as typeof fetch;

    setTextClientBaseUrl("https://quickdrop.example/");
    await openRoom("dev");

    expect(requestedUrl).toBe("https://quickdrop.example/api/text/DEV/open");
    expect(requestedInit?.credentials).toBe("omit");
  });
});
