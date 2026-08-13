import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { WebSocket as NodeWebSocket } from "ws";
import { TextSessionHub } from "./text-session-hub";
import { rearmTextRoomsAfterRestart, registerTextSessionRoutes, startTextDropSweep, startTextSessionSweep } from "./text-session-service";
import { hashRoomPin } from "./text-room-pin";
import type { TextFunnelMetrics, TextMetricIncrement } from "./text-funnel-metrics";
import type {
  ClearTextDropsResult,
  CreateTextDropInput,
  CreateTextDropResult,
  DeleteTextDropResult,
  TextDropRow,
  TextDropsRepository,
} from "./text-drops-repository";
import type { CreateTextRoomInput, TextRoomCreationResult, TextRoomRow, TextRoomsRepository } from "./text-rooms-repository";

type ServerMessage = {
  type: "snapshot" | "update" | "presence" | "typing" | "pointer" | "peer_left" | "ack" | "error" | "drop_added" | "drops_removed" | "drop_deleted" | "drops_cleared";
  text?: string;
  version?: number;
  clientId?: string;
  by?: string;
  origin?: "drop_sync";
  count?: number;
  active?: boolean;
  visible?: boolean;
  x?: number;
  y?: number;
  error?: string;
  message?: string;
  drop?: { id: string; content: string; contentType: string; createdAt: string; expiresAt: string };
  drops?: Array<{ id: string; content: string; contentType: string; createdAt: string; expiresAt: string }>;
  dropId?: string;
  dropIds?: string[];
};

type MutableClock = { current: Date };
type SnapshotResponse = {
  text: string;
  version: number;
  protected: boolean;
  kind: string;
  expiresAfterMinutes: number;
  dropExpiresAfterMinutes: number;
  maxDrops: number;
  drops: ServerMessage["drops"];
};

const queuedMessages = new WeakMap<NodeWebSocket, ServerMessage[]>();
const pendingReceivers = new WeakMap<
  NodeWebSocket,
  Array<{ resolve: (message: ServerMessage) => void; reject: (error: Error) => void }>
>();

class InMemoryTextRoomsRepository implements TextRoomsRepository {
  private readonly rooms: TextRoomRow[] = [];

  private findActiveRoom(code: string): TextRoomRow | undefined {
    return this.rooms.find((room) => room.code === code && room.deleted_at === null);
  }

  async createTextRoomWithinLimit(
    input: CreateTextRoomInput,
    maxSessions: number,
    now: Date,
  ): Promise<TextRoomCreationResult> {
    if (this.findActiveRoom(input.code)) {
      return { status: "conflict" };
    }

    const activeCount = this.rooms.filter(
      (room) => room.deleted_at === null && (room.expires_at === null || room.expires_at > now),
    ).length;
    if (activeCount >= maxSessions) {
      return { status: "limit" };
    }

    const row: TextRoomRow = {
      id: crypto.randomUUID(),
      code: input.code,
      kind: input.kind,
      text: input.text,
      version: input.version,
      pin_hash: input.pinHash ?? null,
      created_at: new Date(input.createdAt),
      updated_at: new Date(input.updatedAt),
      expires_at: new Date(input.expiresAt),
      deleted_at: null,
      drops_started_at: null,
    };
    this.rooms.push(row);
    return { status: "created", room: copyRoom(row) };
  }

  async findTextRoomByCode(code: string): Promise<TextRoomRow | null> {
    const room = this.findActiveRoom(code);
    if (!room) {
      return null;
    }

    return copyRoom(room);
  }

  async markTextRoomActive(code: string, updatedAt: Date): Promise<void> {
    const room = this.findActiveRoom(code);
    if (
      !room ||
      room.updated_at > updatedAt ||
      (room.expires_at !== null && room.expires_at <= updatedAt)
    ) {
      return;
    }

    room.updated_at = new Date(updatedAt);
    room.expires_at = null;
  }

  async updateTextRoomText(input: { code: string; text: string; now: Date }): Promise<TextRoomRow | null> {
    const room = this.findActiveRoom(input.code);
    if (!room) {
      return null;
    }

    room.text = input.text;
    room.version += 1;
    room.updated_at = new Date(input.now);
    return copyRoom(room);
  }

