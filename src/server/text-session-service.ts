import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import { generateSessionCode, isValidCustomSessionCode, normalizeSessionCode } from "./ids";
import { isTauriWebviewOrigin } from "./native-origins";
import {
  clearRoomAccessCookie,
  createRoomAccessCookie,
  createRoomAccessToken,
  type RoomAccessCheck,
  verifyRoomAccessCookie,
  verifyRoomAccessToken,
} from "./text-room-access";
import type { TextSessionHub } from "./text-session-hub";
import type { TextFunnelMetrics } from "./text-funnel-metrics";
import { classifyTextDrop } from "./text-drop-content";
import type { TextDropRow, TextDropsRepository } from "./text-drops-repository";
import { textDropsRepository } from "./text-drops-repository";
import { ROOM_PIN_MAX_LENGTH, ROOM_PIN_MIN_LENGTH, hashRoomPin, normalizeRoomPin, verifyRoomPin } from "./text-room-pin";
import type { TextRoomRow, TextRoomsRepository } from "./text-rooms-repository";
import { textRoomsRepository } from "./text-rooms-repository";

const liveSockets = new WeakSet<WebSocket>();
const CODE_GENERATION_ATTEMPTS = 8;
const EXPIRED_SWEEP_LIMIT = 100;
const POINTER_COORD_PRECISION = 1000;
const TEXT_ROOM_LIFECYCLE_RETRY_MS = 1000;
const EXPIRED_DROP_SWEEP_LIMIT = 200;

export type TextSessionRouteDeps = {
  hub: TextSessionHub;
  repository?: TextRoomsRepository;
  maxBytes: number;
  maxSessions: number;
  codeLength: number;
  ttlMs: number;
  customTtlMs: number;
  dropTtlMs: number;
  maxDrops: number;
  dropsRepository?: TextDropsRepository;
  metrics?: TextFunnelMetrics;
  now?: () => Date;
};

type PinParseResult =
  | { ok: true; pin: string | null }
  | { ok: false; message: string };

type ProtectedRoomAuthResult =
  | { ok: true; expiresAt: Date | null }
  | { ok: false; statusCode: number; error: "pin_required" | "pin_invalid" | "invalid_token"; message: string };

