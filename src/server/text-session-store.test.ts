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
    maxClientsPerSession: 10,
    ...overrides,
  });
}

describe("TextSessionStore", () => {
  test("joins clients into a room and tracks the count", () => {
    const store = makeStore();

    expect(store.join("ROOM01", makeClient("a"))).toEqual({ ok: true, clientCount: 1 });
    expect(store.join("ROOM01", makeClient("b"))).toEqual({ ok: true, clientCount: 2 });
    expect(store.clientCount("room01")).toBe(2);
  });

  test("enforces the per-room client cap", () => {
    const store = makeStore({ maxClientsPerSession: 1 });

    expect(store.join("ROOM01", makeClient("a"))).toEqual({ ok: true, clientCount: 1 });
    expect(store.join("ROOM01", makeClient("b"))).toEqual({ ok: false, reason: "full" });
  });

  test("broadcast delivers to every client except the excluded one", () => {
    const store = makeStore();
    const author = makeClient("author");
    const viewer = makeClient("viewer");
    store.join("ROOM01", author);
    store.join("ROOM01", viewer);

    store.broadcast("ROOM01", "update", "author");

    expect(author.sent).toEqual([]);
    expect(viewer.sent).toEqual(["update"]);
  });

  test("leave removes a client and deletes the empty room", () => {
    const store = makeStore();
    store.join("ROOM01", makeClient("a"));
    store.join("ROOM01", makeClient("b"));

    expect(store.leave("ROOM01", "a")).toBe(1);
    expect(store.clientCount("ROOM01")).toBe(1);
    expect(store.leave("ROOM01", "b")).toBe(0);
    expect(store.clientCount("ROOM01")).toBe(0);
  });
});
