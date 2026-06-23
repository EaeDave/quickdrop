import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { WebSocket as NodeWebSocket } from "ws";
import { TextSessionHub } from "./text-session-hub";
import { rearmTextRoomsAfterRestart, registerTextSessionRoutes, startTextSessionSweep } from "./text-session-service";
import { hashRoomPin } from "./text-room-pin";
import type { TextRoomRow, TextRoomsRepository } from "./text-rooms-repository";

type ServerMessage = {
  type: "snapshot" | "update" | "presence" | "typing" | "pointer" | "peer_left" | "ack" | "error";
  text?: string;
  version?: number;
  clientId?: string;
  by?: string;
  count?: number;
  active?: boolean;
  visible?: boolean;
  x?: number;
  y?: number;
  error?: string;
  message?: string;
};

type MutableClock = { current: Date };

const queuedMessages = new WeakMap<NodeWebSocket, ServerMessage[]>();
const pendingReceivers = new WeakMap<
  NodeWebSocket,
  Array<{ resolve: (message: ServerMessage) => void; reject: (error: Error) => void }>
>();

class InMemoryTextRoomsRepository implements TextRoomsRepository {
  private readonly rooms = new Map<string, TextRoomRow>();

  async countActiveTextRooms(now: Date): Promise<number> {
    let count = 0;

    for (const room of this.rooms.values()) {
      if (room.deleted_at === null && (room.expires_at === null || room.expires_at > now)) {
        count += 1;
      }
    }

    return count;
  }

  async createTextRoom(input: {
    code: string;
    text: string;
    version: number;
    pinHash?: string | null;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
  }): Promise<TextRoomRow | null> {
    if (this.rooms.has(input.code)) {
      return null;
    }

    const row: TextRoomRow = {
      code: input.code,
      text: input.text,
      version: input.version,
      pin_hash: input.pinHash ?? null,
      created_at: new Date(input.createdAt),
      updated_at: new Date(input.updatedAt),
      expires_at: new Date(input.expiresAt),
      deleted_at: null,
    };
    this.rooms.set(input.code, row);
    return copyRoom(row);
  }

  async findTextRoomByCode(code: string): Promise<TextRoomRow | null> {
    const room = this.rooms.get(code);
    if (!room || room.deleted_at !== null) {
      return null;
    }

    return copyRoom(room);
  }

  async markTextRoomActive(code: string, updatedAt: Date): Promise<void> {
    const room = this.rooms.get(code);
    if (!room || room.deleted_at !== null) {
      return;
    }

    room.updated_at = new Date(updatedAt);
    room.expires_at = null;
  }

  async updateTextRoomText(input: { code: string; text: string; now: Date }): Promise<TextRoomRow | null> {
    const room = this.rooms.get(input.code);
    if (!room || room.deleted_at !== null) {
      return null;
    }

    room.text = input.text;
    room.version += 1;
    room.updated_at = new Date(input.now);
    return copyRoom(room);
  }

  async scheduleTextRoomExpiry(code: string, expiresAt: Date, updatedAt: Date): Promise<void> {
    const room = this.rooms.get(code);
    if (!room || room.deleted_at !== null) {
      return;
    }

    room.expires_at = new Date(expiresAt);
    room.updated_at = new Date(updatedAt);
  }

  async rearmOpenTextRooms(expiresAt: Date, updatedAt: Date): Promise<void> {
    for (const room of this.rooms.values()) {
      if (room.deleted_at === null && room.expires_at === null) {
        room.expires_at = new Date(expiresAt);
        room.updated_at = new Date(updatedAt);
      }
    }
  }

  async findExpiredTextRooms(now: Date, limit = 100): Promise<TextRoomRow[]> {
    const rows = [...this.rooms.values()]
      .filter((room) => room.deleted_at === null && room.expires_at !== null && room.expires_at <= now)
      .sort((left, right) => left.expires_at!.getTime() - right.expires_at!.getTime())
      .slice(0, limit)
      .map(copyRoom);

    return rows;
  }

  async markTextRoomDeleted(code: string, deletedAt: Date): Promise<void> {
    const room = this.rooms.get(code);
    if (!room || room.deleted_at !== null) {
      return;
    }

    room.deleted_at = new Date(deletedAt);
  }
}