export function registerTextSessionRoutes(app: FastifyInstance, deps: TextSessionRouteDeps): void {
  const repository = deps.repository ?? textRoomsRepository;
  const dropsRepository = deps.dropsRepository ?? textDropsRepository;
  const metrics = deps.metrics ?? { record: async () => {} };
  const now = deps.now ?? (() => new Date());
  const lifecycleTargets = new Map<string, { closedAt: Date; expiryMs: number } | null>();
  const lifecycleReconciling = new Set<string>();
  let lifecycleStopped = false;

  app.addHook("onClose", async () => {
    lifecycleStopped = true;
    lifecycleTargets.clear();
  });

  const reconcileLifecycle = (code: string) => {
    if (lifecycleStopped || lifecycleReconciling.has(code)) {
      return;
    }

    lifecycleReconciling.add(code);
    void (async () => {
      try {
        while (!lifecycleStopped) {
          const target = lifecycleTargets.get(code);
          if (target === undefined) {
            return;
          }

          try {
            if (target === null) {
              await repository.markTextRoomActive(code, now());
            } else {
              await repository.scheduleTextRoomExpiry(
                code,
                new Date(target.closedAt.getTime() + target.expiryMs),
                target.closedAt,
              );
            }
          } catch {
            app.log.error("Failed to persist text room lifecycle; retrying.");
            await lifecycleRetryDelay(TEXT_ROOM_LIFECYCLE_RETRY_MS);
            continue;
          }

          if (lifecycleTargets.get(code) === target) {
            lifecycleTargets.delete(code);
            return;
          }
        }
      } finally {
        lifecycleReconciling.delete(code);
      }
    })();
  };

  app.post(
    "/api/text",
    { preHandler: app.rateLimit({ max: 60, timeWindow: "1 hour" }) },
    async (request, reply) => {
      const parsedPin = parsePinFromBody(request.body);
      if (!parsedPin.ok) {
        reply.code(400).send({ error: "pin_invalid", message: parsedPin.message });
        return;
      }

      const pinHash = parsedPin.pin ? await hashRoomPin(parsedPin.pin) : null;

      for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
        const createdAt = now();
        const code = generateSessionCode(deps.codeLength);
        const creation = await repository.createTextRoomWithinLimit(
          {
            code,
            kind: "generated",
            text: "",
            version: 0,
            pinHash,
            createdAt,
            updatedAt: createdAt,
            expiresAt: new Date(createdAt.getTime() + deps.ttlMs),
          },
          deps.maxSessions,
          createdAt,
        );

        if (creation.status === "limit") {
          reply.code(503).send({ error: "session_limit", message: "Room limit reached. Try again later." });
          return;
        }

        if (creation.status === "created") {
          const room = creation.room;
          const access = room.pin_hash
            ? grantProtectedRoomAccess(room, request, reply, deps.ttlMs, createdAt)
            : {};

          void metrics.record({ event: "open_or_create", roomKind: "generated", outcome: "created" });
          return { ...roomAccessPayload(room, undefined, deps), ...access };
        }
      }

      reply.code(503).send({ error: "code_exhausted", message: "Could not reserve a room code." });
    },
  );

  app.post<{ Params: { code: string } }>(
    "/api/text/:code/open",
    { preHandler: app.rateLimit({ max: 60, timeWindow: "1 hour" }) },
    async (request, reply) => {
      const code = normalizeSessionCode(request.params.code);
      if (!isValidCustomSessionCode(code)) {
        reply.code(400).send({
          error: "invalid_code",
          message: "Use 1 to 16 letters, numbers, hyphens, or underscores.",
        });
        return;
      }

      const parsedPin = parsePinFromBody(request.body);
      if (!parsedPin.ok) {
        reply.code(400).send({ error: "pin_invalid", message: parsedPin.message });
        return;
      }

      let room = await repository.findTextRoomByCode(code);
      if (room && isExpired(room, now(), deps.hub.clientCount(code))) {
        await repository.markTextRoomDeleted(room.id, now());
        room = null;
      }

      if (!room) {
        const createdAt = now();
        const pinHash = parsedPin.pin ? await hashRoomPin(parsedPin.pin) : null;
        const creation = await repository.createTextRoomWithinLimit(
          {
            code,
            kind: "custom",
            text: "",
            version: 0,
            pinHash,
            createdAt,
            updatedAt: createdAt,
            expiresAt: new Date(createdAt.getTime() + deps.customTtlMs),
          },
          deps.maxSessions,
          createdAt,
        );

        if (creation.status === "limit") {
          reply.code(503).send({ error: "session_limit", message: "Room limit reached. Try again later." });
          return;
        }

        if (creation.status === "created") {
          room = creation.room;
          const access = room.pin_hash
            ? grantProtectedRoomAccess(room, request, reply, deps.ttlMs, createdAt)
            : {};

          void metrics.record({ event: "open_or_create", roomKind: "custom", outcome: "created" });
          return { ...roomAccessPayload(room, true, deps), ...access };
        }

        // A concurrent request won the active-code uniqueness race.
        room = await repository.findTextRoomByCode(code);
        if (!room) {
          reply.code(503).send({ error: "create_failed", message: "Could not open the clipboard." });
          return;
        }
      }

      if (!room.pin_hash) {
        void metrics.record({ event: "open_or_create", roomKind: room.kind, outcome: "opened" });
        return roomAccessPayload(room, false, deps);
      }

      const cookieAccess = requireProtectedRoomAccess(room, request, now());
      if (cookieAccess.ok) {
        const access = grantProtectedRoomAccess(room, request, reply, deps.ttlMs, now());
        void metrics.record({ event: "open_or_create", roomKind: room.kind, outcome: "opened" });
        return {
          ...roomAccessPayload(room, false, deps),
          ...access,
        };
      }

      if (!parsedPin.pin) {
        reply.code(401).send({ error: "pin_required", message: "Clipboard is PIN-protected." });
        return;
      }

      if (!(await verifyRoomPin(parsedPin.pin, room.pin_hash))) {
        reply.code(401).send({ error: "pin_invalid", message: "Invalid PIN." });
        return;
      }

      const grantedAt = now();
      const access = grantProtectedRoomAccess(room, request, reply, deps.ttlMs, grantedAt);
      void metrics.record({ event: "open_or_create", roomKind: room.kind, outcome: "opened" });
      return {
        ...roomAccessPayload(room, false, deps),
        ...access,
      };
    },
  );

  app.post<{ Params: { code: string } }>(
    "/api/text/:code/access",
    { preHandler: app.rateLimit({ max: 20, timeWindow: "15 minutes" }) },
    async (request, reply) => {
      const code = normalizeSessionCode(request.params.code);
      const room = await repository.findTextRoomByCode(code);

      if (!room || isExpired(room, now(), deps.hub.clientCount(code))) {
        reply.code(404).send({ error: "not_found", message: "Room not found." });
        return;
      }

      const parsedPin = parsePinFromBody(request.body);
      if (!parsedPin.ok) {
        reply.code(400).send({ error: "pin_invalid", message: parsedPin.message });
        return;
      }

      if (!room.pin_hash) {
        return roomAccessPayload(room, undefined, deps);
      }

      const cookieAccess = requireProtectedRoomAccess(room, request, now());
      if (cookieAccess.ok) {
        const access = grantProtectedRoomAccess(room, request, reply, deps.ttlMs, now());
        return {
          ...roomAccessPayload(room, undefined, deps),
          ...access,
        };
      }

      if (!parsedPin.pin) {
        reply.code(401).send({ error: "pin_required", message: "Room is PIN-protected." });
        return;
      }

      if (!(await verifyRoomPin(parsedPin.pin, room.pin_hash))) {
        reply.code(401).send({ error: "pin_invalid", message: "Invalid PIN." });
        return;
      }

      const grantedAt = now();
      const access = grantProtectedRoomAccess(room, request, reply, deps.ttlMs, grantedAt);
      return {
        ...roomAccessPayload(room, undefined, deps),
        ...access,
      };
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/text/:code",
    { preHandler: app.rateLimit({ max: 120, timeWindow: "15 minutes" }) },
    async (request, reply) => {
      const code = normalizeSessionCode(request.params.code);
      const room = await repository.findTextRoomByCode(code);

      if (!room || isExpired(room, now(), deps.hub.clientCount(code))) {
        reply.code(404).send({ error: "not_found", message: "Room not found." });
        return;
      }

      const access = requireProtectedRoomAccess(room, request, now());
      if (!access.ok) {
        if (room.pin_hash) {
          reply.header("set-cookie", clearRoomAccessCookie(code, isSecureRequest(request)));
        }
        reply.code(access.statusCode).send({ error: access.error, message: access.message });
        return;
      }

      return {
        text: room.text,
        version: room.version,
        drops: (await dropsRepository.listActiveDrops(room.id, now(), deps.maxDrops)).map(dropPayload),
        protected: room.pin_hash !== null,
        kind: room.kind,
        dropExpiresAfterMinutes: Math.round(deps.dropTtlMs / (60 * 1000)),
        maxDrops: deps.maxDrops,
        ...roomExpiryState(room, deps),
      };
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/text/:code/ws",
    {
      websocket: true,
      preHandler: app.rateLimit({ max: 120, timeWindow: "15 minutes" }),
    },
    async (socket, request) => {
      const code = normalizeSessionCode(request.params.code);
      const room = await repository.findTextRoomByCode(code);

      if (!room || isExpired(room, now(), deps.hub.clientCount(code))) {
        socket.send(JSON.stringify({ type: "error", error: "not_found", message: "Room not found." }));
        socket.close(1008, "not_found");
        return;
      }

      const access = requireProtectedRoomAccess(room, request, now());
      if (!access.ok) {
        socket.send(JSON.stringify({ type: "error", error: access.error, message: access.message }));
        socket.close(1008, access.error);
        return;
      }

      const clientId = randomUUID();
      const joined = deps.hub.join(code, {
        id: clientId,
        send: (data) => {
          try {
            socket.send(data);
          } catch {
            // Socket may be mid-close; dropping the frame is harmless.
          }
        },
        close: (closeCode, reason) => {
          try {
            socket.close(closeCode, reason);
          } catch {
            // Socket may already be closed.
          }
        },
      });

      if (!joined.ok) {
        socket.send(JSON.stringify({ type: "error", error: "room_full", message: "Room is full." }));
        socket.close(1008, joined.reason);
        return;
      }

      let closed = false;
      let authExpiryTimer: ReturnType<typeof setTimeout> | null = null;
      const onClose = () => {
        if (closed) {
          return;
        }

        closed = true;
        if (authExpiryTimer) {
          clearTimeout(authExpiryTimer);
          authExpiryTimer = null;
        }
        liveSockets.delete(socket);
        const remaining = deps.hub.leave(code, clientId);
        deps.hub.broadcast(code, JSON.stringify({ type: "peer_left", by: clientId }));
        deps.hub.broadcast(code, JSON.stringify({ type: "presence", count: remaining }));

        if (remaining === 0) {
          const closedAt = now();
          lifecycleTargets.set(code, { closedAt, expiryMs: roomExpiryMs(room, deps) });
          reconcileLifecycle(code);
        } else {
          deps.hub.broadcast(code, JSON.stringify({
            type: "lifecycle",
            expiresAfterMinutes: roomExpiryMinutes(room, deps),
            expiresAt: null,
            presence: remaining,
          }));
        }
      };

      socket.on("close", onClose);
      socket.on("error", onClose);
      liveSockets.add(socket);
      socket.on("pong", () => liveSockets.add(socket));

      if (joined.clientCount === 1) {
        lifecycleTargets.set(code, null);
        await repository.markTextRoomActive(code, now());
        if (closed) {
          return;
        }
      }
      if (joined.clientCount === 2) {
        void metrics.record({ event: "second_device", roomKind: room.kind, outcome: "success" });
      }

      const drops = await dropsRepository.listActiveDrops(room.id, now(), deps.maxDrops);
      if (closed) {
        return;
      }
      socket.send(JSON.stringify({
        type: "snapshot",
        text: room.text,
        version: room.version,
        drops: drops.map(dropPayload),
        clientId,
        kind: room.kind,
        dropExpiresAfterMinutes: Math.round(deps.dropTtlMs / (60 * 1000)),
        maxDrops: deps.maxDrops,
        ...roomExpiryState(room, deps),
      }));
      deps.hub.broadcast(code, JSON.stringify({ type: "presence", count: joined.clientCount }));
      if (joined.clientCount > 1) {
        deps.hub.broadcast(code, JSON.stringify({
          type: "lifecycle",
          ...roomExpiryState(room, deps),
        }), clientId);
      }

      if (access.expiresAt) {
        const delayMs = access.expiresAt.getTime() - now().getTime();
        if (delayMs <= 0) {
          socket.send(JSON.stringify({ type: "error", error: "invalid_token", message: "Room access expired. Enter the PIN again." }));
          socket.close(1008, "invalid_token");
          return;
        }

        authExpiryTimer = setTimeout(() => {
          socket.send(JSON.stringify({ type: "error", error: "invalid_token", message: "Room access expired. Enter the PIN again." }));
          socket.close(1008, "invalid_token");
        }, delayMs);
      }

      socket.on("message", (raw: RawData) => {
        void handleRealtimeMessage(raw, room, clientId, socket, deps, repository, dropsRepository, now).catch(() => {
          app.log.error("Failed to process a text room realtime operation.");
          try {
            socket.send(JSON.stringify({ type: "error", error: "operation_failed", message: "Could not complete the operation." }));
          } catch {
            // The socket may have closed while the operation was running.
          }
        });
      });
    },
  );
}

function lifecycleRetryDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function handleRealtimeMessage(
  raw: RawData,
  room: TextRoomRow,
  clientId: string,
  socket: WebSocket,
  deps: TextSessionRouteDeps,
  repository: TextRoomsRepository,
  dropsRepository: TextDropsRepository,
  now: () => Date,
): Promise<void> {
  const message = parseRealtimeMessage(raw);
  const code = room.code;

  if (!message) {
    return;
  }

  if (message.type === "typing") {
    deps.hub.broadcast(
      code,
      JSON.stringify({ type: "typing", by: clientId, active: message.active }),
      clientId,
    );
    return;
  }

  if (message.type === "pointer") {
    deps.hub.broadcast(
      code,
      JSON.stringify({
        type: "pointer",
        by: clientId,
        visible: message.visible,
        ...(message.visible ? { x: message.x, y: message.y } : {}),
      }),
      clientId,
    );
    return;
  }

  if (message.type === "drop_add") {
    if (Buffer.byteLength(message.content, "utf8") > deps.maxBytes) {
      socket.send(JSON.stringify({ type: "error", error: "too_large", message: "Text exceeds the per-item limit." }));
      return;
    }

    if (message.content.trim().length === 0) {
      socket.send(JSON.stringify({ type: "error", error: "empty_drop", message: "Type or paste text before sending." }));
      return;
    }

    const createdAt = now();
    const result = await dropsRepository.createDrop(
      {
        roomId: room.id,
        content: message.content,
        contentType: classifyTextDrop(message.content),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + deps.dropTtlMs),
      },
      deps.maxDrops,
    );
    if (!result) {
      socket.send(JSON.stringify({ type: "error", error: "not_found", message: "Room not found." }));
      return;
    }

    deps.hub.broadcast(code, JSON.stringify({ type: "drop_added", drop: dropPayload(result.drop), by: clientId }));
    if (result.evictedIds.length > 0) {
      deps.hub.broadcast(code, JSON.stringify({ type: "drops_removed", dropIds: result.evictedIds }));
    }
    deps.hub.broadcast(
      code,
      JSON.stringify({ type: "update", text: result.legacyText, version: result.legacyVersion, by: clientId, origin: "drop_sync" }),
      clientId,
    );
    if (result.firstDrop) {
      void deps.metrics?.record({ event: "first_publish", roomKind: room.kind, outcome: "success" });
    }
    return;
  }

  if (message.type === "drop_update") {
    if (Buffer.byteLength(message.content, "utf8") > deps.maxBytes) {
      socket.send(JSON.stringify({ type: "error", error: "too_large", message: "Text exceeds the per-item limit." }));
      return;
    }
    if (message.content.trim().length === 0) {
      socket.send(JSON.stringify({ type: "error", error: "empty_drop", message: "The item cannot be empty." }));
      return;
    }

    const result = await dropsRepository.updateDrop({
      roomId: room.id,
      dropId: message.dropId,
      content: message.content,
      contentType: classifyTextDrop(message.content),
      updatedAt: now(),
    });
    if (!result) {
      socket.send(JSON.stringify({ type: "error", error: "not_found", message: "Room not found." }));
      return;
    }
    if (!result.drop) {
      socket.send(JSON.stringify({ type: "error", error: "drop_not_found", message: "Item not found." }));
      return;
    }

    deps.hub.broadcast(
      code,
      JSON.stringify({ type: "drop_updated", drop: dropPayload(result.drop), by: clientId }),
    );
    deps.hub.broadcast(
      code,
      JSON.stringify({ type: "update", text: result.legacyText, version: result.legacyVersion, by: clientId, origin: "drop_sync" }),
      clientId,
    );
    return;
  }

  if (message.type === "drop_delete") {
    const result = await dropsRepository.deleteDrop(room.id, message.dropId, now());
    if (!result) {
      socket.send(JSON.stringify({ type: "error", error: "not_found", message: "Room not found." }));
      return;
    }
    if (!result.deleted) {
      socket.send(JSON.stringify({ type: "error", error: "drop_not_found", message: "Item not found." }));
      return;
    }

    deps.hub.broadcast(code, JSON.stringify({ type: "drop_deleted", dropId: message.dropId }));
    deps.hub.broadcast(
      code,
      JSON.stringify({ type: "update", text: result.legacyText, version: result.legacyVersion, by: clientId, origin: "drop_sync" }),
      clientId,
    );
    return;
  }

  if (message.type === "drops_clear") {
    const result = await dropsRepository.clearDrops(room.id, now());
    if (!result) {
      socket.send(JSON.stringify({ type: "error", error: "not_found", message: "Room not found." }));
      return;
    }

    deps.hub.broadcast(code, JSON.stringify({ type: "drops_cleared" }));
    deps.hub.broadcast(
      code,
      JSON.stringify({ type: "update", text: result.legacyText, version: result.legacyVersion, by: clientId, origin: "drop_sync" }),
      clientId,
    );
    return;
  }

  if (Buffer.byteLength(message.text, "utf8") > deps.maxBytes) {
    socket.send(JSON.stringify({ type: "error", error: "too_large", message: "Text exceeds the room limit." }));
    return;
  }

  const updated = await repository.updateTextRoomText({ code, text: message.text, now: now() });

  if (!updated || isExpired(updated, now(), deps.hub.clientCount(code))) {
    socket.send(JSON.stringify({ type: "error", error: "not_found", message: "Room not found." }));
    return;
  }

  if (updated.version === 1 && updated.text.length > 0) {
    void deps.metrics?.record({
      event: "first_publish",
      roomKind: updated.kind,
      outcome: "success",
    });
  }

  deps.hub.broadcast(
    code,
    JSON.stringify({ type: "update", text: updated.text, version: updated.version, by: clientId }),
    clientId,
  );
  socket.send(JSON.stringify({ type: "ack", version: updated.version }));
}

