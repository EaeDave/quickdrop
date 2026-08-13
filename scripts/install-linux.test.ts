import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";

const scriptPath = resolve("scripts/install-linux.sh");
const launcherSource = resolve("scripts/quickdrop-launcher");
const barInstallerSource = resolve("scripts/install-bar-integration.sh");
const waybarPatcherSource = resolve("scripts/install-waybar-module.py");
const omarchyPluginSource = resolve("scripts/omarchy-quickdrop");
const apiBaseUrl = "https://quickdrop.eaedave.xyz";

const hasToolchain = Boolean(Bun.which("bash") && Bun.which("python3"));

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
  root: string;
  binDir: string;
  shareDir: string;
  configDir: string;
  binaryPath: string;
  launcherPath: string;
  qdPath: string;
  legacyLauncherPath: string;
  configPath: string;
  fakeBinary: string;
  fakeQd: string;
};

async function createSandbox(options: { config?: string; configDir?: string } = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "quickdrop-linux-install-"));
  const binDir = join(root, "bin");
  const fakeBinary = join(root, "quickdrop-fake-binary");
  const fakeQd = join(root, "qd-fake-binary");
  await writeFile(fakeBinary, "#!/bin/sh\necho quickdrop\n");
  await writeFile(fakeQd, "#!/bin/sh\necho qd-v1\n");
  const configPath = join(root, options.configDir ?? ".", "config.jsonc");
  if (options.config !== undefined) {
    await writeFile(configPath, options.config);
  }

  return {
    root,
    binDir,
    shareDir: join(root, "share"),
    configDir: join(root, "quickdrop-config"),
    binaryPath: join(binDir, "quickdrop"),
    qdPath: join(binDir, "qd"),
    launcherPath: join(binDir, "quickdrop-launcher"),
    legacyLauncherPath: join(binDir, "quickdrop-waybar"),
    configPath,
    fakeBinary,
    fakeQd,
  };
}

async function runInstaller(
  sandbox: Sandbox,
  bar = "waybar",
  options: { apiBaseUrl?: string; integrationOnly?: boolean } = { apiBaseUrl },
): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: sandbox.root,
    QUICKDROP_LINUX_BINARY: sandbox.fakeBinary,
    QUICKDROP_QD_BINARY: sandbox.fakeQd,
    QUICKDROP_LAUNCHER_FILE: launcherSource,
    QUICKDROP_BAR_INTEGRATION_FILE: barInstallerSource,
    QUICKDROP_WAYBAR_PATCHER_FILE: waybarPatcherSource,
    QUICKDROP_OMARCHY_PLUGIN_SOURCE: omarchyPluginSource,
    QUICKDROP_BIN_DIR: sandbox.binDir,
    QUICKDROP_SHARE_DIR: sandbox.shareDir,
    QUICKDROP_CONFIG_DIR: sandbox.configDir,
    QUICKDROP_WAYBAR_CONFIG: sandbox.configPath,
    QUICKDROP_BAR: bar,
    QUICKDROP_BAR_NO_RESTART: "1",
  };
  delete env.QUICKDROP_API_BASE_URL;
  if (options.apiBaseUrl !== undefined) env.QUICKDROP_API_BASE_URL = options.apiBaseUrl;
  if (options.integrationOnly) env.QUICKDROP_INTEGRATION_ONLY = "1";

  await $`bash ${scriptPath}`.env(env).quiet();
}

async function isExecutable(path: string): Promise<boolean> {
  const info = await stat(path);
  return (info.mode & 0o111) !== 0;
}

describe.skipIf(!hasToolchain)("install-linux.sh", () => {
  test("installs the desktop, qd CLI/TUI, launchers, and Waybar module", async () => {
    const sandbox = await createSandbox({ config: WAYBAR_CONFIG });

    await runInstaller(sandbox);

    expect(await Bun.file(sandbox.binaryPath).exists()).toBe(true);
    expect(await Bun.file(sandbox.qdPath).exists()).toBe(true);
    expect(await Bun.file(sandbox.launcherPath).exists()).toBe(true);
    expect(await Bun.file(sandbox.legacyLauncherPath).exists()).toBe(true);
    expect(await isExecutable(sandbox.binaryPath)).toBe(true);
    expect(await isExecutable(sandbox.qdPath)).toBe(true);
    expect(await isExecutable(sandbox.launcherPath)).toBe(true);

    const installedLauncher = await readFile(sandbox.launcherPath, "utf8");
    const repoLauncher = await readFile(launcherSource, "utf8");
    expect(installedLauncher).toBe(repoLauncher);
    expect(await readFile(sandbox.legacyLauncherPath, "utf8")).toBe(repoLauncher);

    const patched = await readFile(sandbox.configPath, "utf8");
    expect(patched).toContain('"custom/quickdrop"');
    expect(patched).toContain(`"on-click": "'${sandbox.launcherPath}'"`);

    const config = await readFile(join(sandbox.configDir, "config.env"), "utf8");
    expect(config).toContain(`QUICKDROP_API_BASE_URL=${apiBaseUrl}`);
  });

  test("is idempotent across repeated runs", async () => {
    const sandbox = await createSandbox({ config: WAYBAR_CONFIG });

    await runInstaller(sandbox);
    const afterFirst = await readFile(sandbox.configPath, "utf8");
    await runInstaller(sandbox);
    const afterSecond = await readFile(sandbox.configPath, "utf8");

    expect(afterSecond).toBe(afterFirst);
  });

  test("updates both binaries on a repeated full installation", async () => {
    const sandbox = await createSandbox({ config: WAYBAR_CONFIG });
    await runInstaller(sandbox);
    await writeFile(sandbox.fakeBinary, "#!/bin/sh\necho quickdrop-v2\n");
    await writeFile(sandbox.fakeQd, "#!/bin/sh\necho qd-v2\n");

    await runInstaller(sandbox);

    expect(await readFile(sandbox.binaryPath, "utf8")).toContain("quickdrop-v2");
    expect(await readFile(sandbox.qdPath, "utf8")).toContain("qd-v2");
  });

  test("installs without a supported bar without failing", async () => {
    const sandbox = await createSandbox({ configDir: "missing" });

    await runInstaller(sandbox, "none");

    expect(await Bun.file(sandbox.binaryPath).exists()).toBe(true);
    expect(await Bun.file(sandbox.launcherPath).exists()).toBe(true);
    expect(await Bun.file(sandbox.configPath).exists()).toBe(false);
  });

  test("preserves an existing backend when a full reinstall has no explicit URL", async () => {
    const sandbox = await createSandbox();
    await mkdir(sandbox.configDir, { recursive: true });
    const configPath = join(sandbox.configDir, "config.env");
    await writeFile(configPath, "QUICKDROP_API_BASE_URL=http://127.0.0.1:3000\n");

    await runInstaller(sandbox, "none", {});

    expect(await readFile(configPath, "utf8")).toBe("QUICKDROP_API_BASE_URL=http://127.0.0.1:3000\n");
  });

  test("does not rewrite backend configuration during an integration-only install", async () => {
    const sandbox = await createSandbox();
    await mkdir(sandbox.configDir, { recursive: true });
    const configPath = join(sandbox.configDir, "config.env");
    await writeFile(configPath, "QUICKDROP_API_BASE_URL=http://127.0.0.1:3000\n");

    await runInstaller(sandbox, "none", { integrationOnly: true });

    expect(await readFile(configPath, "utf8")).toBe("QUICKDROP_API_BASE_URL=http://127.0.0.1:3000\n");
  });
});