  async scheduleTextRoomExpiry(code: string, expiresAt: Date, updatedAt: Date): Promise<void> {
    const room = this.findActiveRoom(code);
    if (
      !room ||
      room.updated_at > updatedAt ||
      (room.expires_at !== null && room.expires_at <= updatedAt)
    ) {
      return;
    }

    room.expires_at = new Date(expiresAt);
    room.updated_at = new Date(updatedAt);
  }

  async rearmOpenTextRooms(customExpiresAt: Date, generatedExpiresAt: Date, updatedAt: Date): Promise<void> {
    for (const room of this.rooms) {
      if (room.deleted_at === null && room.expires_at === null) {
        room.expires_at = new Date(room.kind === "custom" ? customExpiresAt : generatedExpiresAt);
        room.updated_at = new Date(updatedAt);
      }
    }
  }

  async findExpiredTextRooms(now: Date, limit = 100): Promise<TextRoomRow[]> {
    const rows = this.rooms
      .filter((room) => room.deleted_at === null && room.expires_at !== null && room.expires_at <= now)
      .sort((left, right) => left.expires_at!.getTime() - right.expires_at!.getTime())
      .slice(0, limit)
      .map(copyRoom);

    return rows;
  }

  async markTextRoomDeleted(id: string, deletedAt: Date): Promise<void> {
    const room = this.rooms.find((candidate) => candidate.id === id && candidate.deleted_at === null);
    if (!room) {
      return;
    }

    room.deleted_at = new Date(deletedAt);
  }

  updateLegacyById(id: string, text: string, updatedAt: Date): { text: string; version: number } | null {
    const room = this.rooms.find((candidate) => candidate.id === id && candidate.deleted_at === null);
    if (!room) {
      return null;
    }
    room.text = text;
    room.version += 1;
    room.updated_at = new Date(updatedAt);
    return { text: room.text, version: room.version };
  }

  readLegacyById(id: string): { text: string; version: number } | null {
    const room = this.rooms.find((candidate) => candidate.id === id && candidate.deleted_at === null);
    return room ? { text: room.text, version: room.version } : null;
  }

  markDropsStarted(id: string, startedAt: Date): boolean | null {
    const room = this.rooms.find((candidate) => candidate.id === id && candidate.deleted_at === null);
    if (!room) {
      return null;
    }
    const firstDrop = room.drops_started_at === null;
    room.drops_started_at ??= new Date(startedAt);
    return firstDrop;
  }
}

class InMemoryTextDropsRepository implements TextDropsRepository {
  private drops: TextDropRow[] = [];

  constructor(private readonly rooms: InMemoryTextRoomsRepository) {}

  async listActiveDrops(roomId: string, now: Date, limit: number): Promise<TextDropRow[]> {
    return this.active(roomId, now).slice(0, limit).map(copyDrop);
  }

  async createDrop(input: CreateTextDropInput, maxItems: number): Promise<CreateTextDropResult | null> {
    this.drops = this.drops.filter((drop) => drop.room_id !== input.roomId || drop.expires_at > input.createdAt);
    const firstDrop = this.rooms.markDropsStarted(input.roomId, input.createdAt);
    if (firstDrop === null) {
      return null;
    }
    const drop: TextDropRow = {
      id: crypto.randomUUID(),
      room_id: input.roomId,
      content: input.content,
      content_type: input.contentType,
      created_at: new Date(input.createdAt),
      expires_at: new Date(input.expiresAt),
    };
    this.drops.push(drop);
    const active = this.active(input.roomId, input.createdAt);
    const evictedIds = active.slice(maxItems).map((entry) => entry.id);
    this.drops = this.drops.filter((entry) => !evictedIds.includes(entry.id));
    const legacy = this.rooms.updateLegacyById(input.roomId, input.content, input.createdAt);
    return legacy ? {
      drop: copyDrop(drop),
      evictedIds,
      firstDrop,
      legacyText: legacy.text,
      legacyVersion: legacy.version,
    } : null;
  }

