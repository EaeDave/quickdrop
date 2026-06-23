import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { patchWaybarConfig } from "./install-waybar-module.ts";

const scriptPath = resolve("scripts/install-linux.sh");
const launcherSource = resolve("scripts/quickdrop-waybar");
const apiBaseUrl = "https://quickdrop.eaedave.xyz";

const hasToolchain = Boolean(Bun.which("bash") && Bun.which("waybar") && Bun.which("python3"));

const WAYBAR_CONFIG = `{
  "layer": "top",
  "modules-right": [
    "pulseaudio",
    "clock",
    "tray"
  ],
  "clock": {
    "format": "{:%H:%M}"
  },
  "tray": {
    "spacing": 10
  }
}
`;

type Sandbox = {
  binDir: string;
  binaryPath: string;
  launcherPath: string;
  configPath: string;
  fakeBinary: string;
};

async function createSandbox(options: { config?: string; configDir?: string } = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "quickdrop-linux-install-"));
  const binDir = join(root, "bin");
  const fakeBinary = join(root, "quickdrop-fake-binary");
  await writeFile(fakeBinary, "#!/bin/sh\necho quickdrop\n");

  const configPath = join(root, options.configDir ?? ".", "config.jsonc");
  if (options.config !== undefined) {
    await writeFile(configPath, options.config);
  }

  return {
    binDir,
    binaryPath: join(binDir, "quickdrop"),
    launcherPath: join(binDir, "quickdrop-waybar"),
    configPath,
    fakeBinary,
  };
}

async function runInstaller(sandbox: Sandbox): Promise<void> {
  await $`bash ${scriptPath}`
    .env({
      ...process.env,
      HOME: sandbox.binDir,
      QUICKDROP_LINUX_BINARY: sandbox.fakeBinary,
      QUICKDROP_WAYBAR_LAUNCHER_FILE: launcherSource,
      QUICKDROP_BIN_DIR: sandbox.binDir,
      QUICKDROP_WAYBAR_CONFIG: sandbox.configPath,
      QUICKDROP_API_BASE_URL: apiBaseUrl,
      QUICKDROP_WAYBAR_NO_RESTART: "1",
    })
    .quiet();
}

async function isExecutable(path: string): Promise<boolean> {
  const info = await stat(path);
  return (info.mode & 0o111) !== 0;
}

describe.skipIf(!hasToolchain)("install-linux.sh", () => {
  test("installs the binary, launcher, and Waybar module matching the TS patcher", async () => {
    const sandbox = await createSandbox({ config: WAYBAR_CONFIG });

    await runInstaller(sandbox);

    expect(await Bun.file(sandbox.binaryPath).exists()).toBe(true);
    expect(await Bun.file(sandbox.launcherPath).exists()).toBe(true);
    expect(await isExecutable(sandbox.binaryPath)).toBe(true);
    expect(await isExecutable(sandbox.launcherPath)).toBe(true);

    const installedLauncher = await readFile(sandbox.launcherPath, "utf8");
    const repoLauncher = await readFile(launcherSource, "utf8");
    expect(installedLauncher).toBe(repoLauncher);

    const patched = await readFile(sandbox.configPath, "utf8");
    const expected = patchWaybarConfig(WAYBAR_CONFIG, sandbox.launcherPath, apiBaseUrl).text;
    expect(patched).toBe(expected);
    expect(patched).toContain('"custom/quickdrop"');
    expect(patched).toContain(
      `"on-click": "env QUICKDROP_API_BASE_URL='${apiBaseUrl}' '${sandbox.launcherPath}'"`,
    );
  });

  test("is idempotent across repeated runs", async () => {
    const sandbox = await createSandbox({ config: WAYBAR_CONFIG });

    await runInstaller(sandbox);
    const afterFirst = await readFile(sandbox.configPath, "utf8");
    await runInstaller(sandbox);
    const afterSecond = await readFile(sandbox.configPath, "utf8");

    expect(afterSecond).toBe(afterFirst);
  });

  test("installs without a Waybar config without failing", async () => {
    const sandbox = await createSandbox({ configDir: "missing" });

    await runInstaller(sandbox);

    expect(await Bun.file(sandbox.binaryPath).exists()).toBe(true);
    expect(await Bun.file(sandbox.launcherPath).exists()).toBe(true);
    expect(await Bun.file(sandbox.configPath).exists()).toBe(false);
  });
});
