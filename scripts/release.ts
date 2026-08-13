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
      "QuickDrop releases must be started from x86_64 Linux; Windows assets are built in GitHub Actions",
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
  return unique[0]!;
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
  const packageBlock = new RegExp(`((?:^|\\n)(?:\\[\\[package\\]\\]|\\[package\\])\\nname = "${packageName}"\\nversion = ")${current}(" )?`);
  const match = packageBlock.exec(text);
  if (!match) throw new Error(`Could not update ${packageName} version in ${path}`);
  const updated = text.slice(0, match.index) + match[0].replace(`version = "${current}"`, `version = "${next}"`) + text.slice(match.index + match[0].length);
  await writeFile(path, updated);
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

  const linuxAssets = [
    `src-tauri/target/release/quickdrop_${next}_x86_64-linux`,
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
  console.log(`Published ${tag} with Linux assets; GitHub Actions is building the Windows assets.`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
