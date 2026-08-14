import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

const tauriConfigPath = "src-tauri/tauri.conf.json";
const qdReleaseDirectory = join("cli", "target", "release");
const architectures = [
  {
    target: "aarch64-apple-darwin",
    qdAsset: "aarch64-macos",
    desktopAsset: (version: string) => `QuickDrop_${version}_aarch64.dmg`,
    updaterAsset: (version: string) => `QuickDrop_${version}_aarch64.app.tar.gz`,
  },
  {
    target: "x86_64-apple-darwin",
    qdAsset: "x86_64-macos",
    desktopAsset: (version: string) => `QuickDrop_${version}_x64.dmg`,
    updaterAsset: (version: string) => `QuickDrop_${version}_x64.app.tar.gz`,
  },
] as const;

const { version } = (await Bun.file(tauriConfigPath).json()) as { version: string };
if (!version) {
  console.error(`Could not read version from ${tauriConfigPath}`);
  process.exit(1);
}

async function writeChecksum(assetPath: string): Promise<string> {
  const bytes = await Bun.file(assetPath).arrayBuffer();
  const checksum = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  const checksumPath = `${assetPath}.sha256`;
  await Bun.write(checksumPath, `${checksum}  ${basename(assetPath)}\n`);
  console.log(checksumPath);
  return checksumPath;
}

await mkdir(qdReleaseDirectory, { recursive: true });

for (const architecture of architectures) {
  const sourceBinary = join("cli", "target", architecture.target, "release", "qd");
  if (!(await Bun.file(sourceBinary).exists())) {
    console.error(`Build qd for ${architecture.target} first.`);
    process.exit(1);
  }

  const qdAssetName = `qd_${version}_${architecture.qdAsset}`;
  const qdAssetPath = join(qdReleaseDirectory, qdAssetName);
  await Bun.write(qdAssetPath, Bun.file(sourceBinary));
  await chmod(qdAssetPath, 0o755);
  console.log(qdAssetPath);
  await writeChecksum(qdAssetPath);

  const desktopAssetName = architecture.desktopAsset(version);
  const desktopAssetPath = join(
    "src-tauri",
    "target",
    architecture.target,
    "release",
    "bundle",
    "dmg",
    desktopAssetName,
  );
  if (!(await Bun.file(desktopAssetPath).exists())) {
    console.error(`Build the QuickDrop macOS DMG for ${architecture.target} first.`);
    process.exit(1);
  }
  console.log(desktopAssetPath);
  await writeChecksum(desktopAssetPath);

  const macosBundleDirectory = join(
    "src-tauri",
    "target",
    architecture.target,
    "release",
    "bundle",
    "macos",
  );
  const updaterSourcePath = join(macosBundleDirectory, "QuickDrop.app.tar.gz");
  const updaterSignatureSourcePath = `${updaterSourcePath}.sig`;
  if (!(await Bun.file(updaterSourcePath).exists()) || !(await Bun.file(updaterSignatureSourcePath).exists())) {
    console.error(`Build signed updater artifacts for ${architecture.target} first.`);
    process.exit(1);
  }

  const updaterAssetPath = join(macosBundleDirectory, architecture.updaterAsset(version));
  await Bun.write(updaterAssetPath, Bun.file(updaterSourcePath));
  await Bun.write(`${updaterAssetPath}.sig`, Bun.file(updaterSignatureSourcePath));
  console.log(updaterAssetPath);
  console.log(`${updaterAssetPath}.sig`);
}
