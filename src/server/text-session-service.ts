import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import { generateSessionCode, normalizeSessionCode } from "./ids";
import { clearRoomAccessCookie, createRoomAccessCookie, type RoomAccessCheck, verifyRoomAccessCookie } from "./text-room-access";
import type { TextSessionHub } from "./text-session-hub";
import { ROOM_PIN_MAX_LENGTH, ROOM_PIN_MIN_LENGTH, hashRoomPin, normalizeRoomPin, verifyRoomPin } from "./text-room-pin";
import type { TextRoomRow, TextRoomsRepository } from "./text-rooms-repository";
import { textRoomsRepository } from "./text-rooms-repository";

const liveSockets = new WeakSet<WebSocket>();
const CODE_GENERATION_ATTEMPTS = 8;
const EXPIRED_SWEEP_LIMIT = 100;

export type TextSessionRouteDeps = {
  hub: TextSessionHub;
  repository?: TextRoomsRepository;
  maxBytes: number;
  maxSessions: number;
  codeLength: number;
  ttlMs: number;
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
  const now = deps.now ?? (() => new Date());

  app.post(
    "/api/text",
    { preHandler: app.rateLimit({ max: 60, timeWindow: "1 hour" }) },
    async (request, reply) => {
      const parsedPin = parsePinFromBody(request.body);
      if (!parsedPin.ok) {
        reply.code(400).send({ error: "pin_invalid", message: parsedPin.message });
        return;
      }

      if ((await repository.countActiveTextRooms(now())) >= deps.maxSessions) {
        reply.code(503).send({ error: "session_limit", message: "Limite de salas atingido. Tente mais tarde." });
        return;
      }

      const pinHash = parsedPin.pin ? await hashRoomPin(parsedPin.pin) : null;

      for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
        const createdAt = now();
        const code = generateSessionCode(deps.codeLength);
        const room = await repository.createTextRoom({
          code,
          text: "",
          version: 0,
          pinHash,
          createdAt,
          updatedAt: createdAt,
          expiresAt: new Date(createdAt.getTime() + deps.ttlMs),
        });

        if (room) {
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

          return { code: room.code, protected: room.pin_hash !== null };
        }
      }

      reply.code(503).send({ error: "code_exhausted", message: "Não foi possível reservar um código de sala." });
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
        return { code, protected: false };
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
        return { code, protected: true, accessExpiresAt: cookieAccess.expiresAt?.toISOString() ?? null };
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
        code,
        protected: true,
        accessExpiresAt: new Date(grantedAt.getTime() + deps.ttlMs).toISOString(),
      };
    },
  );

  app.get<{ Params: { code: string } }>("/api/text/:code", async (request, reply) => {
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

    return { text: room.text, version: room.version, protected: room.pin_hash !== null };
  });

  app.get<{ Params: { code: string } }>(
    "/api/text/:code/ws",
    { websocket: true },
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
        await repository.markTextRoomActive(code, now());
      }

      liveSockets.add(socket);
      socket.on("pong", () => liveSockets.add(socket));
      socket.send(JSON.stringify({ type: "snapshot", text: room.text, version: room.version, clientId }));
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
        void handleWrite(raw, code, clientId, socket, deps, repository, now);
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
        deps.hub.broadcast(code, JSON.stringify({ type: "presence", count: remaining }));

        if (remaining === 0) {
          const closedAt = now();
          void repository.scheduleTextRoomExpiry(
            code,
            new Date(closedAt.getTime() + deps.ttlMs),
            closedAt,
          );
        }
      };

      socket.on("close", onClose);
      socket.on("error", onClose);
    },
  );
}

async function handleWrite(
  raw: RawData,
  code: string,
  clientId: string,
  socket: WebSocket,
  deps: TextSessionRouteDeps,
  repository: TextRoomsRepository,
  now: () => Date,
): Promise<void> {
  const message = parseWriteMessage(raw);

  if (!message) {
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

  deps.hub.broadcast(
    code,
    JSON.stringify({ type: "update", text: updated.text, version: updated.version, by: clientId }),
    clientId,
  );
  socket.send(JSON.stringify({ type: "ack", version: updated.version }));
}

function parseWriteMessage(raw: RawData): { text: string } | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return null;
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    parsed.type === "write" &&
    "text" in parsed &&
    typeof parsed.text === "string"
  ) {
    return { text: parsed.text };
  }

  return null;
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
  ttlMs: number,
  repository: TextRoomsRepository = textRoomsRepository,
  now: () => Date = () => new Date(),
): Promise<void> {
  const reopenedAt = now();
  await repository.rearmOpenTextRooms(new Date(reopenedAt.getTime() + ttlMs), reopenedAt);
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
    await repository.markTextRoomDeleted(room.code, currentTime);
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
