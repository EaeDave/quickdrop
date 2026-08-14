import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const requiredEnv = {
  DATABASE_URL: "postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  PUBLIC_BASE_URL: "https://files.example.com/",
};

describe("loadConfig", () => {
  test("validates required env vars", () => {
    for (const name of Object.keys(requiredEnv)) {
      const env = { ...requiredEnv };
      delete env[name as keyof typeof requiredEnv];

      expect(() => loadConfig(env)).toThrow(name);
    }
  });

  test("applies MVP defaults", () => {
    const config = loadConfig(requiredEnv);

    expect(config.port).toBe(3000);
    expect(config.fileExpirationHours).toBe(6);
    expect(config.maxFileSizeMb).toBe(100);
    expect(config.r2BucketName).toBe("quickdrop");
    expect(config.uploadRateLimitMax).toBe(5);
    expect(config.uploadsEnabled).toBe(true);
    expect(config.r2StorageHardLimitGb).toBe(8);
    expect(config.r2StorageHardLimitBytes).toBe(8 * 1024 * 1024 * 1024);
    expect(config.uploadReservationTtlMinutes).toBe(30);
  });

  test("computes byte limit from megabytes", () => {
    const config = loadConfig({ ...requiredEnv, MAX_FILE_SIZE_MB: "7" });

    expect(config.maxFileSizeBytes).toBe(7 * 1024 * 1024);
  });

  test("reads upload safety overrides", () => {
    const config = loadConfig({
      ...requiredEnv,
      FILE_EXPIRATION_HOURS: "2",
      MAX_FILE_SIZE_MB: "50",
      UPLOAD_RATE_LIMIT_MAX: "3",
      UPLOADS_ENABLED: "false",
      R2_STORAGE_HARD_LIMIT_GB: "4",
      UPLOAD_RESERVATION_TTL_MINUTES: "9",
    });

    expect(config.fileExpirationHours).toBe(2);
    expect(config.maxFileSizeMb).toBe(50);
    expect(config.uploadRateLimitMax).toBe(3);
    expect(config.uploadsEnabled).toBe(false);
    expect(config.r2StorageHardLimitBytes).toBe(4 * 1024 * 1024 * 1024);
    expect(config.uploadReservationTtlMinutes).toBe(9);
  });

  test("trims trailing slash from public base URL", () => {
    const config = loadConfig({ ...requiredEnv, PUBLIC_BASE_URL: "https://files.example.com///" });

    expect(config.publicBaseUrl).toBe("https://files.example.com");
  });

  test("prefers the canonical QuickDrop deployment URL", () => {
    const config = loadConfig({
      ...requiredEnv,
      QUICKDROP_PUBLIC_BASE_URL: "https://drop.example/",
    });

    expect(config.publicBaseUrl).toBe("https://drop.example");
  });

  test("rejects a public base URL with credentials or a deployment path", () => {
    expect(() => loadConfig({
      ...requiredEnv,
      QUICKDROP_PUBLIC_BASE_URL: "https://user:password@drop.example",
    })).toThrow("credential-free");
    expect(() => loadConfig({
      ...requiredEnv,
      QUICKDROP_PUBLIC_BASE_URL: "https://drop.example/base",
    })).toThrow("must not contain a path");
  });

  test("reads optional GitHub installer proxy config", () => {
    const config = loadConfig({
      ...requiredEnv,
      QUICKDROP_GITHUB_TOKEN: "token",
      QUICKDROP_GITHUB_REPOSITORY: "owner/repo",
    });

    expect(config.githubToken).toBe("token");
    expect(config.githubReleaseRepository).toBe("owner/repo");
  });

  test("rejects non-positive numeric values", () => {
    expect(() => loadConfig({ ...requiredEnv, PORT: "0" })).toThrow("PORT");
    expect(() => loadConfig({ ...requiredEnv, FILE_EXPIRATION_HOURS: "-1" })).toThrow("FILE_EXPIRATION_HOURS");
    expect(() => loadConfig({ ...requiredEnv, MAX_FILE_SIZE_MB: "0" })).toThrow("MAX_FILE_SIZE_MB");
    expect(() => loadConfig({ ...requiredEnv, UPLOAD_RATE_LIMIT_MAX: "0" })).toThrow("UPLOAD_RATE_LIMIT_MAX");
    expect(() => loadConfig({ ...requiredEnv, R2_STORAGE_HARD_LIMIT_GB: "0" })).toThrow("R2_STORAGE_HARD_LIMIT_GB");
    expect(() => loadConfig({ ...requiredEnv, UPLOAD_RESERVATION_TTL_MINUTES: "0" })).toThrow(
      "UPLOAD_RESERVATION_TTL_MINUTES",
    );
    expect(() => loadConfig({ ...requiredEnv, UPLOADS_ENABLED: "maybe" })).toThrow("UPLOADS_ENABLED");
    expect(() => loadConfig({ ...requiredEnv, TEXT_CUSTOM_SESSION_TTL_MINUTES: "0" })).toThrow(
      "TEXT_CUSTOM_SESSION_TTL_MINUTES",
    );
    expect(() => loadConfig({ ...requiredEnv, TEXT_DROP_TTL_HOURS: "0" })).toThrow(
      "TEXT_DROP_TTL_HOURS",
    );
    expect(() => loadConfig({ ...requiredEnv, TEXT_DROP_MAX_ITEMS: "0" })).toThrow(
      "TEXT_DROP_MAX_ITEMS",
    );
    expect(() => loadConfig({ ...requiredEnv, TEXT_METRICS_ENABLED: "sometimes" })).toThrow(
      "TEXT_METRICS_ENABLED",
    );
    expect(() => loadConfig({ ...requiredEnv, TEXT_METRICS_RETENTION_DAYS: "0" })).toThrow(
      "TEXT_METRICS_RETENTION_DAYS",
    );
  });

  test("applies text session defaults", () => {
    const config = loadConfig(requiredEnv);

    expect(config.textSessionTtlHours).toBe(12);
    expect(config.textCustomSessionTtlMinutes).toBe(30);
    expect(config.textSessionMaxBytes).toBe(256 * 1024);
    expect(config.textSessionCodeLength).toBe(6);
    expect(config.textSessionMaxSessions).toBe(500);
    expect(config.textSessionMaxClientsPerSession).toBe(20);
    expect(config.textDropTtlHours).toBe(12);
    expect(config.textDropMaxItems).toBe(10);
    expect(config.textMetricsEnabled).toBe(false);
    expect(config.textMetricsRetentionDays).toBe(90);
  });

  test("reads text session overrides", () => {
    const config = loadConfig({
      ...requiredEnv,
      TEXT_SESSION_TTL_HOURS: "3",
      TEXT_CUSTOM_SESSION_TTL_MINUTES: "20",
      TEXT_SESSION_MAX_KB: "10",
      TEXT_SESSION_CODE_LENGTH: "4",
      TEXT_SESSION_MAX_SESSIONS: "7",
      TEXT_SESSION_MAX_CLIENTS: "2",
      TEXT_DROP_TTL_HOURS: "6",
      TEXT_DROP_MAX_ITEMS: "25",
      TEXT_METRICS_ENABLED: "true",
      TEXT_METRICS_RETENTION_DAYS: "45",
    });

    expect(config.textSessionTtlHours).toBe(3);
    expect(config.textCustomSessionTtlMinutes).toBe(20);
    expect(config.textSessionMaxBytes).toBe(10 * 1024);
    expect(config.textSessionCodeLength).toBe(4);
    expect(config.textSessionMaxSessions).toBe(7);
    expect(config.textSessionMaxClientsPerSession).toBe(2);
    expect(config.textDropTtlHours).toBe(6);
    expect(config.textDropMaxItems).toBe(25);
    expect(config.textMetricsEnabled).toBe(true);
    expect(config.textMetricsRetentionDays).toBe(45);
  });
});
