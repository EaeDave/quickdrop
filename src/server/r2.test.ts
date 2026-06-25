import { describe, expect, test } from "bun:test";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { AppConfig } from "./config";
import { createR2Client } from "./r2";

const config: AppConfig = {
  port: 3000,
  databaseUrl: "postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop",
  r2AccountId: "account",
  r2AccessKeyId: "access-key",
  r2SecretAccessKey: "secret-key",
  r2BucketName: "quickdrop",
  publicBaseUrl: "http://127.0.0.1:3000",
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
  textSessionMaxBytes: 256 * 1024,
  textSessionCodeLength: 6,
  textSessionMaxSessions: 500,
  textSessionMaxClientsPerSession: 20,
};

describe("createR2Client", () => {
  test("disables optional flexible checksums for streaming R2 uploads", async () => {
    const client = createR2Client(config);

    await expect(client.config.requestChecksumCalculation()).resolves.toBe("WHEN_REQUIRED");
    await expect(client.config.responseChecksumValidation()).resolves.toBe("WHEN_REQUIRED");
  });

  test("uses Node HTTP handler instead of Bun fetch for R2 uploads", () => {
    const client = createR2Client(config);

    expect(client.config.requestHandler).toBeInstanceOf(NodeHttpHandler);
  });
});