function copyRoom(room: TextRoomRow): TextRoomRow {
  return {
    code: room.code,
    text: room.text,
    version: room.version,
    pin_hash: room.pin_hash,
    created_at: new Date(room.created_at),
    updated_at: new Date(room.updated_at),
    expires_at: room.expires_at ? new Date(room.expires_at) : null,
    deleted_at: room.deleted_at ? new Date(room.deleted_at) : null,
  };
}

async function startTestServer(repository: TextRoomsRepository, clock: MutableClock) {
  const app = Fastify({ logger: false });
  const hub = new TextSessionHub({ maxClientsPerSession: 20 });
  const sockets = new Set<NodeWebSocket>();

  app.register(rateLimit, { global: false });
  app.register(websocket, { options: { maxPayload: 1024 + 1024 } });
  app.after((error) => {
    if (error) {
      throw error;
    }

    registerTextSessionRoutes(app, {
      hub,
      repository,
      maxBytes: 1024,
      maxSessions: 500,
      codeLength: 6,
      ttlMs: 60 * 60 * 1000,
      now: () => new Date(clock.current),
    });
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const wsBase = `ws://127.0.0.1:${new URL(address).port}`;

  return {
    app,
    hub,
    async close() {
      await Promise.all([...sockets].map(closeSocket));
      app.server.closeAllConnections?.();
      await app.close();
    },
    connect(code: string, cookieHeader?: string): NodeWebSocket {
      const socket = new NodeWebSocket(`${wsBase}/api/text/${code}/ws`, {
        headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
      });
      queuedMessages.set(socket, []);
      pendingReceivers.set(socket, []);
      socket.on("message", (data) => {
        const parsed: ServerMessage = JSON.parse(String(data));
        const waiting = pendingReceivers.get(socket);
        if (waiting && waiting.length > 0) {
          const next = waiting.shift();
          next?.resolve(parsed);
          return;
        }

        queuedMessages.get(socket)?.push(parsed);
      });
      socket.once("error", (error) => {
        const waiting = pendingReceivers.get(socket) ?? [];
        pendingReceivers.set(socket, []);
        for (const receiver of waiting) {
          receiver.reject(error instanceof Error ? error : new Error("socket error"));
        }
      });
      socket.once("close", () => {
        sockets.delete(socket);
        const waiting = pendingReceivers.get(socket) ?? [];
        pendingReceivers.set(socket, []);
        for (const receiver of waiting) {
          receiver.reject(new Error("socket closed"));
        }
      });
      sockets.add(socket);
      return socket;
    },
  };
}

function closeSocket(socket: NodeWebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  if (socket.readyState === NodeWebSocket.CLOSED) {
    resolve();
    return promise;
  }

  socket.once("close", () => resolve());
  socket.close();
  return promise;
}

function nextMessage(socket: NodeWebSocket): Promise<ServerMessage> {
  const queued = queuedMessages.get(socket);
  const first = queued?.shift();
  if (first) {
    return Promise.resolve(first);
  }

  const { promise, resolve, reject } = Promise.withResolvers<ServerMessage>();
  const waiting = pendingReceivers.get(socket) ?? [];
  waiting.push({ resolve, reject });
  pendingReceivers.set(socket, waiting);
  return promise;
}

async function expectJoined(socket: NodeWebSocket, expectedCount: number) {
  const snapshot = await nextMessage(socket);
  expect(snapshot.type).toBe("snapshot");
  const presence = await nextMessage(socket);
  expect(presence).toEqual({ type: "presence", count: expectedCount });
  return snapshot;
}

describe("text session routes", () => {
  test("creates a room and serves its snapshot", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const response = await server.app.inject({ method: "POST", url: "/api/text" });
      expect(response.statusCode).toBe(200);
      const created: { code: string; protected: boolean } = JSON.parse(response.body);
      expect(created.code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
      expect(created.protected).toBe(false);

      const snapshot = await server.app.inject({ method: "GET", url: `/api/text/${created.code}` });
      expect(snapshot.statusCode).toBe(200);
      const payload: { text: string; version: number; protected: boolean } = JSON.parse(snapshot.body);
      expect(payload).toEqual({ text: "", version: 0, protected: false });
    } finally {
      await server.close();
    }
  });

  test("broadcasts a write to other clients and acks the writer", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const createResponse = await server.app.inject({ method: "POST", url: "/api/text" });
      const created: { code: string; protected: boolean } = JSON.parse(createResponse.body);
      const author = server.connect(created.code);
      const snapshot = await expectJoined(author, 1);
      expect(snapshot.text).toBe("");

      const authorPresenceAfterViewer = nextMessage(author);
      const viewer = server.connect(created.code);
      const viewerSnapshot = await expectJoined(viewer, 2);
      expect(viewerSnapshot.type).toBe("snapshot");
      expect(await authorPresenceAfterViewer).toEqual({ type: "presence", count: 2 });

      const updateOnViewer = nextMessage(viewer);
      const ackOnAuthor = nextMessage(author);
      author.send(JSON.stringify({ type: "write", text: "select 1", baseVersion: snapshot.version }));

      expect(await updateOnViewer).toEqual({ type: "update", text: "select 1", version: 1, by: snapshot.clientId });
      expect(await ackOnAuthor).toEqual({ type: "ack", version: 1 });

      const authorPeerLeftAfterLeave = nextMessage(author);
      const authorPresenceAfterLeave = nextMessage(author);
      await closeSocket(viewer);
      expect(await authorPeerLeftAfterLeave).toEqual({ type: "peer_left", by: viewerSnapshot.clientId });
      expect(await authorPresenceAfterLeave).toEqual({ type: "presence", count: 1 });

      const persisted = await server.app.inject({ method: "GET", url: `/api/text/${created.code}` });
      const persistedPayload: { text: string; version: number; protected: boolean } = JSON.parse(persisted.body);
      expect(persistedPayload).toEqual({ text: "select 1", version: 1, protected: false });
    } finally {
      await server.close();
    }
  });

  test("relays typing, pointer, and peer-left events", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const createResponse = await server.app.inject({ method: "POST", url: "/api/text" });
      const created: { code: string; protected: boolean } = JSON.parse(createResponse.body);
      const author = server.connect(created.code);
      const authorSnapshot = await expectJoined(author, 1);

      const authorPresenceAfterViewer = nextMessage(author);
      const viewer = server.connect(created.code);
      await expectJoined(viewer, 2);
      expect(await authorPresenceAfterViewer).toEqual({ type: "presence", count: 2 });

      author.send(JSON.stringify({ type: "typing", active: true }));
      expect(await nextMessage(viewer)).toEqual({ type: "typing", by: authorSnapshot.clientId, active: true });

      author.send(JSON.stringify({ type: "pointer", visible: true, x: 0.42, y: 0.18 }));
      expect(await nextMessage(viewer)).toEqual({
        type: "pointer",
        by: authorSnapshot.clientId,
        visible: true,
        x: 0.42,
        y: 0.18,
      });

      const peerLeftOnViewer = nextMessage(viewer);
      const presenceAfterLeave = nextMessage(viewer);
      await closeSocket(author);
      expect(await peerLeftOnViewer).toEqual({ type: "peer_left", by: authorSnapshot.clientId });
      expect(await presenceAfterLeave).toEqual({ type: "presence", count: 1 });
    } finally {
      await server.close();
    }
  });

  test("rejects an oversized write without closing the socket", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const createResponse = await server.app.inject({ method: "POST", url: "/api/text" });
      const created: { code: string; protected: boolean } = JSON.parse(createResponse.body);
      const author = server.connect(created.code);
      await expectJoined(author, 1);

      const errorMessage = nextMessage(author);
      author.send(JSON.stringify({ type: "write", text: "x".repeat(1100), baseVersion: 0 }));

      expect((await errorMessage).type).toBe("error");
    } finally {
      await server.close();
    }
  });

  test("rejects an unknown room code on the socket", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const socket = server.connect("ZZZZZZ");
      expect(await nextMessage(socket)).toEqual({ type: "error", error: "not_found", message: "Sala não encontrada." });
    } finally {
      await server.close();
    }
  });

  test("requires a valid PIN for protected rooms", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const createResponse = await server.app.inject({
        method: "POST",
        url: "/api/text",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ pin: "1234" }),
      });
      expect(createResponse.statusCode).toBe(200);
      const created: { code: string; protected: boolean } = JSON.parse(createResponse.body);
      expect(created.protected).toBe(true);
      const creatorCookie = String(createResponse.headers["set-cookie"]);

      const anonymousRead = await server.app.inject({ method: "GET", url: `/api/text/${created.code}` });
      expect(anonymousRead.statusCode).toBe(401);
      expect(anonymousRead.json().error).toBe("pin_required");

      const missingPin = await server.app.inject({ method: "POST", url: `/api/text/${created.code}/access` });
      expect(missingPin.statusCode).toBe(401);
      expect(missingPin.json().error).toBe("pin_required");

      const wrongPin = await server.app.inject({
        method: "POST",
        url: `/api/text/${created.code}/access`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ pin: "9999" }),
      });
      expect(wrongPin.statusCode).toBe(401);
      expect(wrongPin.json().error).toBe("pin_invalid");

      const access = await server.app.inject({
        method: "POST",
        url: `/api/text/${created.code}/access`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ pin: "1234" }),
      });
      expect(access.statusCode).toBe(200);
      const joinCookie = String(access.headers["set-cookie"]);

      const protectedRead = await server.app.inject({
        method: "GET",
        url: `/api/text/${created.code}`,
        headers: { cookie: joinCookie },
      });
      expect(protectedRead.statusCode).toBe(200);
      const protectedPayload: { text: string; version: number; protected: boolean } = JSON.parse(protectedRead.body);
      expect(protectedPayload).toEqual({ text: "", version: 0, protected: true });

      const blockedSocket = server.connect(created.code);
      expect(await nextMessage(blockedSocket)).toEqual({
        type: "error",
        error: "pin_required",
        message: "Sala protegida por PIN.",
      });
      await closeSocket(blockedSocket);

      const creatorSocket = server.connect(created.code, creatorCookie);
      const creatorSnapshot = await expectJoined(creatorSocket, 1);
      expect(creatorSnapshot.type).toBe("snapshot");
      await closeSocket(creatorSocket);
    } finally {
      await server.close();
    }
  });

  test("preserves room text across app restarts", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const firstServer = await startTestServer(repository, clock);

    const createResponse = await firstServer.app.inject({ method: "POST", url: "/api/text" });
    const created: { code: string; protected: boolean } = JSON.parse(createResponse.body);
    const author = firstServer.connect(created.code);
    await expectJoined(author, 1);
    const ack = nextMessage(author);
    author.send(JSON.stringify({ type: "write", text: "survives restart", baseVersion: 0 }));
    await ack;
    await firstServer.close();

    const secondServer = await startTestServer(repository, clock);
    try {
      const snapshot = await secondServer.app.inject({ method: "GET", url: `/api/text/${created.code}` });
      expect(snapshot.statusCode).toBe(200);
      const payload: { text: string; version: number; protected: boolean } = JSON.parse(snapshot.body);
      expect(payload).toEqual({ text: "survives restart", version: 1, protected: false });
    } finally {
      await secondServer.close();
    }
  });

  test("rearms previously active rooms after restart", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const created = await repository.createTextRoom({
      code: "ROOM01",
      text: "",
      version: 0,
      createdAt: clock.current,
      updatedAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 60 * 60 * 1000),
    });

    if (!created) {
      throw new Error("expected room to be created");
    }

    await repository.markTextRoomActive(created.code, clock.current);
    const active = await repository.findTextRoomByCode(created.code);
    expect(active?.expires_at).toBeNull();

    clock.current = new Date("2026-06-23T20:05:00Z");
    await rearmTextRoomsAfterRestart(60 * 60 * 1000, repository, () => new Date(clock.current));

    const rearmed = await repository.findTextRoomByCode(created.code);
    expect(rearmed?.expires_at?.toISOString()).toBe("2026-06-23T21:05:00.000Z");
  });

  test("marks expired rooms as deleted during the database sweep", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const created = await repository.createTextRoom({
      code: "ROOM01",
      text: "expired",
      version: 0,
      createdAt: new Date("2026-06-23T18:00:00Z"),
      updatedAt: new Date("2026-06-23T18:00:00Z"),
      expiresAt: new Date("2026-06-23T19:00:00Z"),
    });

    if (!created) {
      throw new Error("expected room to be created");
    }

    const timer = startTextSessionSweep(repository, 5, () => new Date(clock.current));
    await Bun.sleep(20);
    clearInterval(timer);

    expect(await repository.findTextRoomByCode("ROOM01")).toBeNull();
  });
});