function parseRealtimeMessage(raw: RawData):
  | { type: "write"; text: string }
  | { type: "drop_add"; content: string }
  | { type: "drop_update"; dropId: string; content: string }
  | { type: "drop_delete"; dropId: string }
  | { type: "drops_clear" }
  | { type: "typing"; active: boolean }
  | { type: "pointer"; visible: boolean; x?: number; y?: number }
  | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    return null;
  }

  if (parsed.type === "write" && "text" in parsed && typeof parsed.text === "string") {
    return { type: "write", text: parsed.text };
  }

  if (parsed.type === "drop_add" && "content" in parsed && typeof parsed.content === "string") {
    return { type: "drop_add", content: parsed.content };
  }

  if (
    parsed.type === "drop_update" &&
    "dropId" in parsed &&
    typeof parsed.dropId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.dropId) &&
    "content" in parsed &&
    typeof parsed.content === "string"
  ) {
    return { type: "drop_update", dropId: parsed.dropId, content: parsed.content };
  }

  if (
    parsed.type === "drop_delete" &&
    "dropId" in parsed &&
    typeof parsed.dropId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.dropId)
  ) {
    return { type: "drop_delete", dropId: parsed.dropId };
  }

  if (parsed.type === "drops_clear") {
    return { type: "drops_clear" };
  }

  if (parsed.type === "typing" && "active" in parsed && typeof parsed.active === "boolean") {
    return { type: "typing", active: parsed.active };
  }

  if (parsed.type === "pointer" && "visible" in parsed && typeof parsed.visible === "boolean") {
    if (!parsed.visible) {
      return { type: "pointer", visible: false };
    }

    if (
      "x" in parsed &&
      "y" in parsed &&
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return {
        type: "pointer",
        visible: true,
        x: clampNormalized(parsed.x),
        y: clampNormalized(parsed.y),
      };
    }
  }

  return null;
}

