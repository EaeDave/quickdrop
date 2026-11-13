import { afterEach, describe, expect, test } from "bun:test";
import {
  formatRoomExpiry,
  formatRoomPresence,
  openRoom,
  roomWebSocketUrl,
} from "./text-client";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
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

describe("browser room WebSocket URLs", () => {
  test("uses the current origin and matching secure transport", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: new URL("https://quickdrop.example/DEV?c=OTHER#item") },
    });
    expect(roomWebSocketUrl("DEV")).toBe("wss://quickdrop.example/api/text/DEV/ws");
    window.location.href = "http://localhost:3000/";
    expect(roomWebSocketUrl("A B")).toBe("ws://localhost:3000/api/text/A%20B/ws");
  });
});

describe("browser text room access", () => {
  test("opens protected rooms with same-origin cookies and a trimmed PIN", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Response.json({
        code: "DEV",
        protected: true,
        created: false,
        accessExpiresAt: null,
        kind: "custom",
        expiresAfterMinutes: 30,
        expiresAt: null,
        presence: 1,
      });
    }) as typeof fetch;

    const opened = await openRoom("dev", " 1234 ");

    expect(requestedUrl).toBe("/api/text/DEV/open");
    expect(requestedInit?.credentials).toBe("same-origin");
    expect(requestedInit?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(requestedInit?.body))).toEqual({ pin: "1234" });
    expect(opened.protected).toBe(true);
  });
});
