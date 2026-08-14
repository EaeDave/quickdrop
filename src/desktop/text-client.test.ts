import { afterEach, describe, expect, test } from "bun:test";
import {
  formatRoomExpiry,
  formatRoomPresence,
  openRoom,
  roomWebSocketProtocols,
  roomWebSocketUrl,
  setTextClientBaseUrl,
} from "./text-client";

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
    ).toBe("Held open · expires 30 min after everyone leaves");

    expect(
      formatRoomExpiry(
        { expiresAfterMinutes: 30, expiresAt: "2026-06-23T20:12:34.000Z", presence: 0 },
        new Date("2026-06-23T20:00:00Z"),
      ),
    ).toBe("Expires in 12:34");

    expect(
      formatRoomExpiry(
        { expiresAfterMinutes: 30, expiresAt: "2026-06-23T20:00:00.000Z", presence: 0 },
        new Date("2026-06-23T20:00:01Z"),
      ),
    ).toBe("Expiring…");
    expect(formatRoomExpiry(
      { expiresAfterMinutes: 30, expiresAt: null, presence: 1 },
      new Date("2026-06-23T20:00:00Z"),
      "compact",
    )).toBe("Held open · 30m idle");
    expect(formatRoomPresence(1)).toBe("1 person online");
    expect(formatRoomPresence(2)).toBe("2 people online");
  });
});

describe("native protected room access", () => {
  test("sends the ephemeral access token as a WebSocket subprotocol", () => {
    setTextClientBaseUrl("https://quickdrop.example/");
    expect(roomWebSocketUrl("DEV")).toBe("wss://quickdrop.example/api/text/DEV/ws");
    expect(roomWebSocketProtocols("v1.payload.signature")).toEqual([
      "quickdrop-access.v1.payload.signature",
    ]);
    expect(roomWebSocketProtocols()).toBeUndefined();
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
        accessToken: "native-token",
        accessExpiresAt: null,
        kind: "custom",
        expiresAfterMinutes: 30,
        expiresAt: null,
        presence: 1,
      });
    }) as typeof fetch;

    setTextClientBaseUrl("https://quickdrop.example/");
    const opened = await openRoom("dev");

    expect(requestedUrl).toBe("https://quickdrop.example/api/text/DEV/open");
    expect(requestedInit?.credentials).toBe("omit");
    expect(requestedInit?.headers).toMatchObject({ "x-quickdrop-native": "1" });
    expect(opened.accessToken).toBe("native-token");
  });
});
