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
import {
  handleLinuxInstallerDownload,
  handleLinuxQdChecksumDownload,
  handleLinuxQdDownload,
} from "./linux-installer-service";
import {
  handleWindowsInstallerDownload,
  handleWindowsQdChecksumDownload,
  handleWindowsQdDownload,
} from "./windows-installer-service";
import { TextSessionHub } from "./text-session-hub";
import { createTextFunnelMetrics, startTextFunnelMetricsCleanup } from "./text-funnel-metrics";
import { registerTextFunnelMetricsRoute } from "./text-funnel-metrics-route";
import {
  rearmTextRoomsAfterRestart,
  startTextDropSweep,
  registerTextSessionRoutes,
  startTextSessionHeartbeat,
  startTextSessionSweep,
} from "./text-session-service";

export function buildApp() {
  const config = loadConfig();
  const r2Client = createR2Client(config);
  const app = Fastify({
    logger: {
      serializers: {
        req(request: { method?: string; url?: string }) {
          return { method: request.method, url: redactTextCodeFromUrl(request.url ?? "") };
        },
      },
    },
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

  app.addHook("onSend", async (request, reply, payload) => {
    if (isSensitiveTextRoute(request.raw.url ?? "")) {
      reply
        .header("cache-control", "no-store, max-age=0")
        .header("pragma", "no-cache")
        .header("referrer-policy", "no-referrer")
        .header("x-content-type-options", "nosniff")
        .header("x-frame-options", "DENY")
        .header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    }
    return payload;
  });

  const textHub = new TextSessionHub({
    maxClientsPerSession: config.textSessionMaxClientsPerSession,
  });
  const textMetrics = createTextFunnelMetrics({
    enabled: config.textMetricsEnabled,
    logger: app.log,
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

  const linuxAssets: Record<string, string> = {
    "/linux/quickdrop-launcher": "quickdrop-launcher",
    // Backward-compatible endpoint for existing Waybar-only installers.
    "/linux/quickdrop-waybar": "quickdrop-launcher",
    "/linux/install-bar-integration": "install-bar-integration.sh",
    "/linux/install-waybar-module.py": "install-waybar-module.py",
    "/linux/omarchy/manifest.json": "omarchy-quickdrop/manifest.json",
    "/linux/omarchy/BarWidget.qml": "omarchy-quickdrop/BarWidget.qml",
  };
  for (const [route, fileName] of Object.entries(linuxAssets)) {
    app.get(route, async (_request, reply) => sendScriptFile(reply, fileName));
  }

  app.get("/windows/latest.exe", async (_request, reply) =>
    handleWindowsInstallerDownload(reply, { config }),
  );
  app.get("/windows/qd/latest.exe", async (_request, reply) =>
    handleWindowsQdDownload(reply, { config }),
  );
  app.get("/windows/qd/latest.sha256", async (_request, reply) =>
    handleWindowsQdChecksumDownload(reply, { config }),
  );
  app.get("/linux/latest", async (_request, reply) =>
    handleLinuxInstallerDownload(reply, { config }),
  );
  app.get("/linux/qd/latest", async (_request, reply) =>
    handleLinuxQdDownload(reply, { config }),
  );
  app.get("/linux/qd/latest.sha256", async (_request, reply) =>
    handleLinuxQdChecksumDownload(reply, { config }),
  );
  app.register(fastifyStatic, {
    root: join(process.cwd(), "dist"),
    prefix: "/",
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));

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
      customTtlMs: config.textCustomSessionTtlMinutes * 60 * 1000,
      dropTtlMs: config.textDropTtlHours * 60 * 60 * 1000,
      maxDrops: config.textDropMaxItems,
      metrics: textMetrics,
    });
    registerTextFunnelMetricsRoute(app, textMetrics);
  });

  app.get<{ Params: { shortId: string } }>("/f/:shortId", async (request, reply) => {
    await handleDownload(request.params.shortId, reply, { config, r2Client });
  });
  app.get<{ Params: { code: string } }>("/:code", async (request, reply) => {
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(request.params.code)) {
      return reply.callNotFound();
    }
    return reply.sendFile("index.html");
  });

  return { app, config, textHub };
}

export async function startServer(): Promise<void> {
  const { app, config } = buildApp();
  await rearmTextRoomsAfterRestart(
    config.textSessionTtlHours * 60 * 60 * 1000,
    config.textCustomSessionTtlMinutes * 60 * 1000,
  );
  await app.listen({ host: "0.0.0.0", port: config.port });
  startCleanupJob();
  startTextSessionSweep();
  startTextDropSweep();
  startTextSessionHeartbeat(app);
  // Retention also applies to historical aggregates after collection is disabled.
  startTextFunnelMetricsCleanup(config.textMetricsRetentionDays);
}

export function redactTextCodeFromUrl(rawUrl: string): string {
  const redactedRoomUrl = canonicalRoomCodeFromRawUrl(rawUrl)
    ? rawUrl.replace(/^\/[^/?#]+/, "/[code]")
    : rawUrl;
  return redactedRoomUrl
    .replace(/^(\/api\/text\/)[^/?]+/, "$1[code]")
    .replace(/([?&]c=)[^&]*/gi, "$1[code]");
}

function canonicalRoomCodeFromRawUrl(rawUrl: string): string | null {
  const rawSegment = rawUrl.match(/^\/([^/?#]+)(?=\/?(?:[?#]|$))/)?.[1];
  if (!rawSegment) {
    return null;
  }
  try {
    const code = decodeURIComponent(rawSegment);
    return /^[A-Za-z0-9_-]{1,16}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

function isSensitiveTextRoute(rawUrl: string): boolean {
  return canonicalRoomCodeFromRawUrl(rawUrl) !== null || rawUrl.startsWith("/api/text") || /[?&]c=/i.test(rawUrl);
}

if (import.meta.main) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