function clampNormalized(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * POINTER_COORD_PRECISION) / POINTER_COORD_PRECISION;
}

function roomExpiryMs(room: TextRoomRow, deps: TextSessionRouteDeps): number {
  return room.kind === "custom" ? deps.customTtlMs : deps.ttlMs;
}

function roomExpiryMinutes(room: TextRoomRow, deps: TextSessionRouteDeps): number {
  return Math.round(roomExpiryMs(room, deps) / (60 * 1000));
}

function roomExpiryState(room: TextRoomRow, deps: TextSessionRouteDeps) {
  const presence = deps.hub.clientCount(room.code);
  return {
    expiresAfterMinutes: roomExpiryMinutes(room, deps),
    expiresAt: presence > 0 ? null : room.expires_at?.toISOString() ?? null,
    presence,
  };
}

function roomAccessPayload(room: TextRoomRow, created: boolean | undefined, deps: TextSessionRouteDeps) {
  return {
    code: room.code,
    protected: room.pin_hash !== null,
    kind: room.kind,
    ...roomExpiryState(room, deps),
    ...(created === undefined ? {} : { created }),
  };
}

function dropPayload(drop: TextDropRow) {
  return {
    id: drop.id,
    content: drop.content,
    contentType: drop.content_type === "text" ? classifyTextDrop(drop.content) : drop.content_type,
    createdAt: drop.created_at.toISOString(),
    expiresAt: drop.expires_at.toISOString(),
  };
}

