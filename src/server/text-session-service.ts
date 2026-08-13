import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import { generateSessionCode, isValidCustomSessionCode, normalizeSessionCode } from "./ids";
import { clearRoomAccessCookie, createRoomAccessCookie, type RoomAccessCheck, verifyRoomAccessCookie } from "./text-room-access";
import type { TextSessionHub } from "./text-session-hub";
import type { TextFunnelMetrics } from "./text-funnel-metrics";
import { ROOM_PIN_MAX_LENGTH, ROOM_PIN_MIN_LENGTH, hashRoomPin, normalizeRoomPin, verifyRoomPin } from "./text-room-pin";
import type { TextRoomRow, TextRoomsRepository } from "./text-rooms-repository";
import { textRoomsRepository } from "./text-rooms-repository";

const liveSockets = new WeakSet<WebSocket>();
const CODE_GENERATION_ATTEMPTS = 8;
const EXPIRED_SWEEP_LIMIT = 100;
const POINTER_COORD_PRECISION = 1000;
const TEXT_ROOM_LIFECYCLE_RETRY_MS = 1000;

export type TextSessionRouteDeps = {
  hub: TextSessionHub;
  repository?: TextRoomsRepository;
  maxBytes: number;
  maxSessions: number;
  codeLength: number;
  ttlMs: number;
  customTtlMs: number;
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
          reply.code(503).send({ error: "session_limit", message: "Limite de salas atingido. Tente mais tarde." });
          return;
        }

        if (creation.status === "created") {
          const room = creation.room;
          if (room.pin_hash) {
            reply.header(
              "set-cookie",
              createRoomAccessCookie({
                code: room.code,
                pinHash: room.pin_hash,
                ttlMs: deps.ttlMs,
                now: createdAt,
                secure: isSecureRequest(request),
              }),
            );
          }

          void metrics.record({ event: "open_or_create", roomKind: "generated", outcome: "created" });
          return roomAccessPayload(room, undefined, deps);
        }
      }

      reply.code(503).send({ error: "code_exhausted", message: "Não foi possível reservar um código de sala." });
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
          message: "Use de 1 a 16 letras, números, hífen ou sublinhado.",
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
          reply.code(503).send({ error: "session_limit", message: "Limite de salas atingido. Tente mais tarde." });
          return;
        }

        if (creation.status === "created") {
          room = creation.room;
          if (room.pin_hash) {
            reply.header(
              "set-cookie",
              createRoomAccessCookie({
                code,
                pinHash: room.pin_hash,
                ttlMs: deps.ttlMs,
                now: createdAt,
                secure: isSecureRequest(request),
              }),
            );
          }

          void metrics.record({ event: "open_or_create", roomKind: "custom", outcome: "created" });
          return roomAccessPayload(room, true, deps);
        }

        // A concurrent request won the active-code uniqueness race.
        room = await repository.findTextRoomByCode(code);
        if (!room) {
          reply.code(503).send({ error: "create_failed", message: "Não foi possível abrir o clipboard." });
          return;
        }
      }

      if (!room.pin_hash) {
        void metrics.record({ event: "open_or_create", roomKind: room.kind, outcome: "opened" });
        return roomAccessPayload(room, false, deps);
      }

      const cookieAccess = requireProtectedRoomAccess(room, request, now());
      if (cookieAccess.ok) {
        reply.header(
          "set-cookie",
          createRoomAccessCookie({
            code,
            pinHash: room.pin_hash,
            ttlMs: deps.ttlMs,
            now: now(),
            secure: isSecureRequest(request),
          }),
        );
        void metrics.record({ event: "open_or_create", roomKind: room.kind, outcome: "opened" });
        return {
          ...roomAccessPayload(room, false, deps),
          accessExpiresAt: cookieAccess.expiresAt?.toISOString() ?? null,
        };
      }

      if (!parsedPin.pin) {
        reply.code(401).send({ error: "pin_required", message: "Clipboard protegido por PIN." });
        return;
      }

      if (!(await verifyRoomPin(parsedPin.pin, room.pin_hash))) {
        reply.code(401).send({ error: "pin_invalid", message: "PIN inválido." });
        return;
      }

      const grantedAt = now();
      reply.header(
        "set-cookie",
        createRoomAccessCookie({
          code,
          pinHash: room.pin_hash,
          ttlMs: deps.ttlMs,
          now: grantedAt,
          secure: isSecureRequest(request),
        }),
      );
      void metrics.record({ event: "open_or_create", roomKind: room.kind, outcome: "opened" });
      return {
        ...roomAccessPayload(room, false, deps),
        accessExpiresAt: new Date(grantedAt.getTime() + deps.ttlMs).toISOString(),
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
        reply.code(404).send({ error: "not_found", message: "Sala não encontrada." });
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
        reply.header(
          "set-cookie",
          createRoomAccessCookie({
            code,
            pinHash: room.pin_hash,
            ttlMs: deps.ttlMs,
            now: now(),
            secure: isSecureRequest(request),
          }),
        );
        return {
          ...roomAccessPayload(room, undefined, deps),
          accessExpiresAt: cookieAccess.expiresAt?.toISOString() ?? null,
        };
      }

      if (!parsedPin.pin) {
        reply.code(401).send({ error: "pin_required", message: "Sala protegida por PIN." });
        return;
      }

      if (!(await verifyRoomPin(parsedPin.pin, room.pin_hash))) {
        reply.code(401).send({ error: "pin_invalid", message: "PIN inválido." });
        return;
      }

      const grantedAt = now();
      reply.header(
        "set-cookie",
        createRoomAccessCookie({
          code,
          pinHash: room.pin_hash,
          ttlMs: deps.ttlMs,
          now: grantedAt,
          secure: isSecureRequest(request),
        }),
      );
      return {
        ...roomAccessPayload(room, undefined, deps),
        accessExpiresAt: new Date(grantedAt.getTime() + deps.ttlMs).toISOString(),
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
        reply.code(404).send({ error: "not_found", message: "Sala não encontrada." });
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
        protected: room.pin_hash !== null,
        kind: room.kind,
        expiresAfterMinutes: roomExpiryMinutes(room, deps),
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
        socket.send(JSON.stringify({ type: "error", error: "not_found", message: "Sala não encontrada." }));
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
        socket.send(JSON.stringify({ type: "error", error: "room_full", message: "Sala cheia." }));
        socket.close(1008, joined.reason);
        return;
      }

      if (joined.clientCount === 1) {
        lifecycleTargets.set(code, null);
        await repository.markTextRoomActive(code, now());
      }
      if (joined.clientCount === 2) {
        void metrics.record({ event: "second_device", roomKind: room.kind, outcome: "success" });
      }

      liveSockets.add(socket);
      socket.on("pong", () => liveSockets.add(socket));
      socket.send(JSON.stringify({
        type: "snapshot",
        text: room.text,
        version: room.version,
        clientId,
        kind: room.kind,
        expiresAfterMinutes: roomExpiryMinutes(room, deps),
      }));
      deps.hub.broadcast(code, JSON.stringify({ type: "presence", count: joined.clientCount }));

      let authExpiryTimer: ReturnType<typeof setTimeout> | null = null;
      if (access.expiresAt) {
        const delayMs = access.expiresAt.getTime() - now().getTime();
        if (delayMs <= 0) {
          socket.send(JSON.stringify({ type: "error", error: "invalid_token", message: "Acesso à sala expirou. Informe o PIN novamente." }));
          socket.close(1008, "invalid_token");
          return;
        }

        authExpiryTimer = setTimeout(() => {
          socket.send(JSON.stringify({ type: "error", error: "invalid_token", message: "Acesso à sala expirou. Informe o PIN novamente." }));
          socket.close(1008, "invalid_token");
        }, delayMs);
      }

      socket.on("message", (raw: RawData) => {
        void handleRealtimeMessage(raw, code, clientId, socket, deps, repository, now);
      });

      let closed = false;
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
        }
      };

      socket.on("close", onClose);
      socket.on("error", onClose);
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
  code: string,
  clientId: string,
  socket: WebSocket,
  deps: TextSessionRouteDeps,
  repository: TextRoomsRepository,
  now: () => Date,
): Promise<void> {
  const message = parseRealtimeMessage(raw);

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

  if (Buffer.byteLength(message.text, "utf8") > deps.maxBytes) {
    socket.send(JSON.stringify({ type: "error", error: "too_large", message: "Texto excede o limite da sala." }));
    return;
  }

  const updated = await repository.updateTextRoomText({ code, text: message.text, now: now() });

  if (!updated || isExpired(updated, now(), deps.hub.clientCount(code))) {
    socket.send(JSON.stringify({ type: "error", error: "not_found", message: "Sala não encontrada." }));
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

function roomAccessPayload(room: TextRoomRow, created: boolean | undefined, deps: TextSessionRouteDeps) {
  return {
    code: room.code,
    protected: room.pin_hash !== null,
    kind: room.kind,
    expiresAfterMinutes: roomExpiryMinutes(room, deps),
    ...(created === undefined ? {} : { created }),
  };
}

function parsePinFromBody(body: unknown): PinParseResult {
  if (body === null || body === undefined) {
    return { ok: true, pin: null };
  }

  if (typeof body !== "object") {
    return { ok: false, message: "Body inválido para PIN." };
  }

  const pin = "pin" in body ? normalizeRoomPin(body.pin) : null;
  if (pin === null) {
    return { ok: true, pin: null };
  }

  if (pin.length < ROOM_PIN_MIN_LENGTH || pin.length > ROOM_PIN_MAX_LENGTH) {
    return {
      ok: false,
      message: `O PIN deve ter entre ${ROOM_PIN_MIN_LENGTH} e ${ROOM_PIN_MAX_LENGTH} caracteres.`,
    };
  }

  return { ok: true, pin };
}

function requireProtectedRoomAccess(room: TextRoomRow, request: FastifyRequest, currentTime: Date): ProtectedRoomAuthResult {
  if (!room.pin_hash) {
    return { ok: true, expiresAt: null };
  }

  const access = verifyRoomAccessCookie({
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
    return { ok: false, statusCode: 401, error: "pin_required", message: "Sala protegida por PIN." };
  }

  return {
    ok: false,
    statusCode: 401,
    error: "invalid_token",
    message: "Acesso à sala expirou. Informe o PIN novamente.",
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

async function sweepExpiredRooms(repository: TextRoomsRepository, currentTime: Date): Promise<void> {
  const expiredRooms = await repository.findExpiredTextRooms(currentTime, EXPIRED_SWEEP_LIMIT);

  for (const room of expiredRooms) {
    await repository.markTextRoomDeleted(room.id, currentTime);
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
