import { describe, expect, test } from "bun:test";
import { TextSessionStore, type SessionClient, type TextSessionStoreOptions } from "./text-session-store";

type RecordingClient = SessionClient & { sent: string[]; closed: boolean };

function makeClient(id: string): RecordingClient {
  const client: RecordingClient = {
    id,
    sent: [],
    closed: false,
    send(data) {
      client.sent.push(data);
    },
    close() {
      client.closed = true;
    },
  };

  return client;
}

function makeStore(overrides: Partial<TextSessionStoreOptions> = {}) {
  return new TextSessionStore({
    maxBytes: 1024,
    maxSessions: 100,
    maxClientsPerSession: 10,
    codeLength: 6,
    generateCode: () => "AAAAAA",
    ...overrides,
  });
}

describe("TextSessionStore", () => {
  test("creates an empty session and tracks size", () => {
    const store = makeStore();
    const result = store.createSession();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.text).toBe("");
      expect(result.session.version).toBe(0);
      expect(result.session.code).toBe("AAAAAA");
    }
    expect(store.size).toBe(1);
  });

  test("retries code generation on collision", () => {
    const codes = ["AAAAAA", "AAAAAA", "BBBBBB"];
    let index = 0;
    const store = makeStore({ generateCode: () => codes[index++]! });

    const first = store.createSession();
    const second = store.createSession();

    expect(first.ok && first.session.code).toBe("AAAAAA");
    expect(second.ok && second.session.code).toBe("BBBBBB");
    expect(store.size).toBe(2);
  });

  test("rejects creation past the session limit", () => {
    const codes = ["AAAAAA", "BBBBBB"];
    let index = 0;
    const store = makeStore({ maxSessions: 1, generateCode: () => codes[index++]! });

    expect(store.createSession().ok).toBe(true);
    const second = store.createSession();

    expect(second).toEqual({ ok: false, reason: "limit" });
    expect(store.size).toBe(1);
  });

  test("looks up sessions case-insensitively", () => {
    const store = makeStore({ generateCode: () => "ABCDEF" });
    store.createSession();

    expect(store.getSession("abcdef")?.code).toBe("ABCDEF");
    expect(store.getSession("  abcDef ")?.code).toBe("ABCDEF");
  });

  test("join returns a snapshot and enforces the client cap", () => {
    const store = makeStore({ maxClientsPerSession: 1, generateCode: () => "ROOM01" });
    store.createSession();

    expect(store.join("ROOM01", makeClient("a"))).toEqual({ ok: true, text: "", version: 0 });
    expect(store.join("ROOM01", makeClient("b"))).toEqual({ ok: false, reason: "full" });
    expect(store.join("NOPE00", makeClient("c"))).toEqual({ ok: false, reason: "not_found" });
  });

  test("applyWrite bumps the version and stores the text", () => {
    const store = makeStore({ generateCode: () => "ROOM01" });
    store.createSession();

    expect(store.applyWrite("ROOM01", "select 1")).toEqual({ ok: true, version: 1 });
    expect(store.applyWrite("room01", "select 2")).toEqual({ ok: true, version: 2 });
    expect(store.getSession("ROOM01")?.text).toBe("select 2");
    expect(store.applyWrite("NOPE00", "x")).toEqual({ ok: false, reason: "not_found" });
  });

  test("applyWrite rejects oversized text without mutating the session", () => {
    const store = makeStore({ maxBytes: 5, generateCode: () => "ROOM01" });
    store.createSession();
    store.applyWrite("ROOM01", "okay");

    expect(store.applyWrite("ROOM01", "way too long")).toEqual({ ok: false, reason: "too_large" });
    expect(store.getSession("ROOM01")?.text).toBe("okay");
    expect(store.getSession("ROOM01")?.version).toBe(1);
  });

  test("broadcast delivers to every client except the excluded one", () => {
    const store = makeStore({ generateCode: () => "ROOM01" });
    store.createSession();
    const author = makeClient("author");
    const viewer = makeClient("viewer");
    store.join("ROOM01", author);
    store.join("ROOM01", viewer);

    const session = store.getSession("ROOM01")!;
    store.broadcast(session, "update", "author");

    expect(author.sent).toEqual([]);
    expect(viewer.sent).toEqual(["update"]);
  });

  test("sweepExpired removes only idle, empty sessions past the TTL", () => {
    let clock = 0;
    const codes = ["IDLE00", "BUSY00", "FRESH0"];
    let index = 0;
    const store = makeStore({ generateCode: () => codes[index++]!, now: () => clock });

    store.createSession(); // IDLE00 at t=0, no clients
    store.createSession(); // BUSY00 at t=0
    store.join("BUSY00", makeClient("a")); // keeps BUSY00 alive

    clock = 5000;
    store.createSession(); // FRESH0 at t=5000

    clock = 6000;
    const removed = store.sweepExpired(2000);

    expect(removed).toBe(1);
    expect(store.getSession("IDLE00")).toBeUndefined();
    expect(store.getSession("BUSY00")).toBeDefined();
    expect(store.getSession("FRESH0")).toBeDefined();
  });
});