function parsePinFromBody(body: unknown): PinParseResult {
  if (body === null || body === undefined) {
    return { ok: true, pin: null };
  }

  if (typeof body !== "object") {
    return { ok: false, message: "Invalid PIN request body." };
  }

  const pin = "pin" in body ? normalizeRoomPin(body.pin) : null;
  if (pin === null) {
    return { ok: true, pin: null };
  }

  if (pin.length < ROOM_PIN_MIN_LENGTH || pin.length > ROOM_PIN_MAX_LENGTH) {
    return {
      ok: false,
      message: `PIN must be between ${ROOM_PIN_MIN_LENGTH} and ${ROOM_PIN_MAX_LENGTH} characters.`,
    };
  }

  return { ok: true, pin };
}

function grantProtectedRoomAccess(
  room: TextRoomRow,
  request: FastifyRequest,
  reply: FastifyReply,
  ttlMs: number,
  grantedAt: Date,
) {
  if (!room.pin_hash) {
    return { accessToken: null, accessExpiresAt: null };
  }
  const grant = createRoomAccessToken({
    code: room.code,
    pinHash: room.pin_hash,
    ttlMs,
    now: grantedAt,
  });
  reply.header(
    "set-cookie",
    createRoomAccessCookie({
      code: room.code,
      pinHash: room.pin_hash,
      ttlMs,
      now: grantedAt,
      secure: isSecureRequest(request),
      token: grant.token,
    }),
  );
  const returnNativeToken =
    request.headers["x-quickdrop-native"] === "1" &&
    isTauriWebviewOrigin(request.headers.origin);
  return {
    ...(returnNativeToken ? { accessToken: grant.token } : {}),
    accessExpiresAt: grant.expiresAt.toISOString(),
  };
}