  async deleteDrop(roomId: string, dropId: string, deletedAt: Date): Promise<DeleteTextDropResult | null> {
    const drop = this.drops.find((entry) => entry.room_id === roomId && entry.id === dropId);
    if (!drop) {
      const legacy = this.rooms.readLegacyById(roomId);
      return legacy ? { deleted: false, legacyText: legacy.text, legacyVersion: legacy.version } : null;
    }
    this.drops = this.drops.filter((entry) => entry !== drop);
    const latest = this.active(roomId, deletedAt)[0]?.content ?? "";
    const legacy = this.rooms.updateLegacyById(roomId, latest, deletedAt);
    return legacy ? { deleted: true, legacyText: legacy.text, legacyVersion: legacy.version } : null;
  }

  async clearDrops(roomId: string, deletedAt: Date): Promise<ClearTextDropsResult | null> {
    const deletedIds = this.drops.filter((drop) => drop.room_id === roomId).map((drop) => drop.id);
    this.drops = this.drops.filter((drop) => drop.room_id !== roomId);
    const legacy = this.rooms.updateLegacyById(roomId, "", deletedAt);
    return legacy ? { deletedIds, legacyText: legacy.text, legacyVersion: legacy.version } : null;
  }

  async findExpiredDrops(now: Date, limit = 200): Promise<TextDropRow[]> {
    return this.drops.filter((drop) => drop.expires_at <= now).slice(0, limit).map(copyDrop);
  }

  async markDropsDeleted(ids: string[], deletedAt: Date): Promise<void> {
    const roomIds = [...new Set(this.drops.filter((drop) => ids.includes(drop.id)).map((drop) => drop.room_id))];
    this.drops = this.drops.filter((drop) => !ids.includes(drop.id));
    for (const roomId of roomIds) {
      this.rooms.updateLegacyById(roomId, this.active(roomId, deletedAt)[0]?.content ?? "", deletedAt);
    }
  }

  private active(roomId: string, now: Date): TextDropRow[] {
    return this.drops
      .filter((drop) => drop.room_id === roomId && drop.expires_at > now)
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime() || right.id.localeCompare(left.id));
  }
}

class CollectingTextFunnelMetrics implements TextFunnelMetrics {
  readonly metrics: TextMetricIncrement[] = [];

  async record(metric: TextMetricIncrement): Promise<void> {
    this.metrics.push(metric);
  }
}

class BarrierTextRoomsRepository extends InMemoryTextRoomsRepository {
  private arrivals = 0;
  private releaseBarrier: (() => void) | null = null;
  private readonly barrier = new Promise<void>((resolve) => {
    this.releaseBarrier = resolve;
  });

  override async createTextRoomWithinLimit(
    input: CreateTextRoomInput,
    maxSessions: number,
    now: Date,
  ): Promise<TextRoomCreationResult> {
    this.arrivals += 1;
    if (this.arrivals === 2) {
      this.releaseBarrier?.();
    }
    await this.barrier;

    return super.createTextRoomWithinLimit(input, maxSessions, now);
  }
}

class DelayedExpiryTextRoomsRepository extends InMemoryTextRoomsRepository {
  private readonly started = Promise.withResolvers<void>();
  private readonly released = Promise.withResolvers<void>();
  private readonly finished = Promise.withResolvers<void>();
  private readonly reactivated = Promise.withResolvers<void>();
  private delayNextExpiry = true;
  private expiryFinished = false;

  waitUntilExpiryStarts(): Promise<void> {
    return this.started.promise;
  }

  releaseExpiry(): void {
    this.released.resolve();
  }

  waitUntilExpiryFinishes(): Promise<void> {
    return this.finished.promise;
  }

  waitUntilReactivated(): Promise<void> {
    return this.reactivated.promise;
  }

  override async markTextRoomActive(code: string, updatedAt: Date): Promise<void> {
    await super.markTextRoomActive(code, updatedAt);
    if (this.expiryFinished) {
      this.reactivated.resolve();
    }
  }

  override async scheduleTextRoomExpiry(code: string, expiresAt: Date, updatedAt: Date): Promise<void> {
    if (!this.delayNextExpiry) {
      return super.scheduleTextRoomExpiry(code, expiresAt, updatedAt);
    }

    this.delayNextExpiry = false;
    this.started.resolve();
    await this.released.promise;
    await super.scheduleTextRoomExpiry(code, expiresAt, updatedAt);
    this.expiryFinished = true;
    this.finished.resolve();
  }
}

class FailOnceExpiryTextRoomsRepository extends InMemoryTextRoomsRepository {
  private readonly persisted = Promise.withResolvers<void>();
  attempts = 0;

