import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply } from "fastify";
import { loadConfig } from "./config";
import { startCleanupJob } from "./cleanup";
import { handleDownload } from "./download-service";
import { createR2Client } from "./r2";
import { handleUpload } from "./upload-service";
import { handleLinuxInstallerDownload } from "./linux-installer-service";
import { handleWindowsInstallerDownload } from "./windows-installer-service";
import { TextSessionHub } from "./text-session-hub";
import {
  rearmTextRoomsAfterRestart,
  registerTextSessionRoutes,
  startTextSessionHeartbeat,
  startTextSessionSweep,
} from "./text-session-service";

export function buildApp() {
  const config = loadConfig();
  const r2Client = createR2Client(config);
  const app = Fastify({
    logger: true,
    bodyLimit: config.maxFileSizeBytes + 1024 * 1024,
  });

  app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "x-quickdrop-file-size"],
  });

  app.register(multipart);
  app.register(rateLimit, { global: false });
  app.register(websocket, {
    options: { maxPayload: config.textSessionMaxBytes + 1024 },
  });

  const textHub = new TextSessionHub({
    maxClientsPerSession: config.textSessionMaxClientsPerSession,
  });



  const sendScriptFile = (reply: FastifyReply, fileName: string) =>
    readFile(join(process.cwd(), "scripts", fileName), "utf8").then((script) =>
      reply
        .type("text/plain; charset=utf-8")
        .header("cache-control", "public, max-age=300")
        .send(script),
    );

  app.get("/install.ps1", async (_request, reply) => sendScriptFile(reply, "install-windows.ps1"));
  app.get("/install.sh", async (_request, reply) => sendScriptFile(reply, "install-linux.sh"));
  app.get("/linux/quickdrop-waybar", async (_request, reply) =>
    sendScriptFile(reply, "quickdrop-waybar"),
  );

  app.get("/windows/latest.exe", async (_request, reply) =>
    handleWindowsInstallerDownload(reply, { config }),
  );
  app.get("/linux/latest", async (_request, reply) =>
    handleLinuxInstallerDownload(reply, { config }),
  );
  app.get("/t", async (_request, reply) => reply.redirect("/?c=", 302));
  app.get<{ Params: { code: string } }>("/t/:code", async (request, reply) =>
    reply.redirect(`/?c=${encodeURIComponent(request.params.code)}`, 302),
  );
  app.register(fastifyStatic, {
    root: join(process.cwd(), "dist"),
    prefix: "/",
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.after((error) => {
    if (error) {
      throw error;
    }

    app.post(
      "/api/upload",
      { preHandler: app.rateLimit({ max: config.uploadRateLimitMax, timeWindow: "1 hour" }) },
      async (request, reply) => handleUpload(request, reply, { config, r2Client }),
    );

    registerTextSessionRoutes(app, {
      hub: textHub,
      maxBytes: config.textSessionMaxBytes,
      maxSessions: config.textSessionMaxSessions,
      codeLength: config.textSessionCodeLength,
      ttlMs: config.textSessionTtlHours * 60 * 60 * 1000,
    });
  });

  app.get<{ Params: { shortId: string } }>("/f/:shortId", async (request, reply) => {
    await handleDownload(request.params.shortId, reply, { config, r2Client });
  });

  return { app, config, textHub };
}

export async function startServer(): Promise<void> {
  const { app, config } = buildApp();
  await rearmTextRoomsAfterRestart(config.textSessionTtlHours * 60 * 60 * 1000);
  await app.listen({ host: "0.0.0.0", port: config.port });
  startCleanupJob();
  startTextSessionSweep();
  startTextSessionHeartbeat(app);
}

if (import.meta.main) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