function requireProtectedRoomAccess(room: TextRoomRow, request: FastifyRequest, currentTime: Date): ProtectedRoomAuthResult {
  if (!room.pin_hash) {
    return { ok: true, expiresAt: null };
  }

  const requestedProtocols = request.headers["sec-websocket-protocol"];
  const accessToken = typeof requestedProtocols === "string"
    ? requestedProtocols
      .split(",")
      .map((protocol) => protocol.trim())
      .find((protocol) => protocol.startsWith("quickdrop-access."))
      ?.slice("quickdrop-access.".length)
    : undefined;
  const access = accessToken
    ? verifyRoomAccessToken({ code: room.code, pinHash: room.pin_hash, token: accessToken, now: currentTime })
    : verifyRoomAccessCookie({
      code: room.code,
      pinHash: room.pin_hash,
      cookieHeader: typeof request.headers.cookie === "string" ? request.headers.cookie : undefined,
      now: currentTime,
    });

  return mapAccessCheck(access);
}

function mapAccessCheck(access: RoomAccessCheck): ProtectedRoomAuthResult {
  if (access.ok) {
    return { ok: true, expiresAt: access.expiresAt };
  }

  if (access.error === "missing") {
    return { ok: false, statusCode: 401, error: "pin_required", message: "Room is PIN-protected." };
  }

  return {
    ok: false,
    statusCode: 401,
    error: "invalid_token",
    message: "Room access expired. Enter the PIN again.",
  };
}

