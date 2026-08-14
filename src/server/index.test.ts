import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildApp, redactTextCodeFromUrl } from "./index";

const testEnv = {
  PORT: "3000",
  DATABASE_URL: "postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  PUBLIC_BASE_URL: "https://quickdrop.eaedave.xyz",
  QUICKDROP_GITHUB_TOKEN: "github-token",
};

const envKeys = [
  ...Object.keys(testEnv),
  "GITHUB_TOKEN",
  "UPLOADS_ENABLED",
  "UPLOAD_RATE_LIMIT_MAX",
  "MAX_FILE_SIZE_MB",
  "FILE_EXPIRATION_HOURS",
  "R2_STORAGE_HARD_LIMIT_GB",
  "UPLOAD_RESERVATION_TTL_MINUTES",
  "TEXT_METRICS_ENABLED",
  "TEXT_METRICS_RETENTION_DAYS",
];
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
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(String(response.headers["access-control-allow-headers"]).toLowerCase()).toContain(
        "x-quickdrop-file-size",
      );
    } finally {
      await app.close();
    }
  });

  test("rejects uploads while the kill switch is disabled before touching storage", async () => {
    process.env.UPLOADS_ENABLED = "false";
    const { app } = buildApp();
    const boundary = "quickdrop-test-boundary";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="hello.txt"',
      "Content-Type: text/plain",
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/upload",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });

      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({
        error: "uploads_disabled",
        message: "Uploads temporariamente desativados.",
      });
    } finally {
      await app.close();
    }
  });

  test("serves the home page without treating it as a room", async () => {
    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("QuickDrop");
      expect(response.headers["cache-control"]).not.toBe("no-store, max-age=0");
    } finally {
      await app.close();
    }
  });

  test("serves the text relay SPA at its canonical room URL", async () => {
    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/abc123",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("QuickDrop");
      expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-frame-options"]).toBe("DENY");

      const encodedResponse = await app.inject({
        method: "GET",
        url: "/%61bc123",
      });
      expect(encodedResponse.statusCode).toBe(200);
      expect(encodedResponse.headers["cache-control"]).toBe("no-store, max-age=0");
    } finally {
      await app.close();
    }
  });

  test("prevents caching text API responses", async () => {
    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/text/INVALID%20CODE/open",
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      await app.close();
    }
  });

  test("accepts only privacy-safe client funnel metrics", async () => {
    const { app } = buildApp();

    try {
      const accepted = await app.inject({
        method: "POST",
        url: "/api/text/metrics",
        payload: { event: "text_copied", roomKind: "custom" },
      });
      expect(accepted.statusCode).toBe(204);
      expect(accepted.headers["cache-control"]).toBe("no-store, max-age=0");

      const rejected = await app.inject({
        method: "POST",
        url: "/api/text/metrics",
        payload: { event: "text_copied", code: "SECRET", text: "private" },
      });
      expect(rejected.statusCode).toBe(400);
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
      expect(response.body).toContain("/windows/qd/latest.exe");
      expect(response.body).toContain("/windows/qd/latest.sha256");
      expect(response.body).toContain("Get-FileHash");
      expect(response.body).toContain("Install-Qd");
      expect(response.body).toContain('SetEnvironmentVariable("Path"');
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

  test("proxies the latest qd Windows binary and checksum", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/latest") {
        return Response.json({
          assets: [
            {
              name: "qd_0.1.1_x86_64-windows.exe",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/10",
            },
            {
              name: "qd_0.1.1_x86_64-windows.exe.sha256",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/11",
            },
          ],
        });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer github-token",
      );
      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/10") {
        return new Response("qd-windows-binary", {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/11") {
        return new Response(`${"b".repeat(64)}  qd_0.1.1_x86_64-windows.exe\n`, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { app } = buildApp();
    try {
      const binary = await app.inject({ method: "GET", url: "/windows/qd/latest.exe" });
      expect(binary.statusCode).toBe(200);
      expect(binary.headers["content-disposition"]).toContain(
        "qd_0.1.1_x86_64-windows.exe",
      );
      expect(binary.headers["cache-control"]).toBe("public, max-age=300");
      expect(binary.body).toBe("qd-windows-binary");

      const checksum = await app.inject({
        method: "GET",
        url: "/windows/qd/latest.sha256",
      });
      expect(checksum.statusCode).toBe(200);
      expect(checksum.headers["content-disposition"]).toContain(
        "qd_0.1.1_x86_64-windows.exe.sha256",
      );
      expect(checksum.body).toContain("qd_0.1.1_x86_64-windows.exe");
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

  test("proxies private desktop updater manifests and platform bundles", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (
        url === "https://api.github.com/repos/EaeDave/quickdrop/releases/latest" ||
        url === "https://api.github.com/repos/EaeDave/quickdrop/releases/tags/v0.1.15"
      ) {
        return Response.json({
          assets: [
            {
              name: "latest.json",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/90",
            },
            {
              name: "QuickDrop_0.1.15_aarch64.app.tar.gz",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/91",
            },
          ],
        });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer github-token",
      );
      if (url.endsWith("/90")) {
        return new Response('{"version":"0.1.15"}', {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/91")) return new Response("signed-macos-updater");
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { app } = buildApp();
    try {
      const manifest = await app.inject({
        method: "GET",
        url: "/desktop/update/latest.json",
      });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(manifest.body)).toEqual({ version: "0.1.15" });

      const bundle = await app.inject({
        method: "GET",
        url: "/desktop/update/0.1.15/darwin-aarch64",
      });
      expect(bundle.statusCode).toBe(200);
      expect(bundle.headers["content-disposition"]).toContain(
        "QuickDrop_0.1.15_aarch64.app.tar.gz",
      );
      expect(bundle.body).toBe("signed-macos-updater");

      const invalid = await app.inject({
        method: "GET",
        url: "/desktop/update/0.1.15/unsupported",
      });
      expect(invalid.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  test("serves the macOS desktop and qd installer script", async () => {
    const { app } = buildApp();

    try {
      const response = await app.inject({ method: "GET", url: "/install-macos.sh" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toContain("QuickDrop");
      expect(response.body).toContain("uname -m");
      expect(response.body).toContain("/macos/$architecture/latest.dmg");
      expect(response.body).toContain("/macos/qd/$architecture/latest");
      expect(response.body).toContain("shasum -a 256");
      expect(response.body).toContain("hdiutil attach");
      expect(response.body).toContain("QuickDrop.app");
    } finally {
      await app.close();
    }
  });

  test("proxies macOS desktop, qd, and checksums by architecture", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/latest") {
        return Response.json({
          assets: [
            {
              name: "qd_0.1.1_aarch64-macos",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/20",
            },
            {
              name: "qd_0.1.1_aarch64-macos.sha256",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/21",
            },
            {
              name: "qd_0.1.1_x86_64-macos",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/22",
            },
            {
              name: "QuickDrop_0.1.1_aarch64.dmg",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/23",
            },
            {
              name: "QuickDrop_0.1.1_aarch64.dmg.sha256",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/24",
            },
            {
              name: "QuickDrop_0.1.1_x64.dmg",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/25",
            },
          ],
        });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer github-token",
      );
      if (url.endsWith("/20")) return new Response("qd-apple-silicon");
      if (url.endsWith("/21")) {
        return new Response(`${"c".repeat(64)}  qd_0.1.1_aarch64-macos\n`);
      }
      if (url.endsWith("/22")) return new Response("qd-intel");
      if (url.endsWith("/23")) return new Response("quickdrop-apple-silicon-dmg");
      if (url.endsWith("/24")) {
        return new Response(`${"d".repeat(64)}  QuickDrop_0.1.1_aarch64.dmg\n`);
      }
      if (url.endsWith("/25")) return new Response("quickdrop-intel-dmg");
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { app } = buildApp();
    try {
      const desktopAppleSilicon = await app.inject({
        method: "GET",
        url: "/macos/aarch64/latest.dmg",
      });
      expect(desktopAppleSilicon.statusCode).toBe(200);
      expect(desktopAppleSilicon.headers["content-disposition"]).toContain(
        "QuickDrop_0.1.1_aarch64.dmg",
      );
      expect(desktopAppleSilicon.body).toBe("quickdrop-apple-silicon-dmg");

      const desktopChecksum = await app.inject({
        method: "GET",
        url: "/macos/aarch64/latest.dmg.sha256",
      });
      expect(desktopChecksum.statusCode).toBe(200);
      expect(desktopChecksum.body).toContain("QuickDrop_0.1.1_aarch64.dmg");

      const desktopIntel = await app.inject({
        method: "GET",
        url: "/macos/x86_64/latest.dmg",
      });
      expect(desktopIntel.statusCode).toBe(200);
      expect(desktopIntel.headers["content-disposition"]).toContain(
        "QuickDrop_0.1.1_x64.dmg",
      );

      const appleSilicon = await app.inject({
        method: "GET",
        url: "/macos/qd/aarch64/latest",
      });
      expect(appleSilicon.statusCode).toBe(200);
      expect(appleSilicon.headers["content-disposition"]).toContain(
        "qd_0.1.1_aarch64-macos",
      );
      expect(appleSilicon.body).toBe("qd-apple-silicon");

      const checksum = await app.inject({
        method: "GET",
        url: "/macos/qd/aarch64/latest.sha256",
      });
      expect(checksum.statusCode).toBe(200);
      expect(checksum.body).toContain("qd_0.1.1_aarch64-macos");

      const intel = await app.inject({
        method: "GET",
        url: "/macos/qd/x86_64/latest",
      });
      expect(intel.statusCode).toBe(200);
      expect(intel.headers["content-disposition"]).toContain("qd_0.1.1_x86_64-macos");

      const unsupported = await app.inject({
        method: "GET",
        url: "/macos/qd/powerpc/latest",
      });
      expect(unsupported.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  test("serves the Linux install script", async () => {
    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/install.sh",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toContain("QuickDrop");
      expect(response.body).toContain("/linux/latest");
      expect(response.body).toContain("/linux/qd/latest");
      expect(response.body).toContain("/linux/quickdrop-launcher");
      expect(response.body).toContain("/linux/install-bar-integration");
      expect(response.body).toContain("QUICKDROP_BAR");
    } finally {
      await app.close();
    }
  });

  test.each([
    ["/linux/quickdrop-launcher", "quickdrop-launcher.lock"],
    ["/linux/quickdrop-waybar", "quickdrop-launcher.lock"],
    ["/linux/install-bar-integration", "quickdrop.bar"],
    ["/linux/install-waybar-module.py", "custom/quickdrop"],
    ["/linux/omarchy/manifest.json", '"id": "quickdrop.bar"'],
    ["/linux/omarchy/BarWidget.qml", 'moduleName: "quickdrop.bar"'],
  ])("serves Linux integration asset %s", async (url, expected) => {
    const { app } = buildApp();

    try {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toContain(expected);
    } finally {
      await app.close();
    }
  });

  test("proxies the latest Linux binary through the server GitHub token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      calls.push({ url, headers });

      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/latest") {
        return Response.json({
          assets: [
            {
              name: "quickdrop_0.1.1_x86_64-linux",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/7",
            },
          ],
        });
      }

      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/7") {
        return new Response("linux-binary", {
          headers: { "content-type": "application/octet-stream" },
        });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/linux/latest",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toContain("quickdrop_0.1.1_x86_64-linux");
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      expect(response.body).toBe("linux-binary");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.headers.authorization).toBe("Bearer github-token");
      expect(calls[0]?.headers.accept).toBe("application/vnd.github+json");
      expect(calls[1]?.headers.authorization).toBe("Bearer github-token");
      expect(calls[1]?.headers.accept).toBe("application/octet-stream");
    } finally {
      await app.close();
    }
  });

  test("proxies the latest qd binary and checksum through the server GitHub token", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/latest") {
        return Response.json({
          assets: [
            {
              name: "qd_0.1.1_x86_64-linux",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/8",
            },
            {
              name: "qd_0.1.1_x86_64-linux.sha256",
              url: "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/9",
            },
          ],
        });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer github-token",
      );
      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/8") {
        return new Response("qd-binary", {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url === "https://api.github.com/repos/EaeDave/quickdrop/releases/assets/9") {
        return new Response(`${"a".repeat(64)}  qd_0.1.1_x86_64-linux\n`, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { app } = buildApp();
    try {
      const binary = await app.inject({ method: "GET", url: "/linux/qd/latest" });
      expect(binary.statusCode).toBe(200);
      expect(binary.headers["content-disposition"]).toContain("qd_0.1.1_x86_64-linux");
      expect(binary.headers["cache-control"]).toBe("public, max-age=300");
      expect(binary.body).toBe("qd-binary");

      const checksum = await app.inject({
        method: "GET",
        url: "/linux/qd/latest.sha256",
      });
      expect(checksum.statusCode).toBe(200);
      expect(checksum.headers["content-disposition"]).toContain(
        "qd_0.1.1_x86_64-linux.sha256",
      );
      expect(checksum.body).toContain("qd_0.1.1_x86_64-linux");
    } finally {
      await app.close();
    }
  });

  test("fails the Linux binary proxy when the server token is missing", async () => {
    delete process.env.QUICKDROP_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    const { app } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/linux/latest",
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("QUICKDROP_GITHUB_TOKEN");
    } finally {
      await app.close();
    }
  });
});

describe("redactTextCodeFromUrl", () => {
  test("removes clipboard codes from request-log URLs", () => {
    expect(redactTextCodeFromUrl("/api/text/SECRET/open")).toBe("/api/text/[code]/open");
    expect(redactTextCodeFromUrl("/SECRET")).toBe("/[code]");
    expect(redactTextCodeFromUrl("/%53ECRET?source=test")).toBe(
      "/[code]?source=test",
    );
    expect(redactTextCodeFromUrl("/SECRET/")).toBe("/[code]/");
    expect(redactTextCodeFromUrl("/?c=FIRST&source=test&c=SECRET")).toBe(
      "/?c=[code]&source=test&c=[code]",
    );
  });
});
