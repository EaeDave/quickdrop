import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildApp } from "./index";

const testEnv = {
  PORT: "3000",
  DATABASE_URL: "postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  PUBLIC_BASE_URL: "https://quickdrop.eaedave.xyz",
  QUICKDROP_GITHUB_TOKEN: "github-token",
};

const envKeys = [...Object.keys(testEnv), "GITHUB_TOKEN"];
const originalFetch = globalThis.fetch;
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

  globalThis.fetch = originalFetch;
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

  test("serves the Windows PowerShell installer script", async () => {
    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/install.ps1",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toContain("QuickDrop");
      expect(response.body).toContain("/windows/latest.exe");
      expect(response.body).toContain("Start-InstalledQuickDrop");
      expect(response.body).toContain("Start-Process -FilePath $ExePath");
      expect(response.body).toContain("Resolve-DirectoryPath");
      expect(response.body).toContain("Join-OptionalPath");
      expect(response.body).not.toContain('Join-Path $InstallLocationProperty.Value "$AppName.exe"');
      expect(response.body).not.toContain('"/R"');
      expect(response.body).not.toContain('"/ARGS"');
      expect(response.body).not.toContain("--tray-start");
    } finally {
      await app.close();
    }
  });

  test("proxies the latest Windows installer through the server GitHub token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      calls.push({ url, headers });

      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/latest") {
        return Response.json({
          assets: [
            {
              name: "QuickDrop_0.1.0_x64-setup.exe",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/1",
            },
          ],
        });
      }

      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/1") {
        return new Response("installer-binary", {
          headers: { "content-type": "application/octet-stream" },
        });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/windows/latest.exe",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toContain("QuickDrop_0.1.0_x64-setup.exe");
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      expect(response.body).toBe("installer-binary");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.headers.authorization).toBe("Bearer github-token");
      expect(calls[0]?.headers.accept).toBe("application/vnd.github+json");
      expect(calls[1]?.headers.authorization).toBe("Bearer github-token");
      expect(calls[1]?.headers.accept).toBe("application/octet-stream");
    } finally {
      await app.close();
    }
  });

  test("fails the Windows installer proxy when the server token is missing", async () => {
    delete process.env.QUICKDROP_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/windows/latest.exe",
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("QUICKDROP_GITHUB_TOKEN");
    } finally {
      await app.close();
    }
  });
});