function isExpired(room: TextRoomRow, currentTime: Date, activeClientCount: number): boolean {
  return activeClientCount === 0 && room.expires_at !== null && room.expires_at <= currentTime;
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers["x-forwarded-proto"];
  return request.protocol === "https" || (typeof forwardedProto === "string" && forwardedProto.split(",")[0]?.trim() === "https");
}

export async function rearmTextRoomsAfterRestart(
  generatedTtlMs: number,
  customTtlMs: number,
  repository: TextRoomsRepository = textRoomsRepository,
  now: () => Date = () => new Date(),
): Promise<void> {
  const reopenedAt = now();
  await repository.rearmOpenTextRooms(
    new Date(reopenedAt.getTime() + customTtlMs),
    new Date(reopenedAt.getTime() + generatedTtlMs),
    reopenedAt,
  );
}

export function startTextSessionSweep(
  repository: TextRoomsRepository = textRoomsRepository,
  intervalMs = 60 * 1000,
  now: () => Date = () => new Date(),
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepExpiredRooms(repository, now());
  }, intervalMs);

  timer.unref();
  return timer;
}

export function startTextDropSweep(
  repository: TextDropsRepository = textDropsRepository,
  intervalMs = 60 * 1000,
  now: () => Date = () => new Date(),
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepExpiredDrops(repository, now()).catch(() => {
      console.error("Failed to sweep expired text drops.");
    });
  }, intervalMs);

  timer.unref();
  return timer;
}

async function sweepExpiredRooms(repository: TextRoomsRepository, currentTime: Date): Promise<void> {
  const expiredRooms = await repository.findExpiredTextRooms(currentTime, EXPIRED_SWEEP_LIMIT);

  for (const room of expiredRooms) {
    await repository.markTextRoomDeleted(room.id, currentTime);
  }
}

async function sweepExpiredDrops(repository: TextDropsRepository, currentTime: Date): Promise<void> {
  while (true) {
    const expiredDrops = await repository.findExpiredDrops(currentTime, EXPIRED_DROP_SWEEP_LIMIT);
    await repository.markDropsDeleted(expiredDrops.map((drop) => drop.id), currentTime);
    if (expiredDrops.length < EXPIRED_DROP_SWEEP_LIMIT) {
      return;
    }
  }
}

export function startTextSessionHeartbeat(app: FastifyInstance, intervalMs = 30 * 1000): NodeJS.Timeout {
  const timer = setInterval(() => {
    for (const socket of app.websocketServer.clients) {
      if (!liveSockets.has(socket)) {
        socket.terminate();
        continue;
      }

      liveSockets.delete(socket);
      socket.ping();
    }
  }, intervalMs);

  timer.unref();
  return timer;
}
