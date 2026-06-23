import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { generateSessionCode, normalizeSessionCode } from "./ids";
import type { TextSessionHub } from "./text-session-hub";
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

export function registerTextSessionRoutes(app: FastifyInstance, deps: TextSessionRouteDeps): void {
  const repository = deps.repository ?? textRoomsRepository;
  const now = deps.now ?? (() => new Date());

  app.post(
    "/api/text",
    { preHandler: app.rateLimit({ max: 60, timeWindow: "1 hour" }) },
    async (_request, reply) => {
      if ((await repository.countActiveTextRooms(now())) >= deps.maxSessions) {
        reply.code(503).send({ error: "session_limit", message: "Limite de salas atingido. Tente mais tarde." });
        return;
      }

      for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
        const createdAt = now();
        const code = generateSessionCode(deps.codeLength);
        const room = await repository.createTextRoom({
          code,
          text: "",
          version: 0,
          createdAt,
          updatedAt: createdAt,
          expiresAt: new Date(createdAt.getTime() + deps.ttlMs),
        });

        if (room) {
          return { code: room.code };
        }
      }

      reply.code(503).send({ error: "code_exhausted", message: "Não foi possível reservar um código de sala." });
    },
  );

  app.get<{ Params: { code: string } }>("/api/text/:code", async (request, reply) => {
    const code = normalizeSessionCode(request.params.code);
    const room = await repository.findTextRoomByCode(code);

    if (!room || isExpired(room, now(), deps.hub.clientCount(code))) {
      reply.code(404).send({ error: "not_found", message: "Sala não encontrada." });
      return;
    }

    return { text: room.text, version: room.version };
  });

  app.get<{ Params: { code: string } }>(
    "/api/text/:code/ws",
    { websocket: true },
    async (socket, request) => {
      const code = normalizeSessionCode(request.params.code);
      const room = await repository.findTextRoomByCode(code);

      if (!room || isExpired(room, now(), deps.hub.clientCount(code))) {
        socket.send(JSON.stringify({ type: "error", message: "Sala não encontrada." }));
        socket.close(1008, "not_found");
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
        socket.send(JSON.stringify({ type: "error", message: "Sala cheia." }));
        socket.close(1008, joined.reason);
        return;
      }

      if (joined.clientCount === 1) {
        await repository.markTextRoomActive(code, now());
      }

      liveSockets.add(socket);
      socket.on("pong", () => liveSockets.add(socket));
      socket.send(JSON.stringify({ type: "snapshot", text: room.text, version: room.version, clientId }));

      socket.on("message", (raw: RawData) => {
        void handleWrite(raw, code, clientId, socket, deps, repository, now);
      });

      let closed = false;
      const onClose = () => {
        if (closed) {
          return;
        }

        closed = true;
        liveSockets.delete(socket);
        const remaining = deps.hub.leave(code, clientId);

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
    socket.send(JSON.stringify({ type: "error", message: "Texto excede o limite da sala." }));
    return;
  }

  const updated = await repository.updateTextRoomText({ code, text: message.text, now: now() });

  if (!updated || isExpired(updated, now(), deps.hub.clientCount(code))) {
    socket.send(JSON.stringify({ type: "error", message: "Sala não encontrada." }));
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

function isExpired(room: TextRoomRow, now: Date, activeClientCount: number): boolean {
  return activeClientCount === 0 && room.expires_at !== null && room.expires_at <= now;
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
