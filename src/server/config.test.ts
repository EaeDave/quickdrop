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
    expect(config.fileExpirationHours).toBe(24);
    expect(config.maxFileSizeMb).toBe(500);
    expect(config.r2BucketName).toBe("quickdrop");
  });

  test("computes byte limit from megabytes", () => {
    const config = loadConfig({ ...requiredEnv, MAX_FILE_SIZE_MB: "7" });

    expect(config.maxFileSizeBytes).toBe(7 * 1024 * 1024);
  });

  test("trims trailing slash from public base URL", () => {
    const config = loadConfig({ ...requiredEnv, PUBLIC_BASE_URL: "https://files.example.com///" });

    expect(config.publicBaseUrl).toBe("https://files.example.com");
  });

  test("rejects non-positive numeric values", () => {
    expect(() => loadConfig({ ...requiredEnv, PORT: "0" })).toThrow("PORT");
    expect(() => loadConfig({ ...requiredEnv, FILE_EXPIRATION_HOURS: "-1" })).toThrow("FILE_EXPIRATION_HOURS");
    expect(() => loadConfig({ ...requiredEnv, MAX_FILE_SIZE_MB: "0" })).toThrow("MAX_FILE_SIZE_MB");
  });
});
