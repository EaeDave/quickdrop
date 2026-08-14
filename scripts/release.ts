import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const VERSION_FILES = [
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "cli/Cargo.toml",
  "cli/Cargo.lock",
] as const;

type ReleaseKind = "patch" | "minor" | "major";

export function parseVersion(value: string): [number, number, number] {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nextVersion(current: string, requested: string): string {
  if (!["patch", "minor", "major"].includes(requested)) {
    return parseVersion(requested).join(".");
  }
  const [major, minor, patch] = parseVersion(current);
  switch (requested as ReleaseKind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

export function assertReleasePlatform(platform: NodeJS.Platform, arch: string): void {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error(
      "QuickDrop releases must be started from x86_64 Linux; Windows and macOS assets are built in GitHub Actions",
    );
  }
}

async function manifestVersions(): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const tauriConfig = (await Bun.file(VERSION_FILES[0]).json()) as { version?: string };
  if (!tauriConfig.version) throw new Error(`${VERSION_FILES[0]} has no version`);
  versions.set(VERSION_FILES[0], tauriConfig.version);

  for (const path of VERSION_FILES.slice(1)) {
    const text = await readFile(path, "utf8");
    const packageName = path.startsWith("cli/") ? "quickdrop-cli" : "quickdrop";
    const packageBlock = new RegExp(`(?:^|\\n)(?:\\[\\[package\\]\\]|\\[package\\])\\nname = "${packageName}"\\nversion = "([^"]+)"`);
    const match = packageBlock.exec(text);
    if (!match) throw new Error(`Could not find ${packageName} version in ${path}`);
    versions.set(path, match[1]!);
  }
  return versions;
}

export async function currentVersion(): Promise<string> {
  const versions = await manifestVersions();
  const unique = [...new Set(versions.values())];
  if (unique.length !== 1) {
    throw new Error(
      `Release versions disagree:\n${[...versions].map(([path, version]) => `  ${path}: ${version}`).join("\n")}`,
    );
  }
  const version = unique[0]!;
  parseVersion(version);
  return version;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replacePackageVersion(
  text: string,
  packageName: string,
  current: string,
  next: string,
): string {
  const packageBlock = new RegExp(
    `((?:^|\\n)(?:\\[\\[package\\]\\]|\\[package\\])\\nname = "${escapeRegExp(packageName)}"\\nversion = ")${escapeRegExp(current)}(")`,
  );
  if (!packageBlock.test(text)) {
    throw new Error(`Could not update ${packageName} version`);
  }
  return text.replace(packageBlock, (_match, prefix: string, suffix: string) => `${prefix}${next}${suffix}`);
}

async function replaceVersion(path: string, current: string, next: string): Promise<void> {
  if (path.endsWith("tauri.conf.json")) {
    const config = (await Bun.file(path).json()) as Record<string, unknown>;
    config.version = next;
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  const packageName = path.startsWith("cli/") ? "quickdrop-cli" : "quickdrop";
  const text = await readFile(path, "utf8");
  await writeFile(path, replacePackageVersion(text, packageName, current, next));
}

async function output(command: string[]): Promise<string> {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
  return result.stdout.toString().trim();
}

async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  if ((await process.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
}

async function configureUpdaterSigning(): Promise<void> {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return;
  }

  const home = process.env.HOME;
  if (!home) throw new Error("HOME is required to locate the Tauri updater signing key");
  const keyPath = `${home}/.config/quickdrop-release/updater.key`;
  if (!(await Bun.file(keyPath).exists())) {
    throw new Error(
      `Missing Tauri updater signing key at ${keyPath}. Restore the release key before publishing.`,
    );
  }
  process.env.TAURI_SIGNING_PRIVATE_KEY_PATH = keyPath;
}

async function preflight(tag: string): Promise<void> {
  if ((await output(["git", "branch", "--show-current"])) !== "main") {
    throw new Error("Releases must be created from main");
  }
  if (await output(["git", "status", "--porcelain"])) {
    throw new Error("Working tree must be clean before releasing");
  }
  await run(["git", "fetch", "origin", "main", "--tags"]);
  if ((await output(["git", "rev-parse", "HEAD"])) !== (await output(["git", "rev-parse", "origin/main"]))) {
    throw new Error("Local main must match origin/main before releasing");
  }
  if (Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).exitCode === 0) {
    throw new Error(`Tag ${tag} already exists`);
  }
}

type ReleaseAsset = { name: string; digest: string };

async function waitForPlatformWorkflow(tag: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const raw = await output([
      "gh",
      "run",
      "list",
      "--workflow",
      "release.yml",
      "--event",
      "push",
      "--branch",
      tag,
      "--limit",
      "1",
      "--json",
      "databaseId",
    ]);
    const runs = JSON.parse(raw) as Array<{ databaseId: number }>;
    if (runs[0]) {
      await run(["gh", "run", "watch", String(runs[0].databaseId), "--exit-status"]);
      return;
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`Platform release workflow did not start for ${tag}`);
}

async function responseDigest(response: Response): Promise<string> {
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function verifyPublicAssets(tag: string, version: string): Promise<void> {
  const raw = await output(["gh", "release", "view", tag, "--json", "assets"]);
  const release = JSON.parse(raw) as { assets: ReleaseAsset[] };
  const assetsByName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const endpoints = new Map([
    ["/linux/latest", `quickdrop_${version}_x86_64-linux`],
    ["/linux/qd/latest", `qd_${version}_x86_64-linux`],
    ["/linux/qd/latest.sha256", `qd_${version}_x86_64-linux.sha256`],
    ["/windows/latest.exe", `QuickDrop_${version}_x64-setup.exe`],
    ["/windows/qd/latest.exe", `qd_${version}_x86_64-windows.exe`],
    ["/windows/qd/latest.sha256", `qd_${version}_x86_64-windows.exe.sha256`],
    ["/macos/aarch64/latest.dmg", `QuickDrop_${version}_aarch64.dmg`],
    ["/macos/aarch64/latest.dmg.sha256", `QuickDrop_${version}_aarch64.dmg.sha256`],
    ["/macos/x86_64/latest.dmg", `QuickDrop_${version}_x64.dmg`],
    ["/macos/x86_64/latest.dmg.sha256", `QuickDrop_${version}_x64.dmg.sha256`],
    ["/macos/qd/aarch64/latest", `qd_${version}_aarch64-macos`],
    ["/macos/qd/aarch64/latest.sha256", `qd_${version}_aarch64-macos.sha256`],
    ["/macos/qd/x86_64/latest", `qd_${version}_x86_64-macos`],
    ["/macos/qd/x86_64/latest.sha256", `qd_${version}_x86_64-macos.sha256`],
  ]);
  for (const assetName of endpoints.values()) {
    if (!assetsByName.has(assetName)) throw new Error(`Release is missing ${assetName}`);
  }
  const updaterAssetNames = [
    `quickdrop_${version}_x86_64-linux.sig`,
    `QuickDrop_${version}_x64-setup.exe.sig`,
    `QuickDrop_${version}_aarch64.app.tar.gz`,
    `QuickDrop_${version}_aarch64.app.tar.gz.sig`,
    `QuickDrop_${version}_x64.app.tar.gz`,
    `QuickDrop_${version}_x64.app.tar.gz.sig`,
    "latest.json",
  ];
  for (const assetName of updaterAssetNames) {
    if (!assetsByName.has(assetName)) throw new Error(`Release is missing ${assetName}`);
  }

  const pending = new Map(endpoints);
  for (let attempt = 0; attempt < 36 && pending.size > 0; attempt += 1) {
    await Promise.all(
      [...pending].map(async ([endpoint, assetName]) => {
        try {
          const response = await fetch(`https://quickdrop.eaedave.xyz${endpoint}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
          });
          if ((await responseDigest(response)) === assetsByName.get(assetName)!.digest) {
            pending.delete(endpoint);
          }
        } catch {
          // The public proxy caches release metadata briefly; retry below.
        }
      }),
    );
    if (pending.size > 0) await Bun.sleep(10_000);
  }
  if (pending.size > 0) {
    throw new Error(`Public downloads did not update: ${[...pending.keys()].join(", ")}`);
  }

  const expectedUpdaterPlatforms = [
    "linux-x86_64",
    "windows-x86_64",
    "darwin-aarch64",
    "darwin-x86_64",
  ];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(
        "https://github.com/EaeDave/quickdrop/releases/latest/download/latest.json",
        { cache: "no-store", signal: AbortSignal.timeout(15_000) },
      );
      const manifest = (await response.json()) as {
        version?: string;
        platforms?: Record<string, { signature?: string; url?: string }>;
      };
      const valid =
        response.ok &&
        manifest.version === version &&
        expectedUpdaterPlatforms.every((platform) => {
          const entry = manifest.platforms?.[platform];
          return Boolean(entry?.signature?.trim() && entry.url?.includes(`/releases/download/${tag}/`));
        });
      if (valid) return;
    } catch {
      // GitHub's latest-release redirect can lag briefly after publishing.
    }
    await Bun.sleep(10_000);
  }
  throw new Error(`Desktop updater manifest did not update to ${tag}`);
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  const checkOnly = requested === "--check";
  const current = await currentVersion();
  if (checkOnly) {
    console.log(`Release manifests agree on v${current}`);
    return;
  }
  if (!requested) throw new Error("Usage: bun run release <patch|minor|major|X.Y.Z>");
  assertReleasePlatform(process.platform, process.arch);

  const next = nextVersion(current, requested);
  if (next === current) throw new Error(`Version is already ${current}`);
  const tag = `v${next}`;
  await preflight(tag);
  await configureUpdaterSigning();

  for (const path of VERSION_FILES) await replaceVersion(path, current, next);
  await run(["cargo", "check", "--manifest-path", "cli/Cargo.toml"]);
  await run(["cargo", "check", "--manifest-path", "src-tauri/Cargo.toml"]);
  await run(["bun", "tauri", "build", "--ci", "--no-bundle"]);
  await run([
    "cargo",
    "build",
    "--release",
    "--target",
    "x86_64-unknown-linux-gnu",
    "--manifest-path",
    "cli/Cargo.toml",
  ]);
  await run(["bun", "run", "scripts/package-linux-release.ts"]);
  await run([
    "bun",
    "tauri",
    "signer",
    "sign",
    "-p",
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    `src-tauri/target/release/quickdrop_${next}_x86_64-linux`,
  ]);

  const linuxAssets = [
    `src-tauri/target/release/quickdrop_${next}_x86_64-linux`,
    `src-tauri/target/release/quickdrop_${next}_x86_64-linux.sig`,
    `cli/target/release/qd_${next}_x86_64-linux`,
    `cli/target/release/qd_${next}_x86_64-linux.sha256`,
  ];
  await run(["git", "add", ...VERSION_FILES]);
  await run(["git", "commit", "-m", `chore: release ${tag}`]);
  await run(["git", "tag", "-a", tag, "-m", `QuickDrop ${tag}`]);
  await run(["git", "push", "--atomic", "origin", "main", tag]);
  await run([
    "gh",
    "release",
    "create",
    tag,
    ...linuxAssets,
    "--verify-tag",
    "--generate-notes",
    "--title",
    tag,
  ]);
  await waitForPlatformWorkflow(tag);
  await verifyPublicAssets(tag, next);
  console.log(`Published and verified ${tag} for Linux, Windows, and macOS.`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
