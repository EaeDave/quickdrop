import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./index";

const testEnv = {
  PORT: "3000",
  DATABASE_URL: "postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  PUBLIC_BASE_URL: "https://quickdrop.eaedave.xyz",
  TEXT_SESSION_MAX_KB: "1",
};

type ServerMessage = {
  type: "snapshot" | "update" | "ack" | "error";
  text?: string;
  version?: number;
  clientId?: string;
  by?: string;
  message?: string;
};

let app: FastifyInstance;
let wsBase: string;
const openSockets = new Set<WebSocket>();
const previousEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of Object.keys(testEnv)) {
    previousEnv[key] = process.env[key];
  }
  Object.assign(process.env, testEnv);

  app = buildApp().app;
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  wsBase = `ws://127.0.0.1:${new URL(address).port}`;
});

afterAll(async () => {
  await Promise.all([...openSockets].map(closeSocket));
  app.server.closeAllConnections?.();

  const { promise: closeTimeout, resolve: onCloseTimeout } = Promise.withResolvers<void>();
  const timer = setTimeout(onCloseTimeout, 1000);
  await Promise.race([app.close(), closeTimeout]);
  clearTimeout(timer);

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function connect(code: string): WebSocket {
  const socket = new WebSocket(`${wsBase}/api/text/${code}/ws`);
  openSockets.add(socket);
  socket.addEventListener("close", () => openSockets.delete(socket), { once: true });
  return socket;
}

function closeSocket(socket: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  if (socket.readyState === WebSocket.CLOSED) {
    resolve();
    return promise;
  }

  socket.addEventListener("close", () => resolve(), { once: true });
  socket.close();
  return promise;
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<ServerMessage>();

  socket.addEventListener(
    "message",
    (event) => {
      const parsed: ServerMessage = JSON.parse(String(event.data));
      resolve(parsed);
    },
    { once: true },
  );
  socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });

  return promise;
}

async function createRoom(): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/text" });
  expect(response.statusCode).toBe(200);
  const payload: { code: string } = JSON.parse(response.body);
  return payload.code;
}

describe("text session routes", () => {
  test("creates a room and serves its snapshot", async () => {
    const code = await createRoom();
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);

    const snapshot = await app.inject({ method: "GET", url: `/api/text/${code}` });
    expect(snapshot.statusCode).toBe(200);
    const payload: { text: string; version: number } = JSON.parse(snapshot.body);
    expect(payload).toEqual({ text: "", version: 0 });
  });

  test("returns 404 for an unknown room", async () => {
    const response = await app.inject({ method: "GET", url: "/api/text/NOPE99" });
    expect(response.statusCode).toBe(404);
    const payload: { error: string } = JSON.parse(response.body);
    expect(payload.error).toBe("not_found");
  });

  test("broadcasts a write to other clients and acks the writer", async () => {
    const code = await createRoom();
    const author = connect(code);
    const snapshot = await nextMessage(author);
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.text).toBe("");

    const viewer = connect(code);
    await nextMessage(viewer);

    const updateOnViewer = nextMessage(viewer);
    const ackOnAuthor = nextMessage(author);
    author.send(JSON.stringify({ type: "write", text: "select 1", baseVersion: snapshot.version }));

    expect(await updateOnViewer).toEqual({ type: "update", text: "select 1", version: 1, by: snapshot.clientId });
    expect(await ackOnAuthor).toEqual({ type: "ack", version: 1 });

    const persisted = await app.inject({ method: "GET", url: `/api/text/${code}` });
    const persistedPayload: { text: string; version: number } = JSON.parse(persisted.body);
    expect(persistedPayload).toEqual({ text: "select 1", version: 1 });

    await closeSocket(author);
    await closeSocket(viewer);
  });

  test("rejects an oversized write without closing the socket", async () => {
    const code = await createRoom();
    const author = connect(code);
    await nextMessage(author);

    const errorMessage = nextMessage(author);
    author.send(JSON.stringify({ type: "write", text: "x".repeat(1100), baseVersion: 0 }));

    expect((await errorMessage).type).toBe("error");

    await closeSocket(author);
  });

  test("rejects an unknown room code on the socket", async () => {
    const socket = connect("ZZZZZZ");
    expect(await nextMessage(socket)).toEqual({ type: "error", message: "Sala não encontrada." });
  });
});
