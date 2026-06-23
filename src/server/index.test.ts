import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildApp } from "./index";

const testEnv = {
  PORT: "3000",
  DATABASE_URL: "postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  PUBLIC_BASE_URL: "https://quickdrop.eaedave.xyz",
};

const envKeys = Object.keys(testEnv);
let previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  previousEnv = {};
  for (const key of envKeys) {
    previousEnv[key] = process.env[key];
  }
  Object.assign(process.env, testEnv);
});

afterEach(() => {
  for (const key of envKeys) {
    const previous = previousEnv[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

describe("buildApp", () => {
  test("allows Tauri/WebView upload preflight with custom size header", async () => {
    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/api/upload",
        headers: {
          origin: "tauri://localhost",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-quickdrop-file-size",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("tauri://localhost");
      expect(String(response.headers["access-control-allow-headers"]).toLowerCase()).toContain(
        "x-quickdrop-file-size",
      );
    } finally {
      await app.close();
    }
  });
});