  waitUntilPersisted(): Promise<void> {
    return this.persisted.promise;
  }

  override async scheduleTextRoomExpiry(code: string, expiresAt: Date, updatedAt: Date): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("temporary database failure");
    }

    await super.scheduleTextRoomExpiry(code, expiresAt, updatedAt);
    this.persisted.resolve();
  }
}

function copyRoom(room: TextRoomRow): TextRoomRow {
  return {
    id: room.id,
    code: room.code,
    kind: room.kind,
    text: room.text,
    version: room.version,
    pin_hash: room.pin_hash,
    created_at: new Date(room.created_at),
    updated_at: new Date(room.updated_at),
    expires_at: room.expires_at ? new Date(room.expires_at) : null,
    deleted_at: room.deleted_at ? new Date(room.deleted_at) : null,
    drops_started_at: room.drops_started_at ? new Date(room.drops_started_at) : null,
  };
}

function copyDrop(drop: TextDropRow): TextDropRow {
  return {
    id: drop.id,
    room_id: drop.room_id,
    content: drop.content,
    content_type: drop.content_type,
    created_at: new Date(drop.created_at),
    expires_at: new Date(drop.expires_at),
  };
}

async function startTestServer(
  repository: InMemoryTextRoomsRepository,
  clock: MutableClock,
  maxSessions = 500,
  metrics?: TextFunnelMetrics,
  maxDrops = 10,
) {
  const app = Fastify({ logger: false });
  const hub = new TextSessionHub({ maxClientsPerSession: 20 });
  const dropsRepository = new InMemoryTextDropsRepository(repository);
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
      maxSessions,
      codeLength: 6,
      ttlMs: 60 * 60 * 1000,
      customTtlMs: 30 * 60 * 1000,
      dropTtlMs: 12 * 60 * 60 * 1000,
      maxDrops,
      dropsRepository,
      metrics,
      now: () => new Date(clock.current),
    });
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const wsBase = `ws://127.0.0.1:${new URL(address).port}`;

  return {
    app,
    hub,
    dropsRepository,
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

async function nextMessageOfType(socket: NodeWebSocket, type: ServerMessage["type"]): Promise<ServerMessage> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const message = await nextMessage(socket);
    if (message.type === type) {
      return message;
    }
  }
  throw new Error(`did not receive ${type}`);
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
      const payload: SnapshotResponse = JSON.parse(snapshot.body);
      expect(payload).toEqual({
        text: "",
        version: 0,
        protected: false,
        kind: "generated",
        expiresAfterMinutes: 60,
        dropExpiresAfterMinutes: 720,
        maxDrops: 10,
        drops: [],
      });
    } finally {
      await server.close();
    }
  });

  test("opens or creates a clipboard with a user-selected code", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const created = await server.app.inject({ method: "POST", url: "/api/text/a/open" });
      expect(created.statusCode).toBe(200);
      expect(JSON.parse(created.body)).toEqual({
        code: "A",
        created: true,
        protected: false,
        kind: "custom",
        expiresAfterMinutes: 30,
      });

      const opened = await server.app.inject({ method: "POST", url: "/api/text/A/open" });
      expect(opened.statusCode).toBe(200);
      expect(JSON.parse(opened.body)).toEqual({
        code: "A",
        created: false,
        protected: false,
        kind: "custom",
        expiresAfterMinutes: 30,
      });

      const room = await repository.findTextRoomByCode("A");
      expect(room?.kind).toBe("custom");
      expect(room?.expires_at?.toISOString()).toBe("2026-06-23T20:30:00.000Z");
    } finally {
      await server.close();
    }
  });

  test("keeps one active room when the same clipboard is opened concurrently", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new BarrierTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const responses = await Promise.all([
        server.app.inject({ method: "POST", url: "/api/text/DEV/open" }),
        server.app.inject({ method: "POST", url: "/api/text/DEV/open" }),
      ]);
      const results = responses.map((response) => JSON.parse(response.body));

      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(results.filter((result) => result.created === true)).toHaveLength(1);
      expect(results.filter((result) => result.created === false)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  test("records aggregate funnel milestones without room codes or content", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const metrics = new CollectingTextFunnelMetrics();
    const server = await startTestServer(repository, clock, 500, metrics);

    try {
      await server.app.inject({ method: "POST", url: "/api/text/PRIVATE-CODE/open" });
      const first = server.connect("PRIVATE-CODE");
      const firstSnapshot = await expectJoined(first, 1);
      first.send(JSON.stringify({ type: "write", text: "sensitive content", baseVersion: firstSnapshot.version }));
      expect((await nextMessage(first)).type).toBe("ack");

      const second = server.connect("PRIVATE-CODE");
      await expectJoined(second, 2);

      expect(metrics.metrics).toEqual([
        { event: "open_or_create", roomKind: "custom", outcome: "created" },
        { event: "first_publish", roomKind: "custom", outcome: "success" },
        { event: "second_device", roomKind: "custom", outcome: "success" },
      ]);
      expect(JSON.stringify(metrics.metrics)).not.toContain("PRIVATE-CODE");
      expect(JSON.stringify(metrics.metrics)).not.toContain("sensitive content");
    } finally {
      await server.close();
    }
  });

  test("creates immutable drops, syncs the timeline, evicts the oldest, deletes, and clears", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock, 500, undefined, 2);

    try {
      await server.app.inject({ method: "POST", url: "/api/text/DROPS/open" });
      const author = server.connect("DROPS");
      await expectJoined(author, 1);
      const viewer = server.connect("DROPS");
      await expectJoined(viewer, 2);
      await nextMessageOfType(author, "presence");

      author.send(JSON.stringify({ type: "drop_add", content: "https://example.com/docs" }));
      const firstAuthor = await nextMessageOfType(author, "drop_added");
      const firstViewer = await nextMessageOfType(viewer, "drop_added");
      expect(firstAuthor.drop?.contentType).toBe("url");
      expect(firstViewer.drop?.id).toBe(firstAuthor.drop?.id);
      expect((await nextMessageOfType(viewer, "update")).origin).toBe("drop_sync");

      clock.current = new Date("2026-06-23T20:01:00Z");
      author.send(JSON.stringify({ type: "drop_add", content: '{"ok":true}' }));
      const second = await nextMessageOfType(author, "drop_added");
      expect(second.drop?.contentType).toBe("json");

      clock.current = new Date("2026-06-23T20:02:00Z");
      author.send(JSON.stringify({ type: "drop_add", content: "sudo systemctl restart quickdrop" }));
      const third = await nextMessageOfType(author, "drop_added");
      expect(third.drop?.contentType).toBe("command");
      const eviction = await nextMessageOfType(author, "drops_removed");
      expect(eviction.dropIds).toEqual([firstAuthor.drop!.id]);

      const snapshot = await server.app.inject({ method: "GET", url: "/api/text/DROPS" });
      const snapshotPayload = JSON.parse(snapshot.body);
      expect(snapshotPayload.drops.map((drop: { content: string }) => drop.content)).toEqual([
        "sudo systemctl restart quickdrop",
        '{"ok":true}',
      ]);

      viewer.send(JSON.stringify({ type: "drop_delete", dropId: second.drop?.id }));
      expect((await nextMessageOfType(author, "drop_deleted")).dropId).toBe(second.drop?.id);

      author.send(JSON.stringify({ type: "drops_clear" }));
      expect((await nextMessageOfType(author, "drops_cleared")).type).toBe("drops_cleared");
      const cleared = await server.app.inject({ method: "GET", url: "/api/text/DROPS" });
      expect(JSON.parse(cleared.body).drops).toEqual([]);
      expect((await repository.findTextRoomByCode("DROPS"))?.text).toBe("");
    } finally {
      await server.close();
    }
  });

  test("keeps custom clipboards alive while connected and starts a 30 minute TTL after disconnect", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      await server.app.inject({ method: "POST", url: "/api/text/A/open" });
      const socket = server.connect("A");
      await expectJoined(socket, 1);
      expect((await repository.findTextRoomByCode("A"))?.expires_at).toBeNull();

      clock.current = new Date("2026-06-23T20:05:00Z");
      await closeSocket(socket);
      await Bun.sleep(5);

      expect((await repository.findTextRoomByCode("A"))?.expires_at?.toISOString()).toBe(
        "2026-06-23T20:35:00.000Z",
      );
    } finally {
      await server.close();
    }
  });

  test("does not restore a stale expiry when a clipboard reconnects during the close write", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new DelayedExpiryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      await server.app.inject({ method: "POST", url: "/api/text/A/open" });
      const firstSocket = server.connect("A");
      await expectJoined(firstSocket, 1);

      clock.current = new Date("2026-06-23T20:05:00Z");
      await closeSocket(firstSocket);
      await repository.waitUntilExpiryStarts();

      clock.current = new Date("2026-06-23T20:06:00Z");
      const reconnectedSocket = server.connect("A");
      await expectJoined(reconnectedSocket, 1);

      repository.releaseExpiry();
      await repository.waitUntilExpiryFinishes();
      await repository.waitUntilReactivated();

      const room = await repository.findTextRoomByCode("A");
      expect(room?.expires_at).toBeNull();
      expect(room?.updated_at.toISOString()).toBe("2026-06-23T20:06:00.000Z");
    } finally {
      repository.releaseExpiry();
      await server.close();
    }
  });

  test("retries expiry persistence after a transient repository failure", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new FailOnceExpiryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      await server.app.inject({ method: "POST", url: "/api/text/A/open" });
      const socket = server.connect("A");
      await expectJoined(socket, 1);

      clock.current = new Date("2026-06-23T20:05:00Z");
      await closeSocket(socket);
      await repository.waitUntilPersisted();

      expect(repository.attempts).toBe(2);
      expect((await repository.findTextRoomByCode("A"))?.expires_at?.toISOString()).toBe(
        "2026-06-23T20:35:00.000Z",
      );
    } finally {
      await server.close();
    }
  });

  test("enforces the session limit across concurrent room creations", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new BarrierTextRoomsRepository();
    const server = await startTestServer(repository, clock, 1);

    try {
      const responses = await Promise.all([
        server.app.inject({ method: "POST", url: "/api/text/ONE/open" }),
        server.app.inject({ method: "POST", url: "/api/text/TWO/open" }),
      ]);

      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 503]);
      expect(JSON.parse(responses.find((response) => response.statusCode === 503)!.body).error).toBe("session_limit");
    } finally {
      await server.close();
    }
  });

  test("opens a protected custom clipboard only with its PIN", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const created = await server.app.inject({
        method: "POST",
        url: "/api/text/SECRET/open",
        payload: { pin: "1234" },
      });
      expect(created.statusCode).toBe(200);
      expect(JSON.parse(created.body)).toEqual({
        code: "SECRET",
        created: true,
        protected: true,
        kind: "custom",
        expiresAfterMinutes: 30,
      });

      const denied = await server.app.inject({ method: "POST", url: "/api/text/SECRET/open" });
      expect(denied.statusCode).toBe(401);
      expect(JSON.parse(denied.body).error).toBe("pin_required");

      const opened = await server.app.inject({
        method: "POST",
        url: "/api/text/SECRET/open",
        payload: { pin: "1234" },
      });
      expect(opened.statusCode).toBe(200);
      expect(JSON.parse(opened.body).created).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("rejects invalid custom clipboard codes", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const server = await startTestServer(repository, clock);

    try {
      const response = await server.app.inject({ method: "POST", url: "/api/text/A%20ROOM/open" });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe("invalid_code");
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
      const persistedPayload: SnapshotResponse = JSON.parse(persisted.body);
      expect(persistedPayload).toEqual({
        text: "select 1",
        version: 1,
        protected: false,
        kind: "generated",
        expiresAfterMinutes: 60,
        dropExpiresAfterMinutes: 720,
        maxDrops: 10,
        drops: [],
      });
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
      const protectedPayload: SnapshotResponse = JSON.parse(protectedRead.body);
      expect(protectedPayload).toEqual({
        text: "",
        version: 0,
        protected: true,
        kind: "generated",
        expiresAfterMinutes: 60,
        dropExpiresAfterMinutes: 720,
        maxDrops: 10,
        drops: [],
      });

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
      const payload: SnapshotResponse = JSON.parse(snapshot.body);
      expect(payload).toEqual({
        text: "survives restart",
        version: 1,
        protected: false,
        kind: "generated",
        expiresAfterMinutes: 60,
        dropExpiresAfterMinutes: 720,
        maxDrops: 10,
        drops: [],
      });
    } finally {
      await secondServer.close();
    }
  });

  test("rearms previously active rooms after restart", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const creation = await repository.createTextRoomWithinLimit({
      code: "ROOM01",
      kind: "generated",
      text: "",
      version: 0,
      createdAt: clock.current,
      updatedAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 60 * 60 * 1000),
    }, 500, clock.current);

    if (creation.status !== "created") {
      throw new Error("expected room to be created");
    }
    const created = creation.room;
    const customCreation = await repository.createTextRoomWithinLimit({
      code: "CUSTOM",
      kind: "custom",
      text: "",
      version: 0,
      createdAt: clock.current,
      updatedAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 30 * 60 * 1000),
    }, 500, clock.current);
    if (customCreation.status !== "created") {
      throw new Error("expected custom room to be created");
    }

    await repository.markTextRoomActive(created.code, clock.current);
    await repository.markTextRoomActive(customCreation.room.code, clock.current);
    const active = await repository.findTextRoomByCode(created.code);
    expect(active?.expires_at).toBeNull();

    clock.current = new Date("2026-06-23T20:05:00Z");
    await rearmTextRoomsAfterRestart(
      60 * 60 * 1000,
      30 * 60 * 1000,
      repository,
      () => new Date(clock.current),
    );

    const rearmed = await repository.findTextRoomByCode(created.code);
    expect(rearmed?.expires_at?.toISOString()).toBe("2026-06-23T21:05:00.000Z");
    const rearmedCustom = await repository.findTextRoomByCode(customCreation.room.code);
    expect(rearmedCustom?.expires_at?.toISOString()).toBe("2026-06-23T20:35:00.000Z");
  });

  test("marks expired rooms as deleted during the database sweep", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const creation = await repository.createTextRoomWithinLimit({
      code: "ROOM01",
      kind: "generated",
      text: "expired",
      version: 0,
      createdAt: new Date("2026-06-23T18:00:00Z"),
      updatedAt: new Date("2026-06-23T18:00:00Z"),
      expiresAt: new Date("2026-06-23T19:00:00Z"),
    }, 500, clock.current);

    if (creation.status !== "created") {
      throw new Error("expected room to be created");
    }
    const created = creation.room;

    const timer = startTextSessionSweep(repository, 5, () => new Date(clock.current));
    await Bun.sleep(20);
    clearInterval(timer);

    expect(await repository.findTextRoomByCode("ROOM01")).toBeNull();

    const reused = await repository.createTextRoomWithinLimit({
      code: "ROOM01",
      kind: "generated",
      text: "new room",
      version: 0,
      createdAt: clock.current,
      updatedAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 60 * 60 * 1000),
    }, 500, clock.current);

    expect(reused.status).toBe("created");
    expect(reused.status === "created" ? reused.room.id : null).not.toBe(created.id);

    // A delayed deletion from another request must target only the expired row.
    await repository.markTextRoomDeleted(created.id, clock.current);
    expect((await repository.findTextRoomByCode("ROOM01"))?.text).toBe("new room");
  });

  test("hard-deletes expired drops and clears the legacy document during the sweep", async () => {
    const clock = { current: new Date("2026-06-23T20:00:00Z") };
    const repository = new InMemoryTextRoomsRepository();
    const creation = await repository.createTextRoomWithinLimit({
      code: "DROP01",
      kind: "custom",
      text: "",
      version: 0,
      createdAt: clock.current,
      updatedAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 60 * 60 * 1000),
    }, 500, clock.current);
    if (creation.status !== "created") {
      throw new Error("expected room to be created");
    }
    const dropsRepository = new InMemoryTextDropsRepository(repository);
    await dropsRepository.createDrop({
      roomId: creation.room.id,
      content: "temporary",
      contentType: "text",
      createdAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 30 * 1000),
    }, 10);

    clock.current = new Date("2026-06-23T20:01:00Z");
    const timer = startTextDropSweep(dropsRepository, 5, () => new Date(clock.current));
    await Bun.sleep(20);
    clearInterval(timer);

    expect(await dropsRepository.listActiveDrops(creation.room.id, clock.current, 10)).toEqual([]);
    expect((await repository.findTextRoomByCode("DROP01"))?.text).toBe("");
  });
});
