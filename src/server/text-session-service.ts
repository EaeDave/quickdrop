import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { normalizeSessionCode } from "./ids";
import type { TextSessionStore } from "./text-session-store";

const liveSockets = new WeakSet<WebSocket>();

export function registerTextSessionRoutes(app: FastifyInstance, store: TextSessionStore): void {
  app.post(
    "/api/text",
    { preHandler: app.rateLimit({ max: 60, timeWindow: "1 hour" }) },
    async (_request, reply) => {
      const created = store.createSession();

      if (!created.ok) {
        reply.code(503).send({ error: "session_limit", message: "Limite de salas atingido. Tente mais tarde." });
        return;
      }

      return { code: created.session.code };
    },
  );

  app.get<{ Params: { code: string } }>("/api/text/:code", async (request, reply) => {
    const session = store.getSession(request.params.code);

    if (!session) {
      reply.code(404).send({ error: "not_found", message: "Sala não encontrada." });
      return;
    }

    return { text: session.text, version: session.version };
  });

  app.get<{ Params: { code: string } }>(
    "/api/text/:code/ws",
    { websocket: true },
    (socket, request) => {
      const code = normalizeSessionCode(request.params.code);
      const clientId = randomUUID();

      const joined = store.join(code, {
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
        const message = joined.reason === "full" ? "Sala cheia." : "Sala não encontrada.";
        socket.send(JSON.stringify({ type: "error", message }));
        socket.close(1008, joined.reason);
        return;
      }

      liveSockets.add(socket);
      socket.on("pong", () => liveSockets.add(socket));

      socket.send(JSON.stringify({ type: "snapshot", text: joined.text, version: joined.version, clientId }));

      socket.on("message", (raw: RawData) => {
        const message = parseWriteMessage(raw);

        if (!message) {
          return;
        }

        const result = store.applyWrite(code, message.text);

        if (!result.ok) {
          if (result.reason === "too_large") {
            socket.send(JSON.stringify({ type: "error", message: "Texto excede o limite da sala." }));
          }
          return;
        }

        const session = store.getSession(code);
        if (session) {
          store.broadcast(
            session,
            JSON.stringify({ type: "update", text: message.text, version: result.version, by: clientId }),
            clientId,
          );
        }

        socket.send(JSON.stringify({ type: "ack", version: result.version }));
      });

      const onClose = () => {
        liveSockets.delete(socket);
        store.leave(code, clientId);
      };
      socket.on("close", onClose);
      socket.on("error", onClose);
    },
  );
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

export function startTextSessionSweep(
  store: TextSessionStore,
  ttlMs: number,
  intervalMs = 60 * 1000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    store.sweepExpired(ttlMs);
  }, intervalMs);

  timer.unref();
  return timer;
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
