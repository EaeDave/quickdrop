import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { loadConfig } from "./config";
import { startCleanupJob } from "./cleanup";
import { handleDownload } from "./download-service";
import { createR2Client } from "./r2";
import { handleUpload } from "./upload-service";
import { handleWindowsInstallerDownload } from "./windows-installer-service";

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

  app.get("/install.ps1", async (_request, reply) => {
    const script = await readFile(join(process.cwd(), "scripts", "install-windows.ps1"), "utf8");

    return reply
      .type("text/plain; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(script);
  });

  app.get("/windows/latest.exe", async (_request, reply) =>
    handleWindowsInstallerDownload(reply, { config }),
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
      { preHandler: app.rateLimit({ max: 20, timeWindow: "1 hour" }) },
      async (request, reply) => handleUpload(request, reply, { config, r2Client }),
    );
  });

  app.get<{ Params: { shortId: string } }>("/f/:shortId", async (request, reply) => {
    await handleDownload(request.params.shortId, reply, { config, r2Client });
  });

  return { app, config };
}

export async function startServer(): Promise<void> {
  const { app, config } = buildApp();
  await app.listen({ host: "0.0.0.0", port: config.port });
  startCleanupJob();
}

if (import.meta.main) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
