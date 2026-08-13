import { describe, expect, test } from "bun:test";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "./config";
import { handleUpload, type UploadDeps } from "./upload-service";

const config: AppConfig = {
  port: 3000,
  databaseUrl: "postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop",
  r2AccountId: "account",
  r2AccessKeyId: "access-key",
  r2SecretAccessKey: "secret-key",
  r2BucketName: "quickdrop",
  publicBaseUrl: "https://quickdrop.example.com",
  fileExpirationHours: 6,
  maxFileSizeMb: 100,
  maxFileSizeBytes: 100 * 1024 * 1024,
  uploadRateLimitMax: 5,
  uploadsEnabled: true,
  r2StorageHardLimitGb: 8,
  r2StorageHardLimitBytes: 8 * 1024 * 1024 * 1024,
  uploadReservationTtlMinutes: 30,
  githubToken: undefined,
  githubReleaseRepository: "EaeDave/quickdrop",
  textSessionTtlHours: 12,
  textCustomSessionTtlMinutes: 30,
  textSessionMaxBytes: 256 * 1024,
  textSessionCodeLength: 6,
  textSessionMaxSessions: 500,
  textSessionMaxClientsPerSession: 20,
  textMetricsEnabled: false,
  textMetricsRetentionDays: 90,
};

const boundary = "quickdrop-upload-test";
const multipartHeaders = { "content-type": `multipart/form-data; boundary=${boundary}` };
const multipartPayload = [
  `--${boundary}`,
  'Content-Disposition: form-data; name="file"; filename="hello.txt"',
  "Content-Type: text/plain",
  "",
  "hello",
  `--${boundary}--`,
  "",
].join("\r\n");

describe("handleUpload storage quota", () => {
  test("rejects when the global storage quota is exhausted before touching R2", async () => {
    let reserveCalls = 0;
    let registerCalls = 0;
    let r2Calls = 0;
    const deps: UploadDeps = {
      config,
      r2Client: { send: async () => void (r2Calls += 1) } as unknown as S3Client,
      storageQuota: {
        async reserveUploadStorage() {
          reserveCalls += 1;
          return { ok: false, reason: "quota_exceeded" };
        },
        async registerUploadWithStorageReservation() {
          registerCalls += 1;
          throw new Error("register should not be called");
        },
        async releaseUploadStorageReservation() {
          return { released: false, bytes: 0 };
        },
      },
    };
    const response = await injectUpload(deps);

    expect(response.statusCode).toBe(507);
    expect(JSON.parse(response.body)).toEqual({
      error: "storage_quota_exceeded",
      message: "Limite de armazenamento temporário atingido.",
    });
    expect(reserveCalls).toBe(1);
    expect(registerCalls).toBe(0);
    expect(r2Calls).toBe(0);
  });

  test("releases a reserved quota when registration fails before R2 upload", async () => {
    let releaseCalls = 0;
    let r2Calls = 0;
    const deps: UploadDeps = {
      config,
      r2Client: { send: async () => void (r2Calls += 1) } as unknown as S3Client,
      storageQuota: {
        async reserveUploadStorage() {
          return {
            ok: true,
            reservation: { id: "0f45b077-3ef0-4d9d-b327-3d93474bf3a1", sizeBytes: 5, expiresAt: new Date() },
          };
        },
        async registerUploadWithStorageReservation() {
          throw new Error("database down");
        },
        async releaseUploadStorageReservation(reservationId: string) {
          expect(reservationId).toBe("0f45b077-3ef0-4d9d-b327-3d93474bf3a1");
          releaseCalls += 1;
          return { released: true, bytes: 5 };
        },
      },
    };
    const response = await injectUpload(deps);

    expect(response.statusCode).toBe(500);
    expect(releaseCalls).toBe(1);
    expect(r2Calls).toBe(0);
  });
});

async function injectUpload(deps: UploadDeps) {
  const app = Fastify({ logger: false });
  app.register(multipart);
  app.post("/api/upload", async (request, reply) => handleUpload(request, reply, deps));

  try {
    return await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: multipartHeaders,
      payload: multipartPayload,
    });
  } finally {
    await app.close();
  }
}
