import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const sourceBinary = "cli/target/x86_64-pc-windows-msvc/release/qd.exe";
const tauriConfigPath = "src-tauri/tauri.conf.json";
const releaseDirectory = join("cli", "target", "release");

if (!(await Bun.file(sourceBinary).exists())) {
  console.error("Build the qd Windows binary first: bun run qd:build:windows");
  process.exit(1);
}

const { version } = (await Bun.file(tauriConfigPath).json()) as { version: string };
if (!version) {
  console.error(`Could not read version from ${tauriConfigPath}`);
  process.exit(1);
}

await mkdir(releaseDirectory, { recursive: true });
const assetName = `qd_${version}_x86_64-windows.exe`;
const assetPath = join(releaseDirectory, assetName);
const checksumPath = `${assetPath}.sha256`;
await Bun.write(assetPath, Bun.file(sourceBinary));

const bytes = await Bun.file(assetPath).arrayBuffer();
const checksum = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
await Bun.write(checksumPath, `${checksum}  ${assetName}\n`);

const updaterInstallerPath = join(
  "src-tauri",
  "target",
  "x86_64-pc-windows-msvc",
  "release",
  "bundle",
  "nsis",
  `QuickDrop_${version}_x64-setup.exe`,
);
if (!(await Bun.file(`${updaterInstallerPath}.sig`).exists())) {
  console.error(`Missing Windows updater signature: ${updaterInstallerPath}.sig`);
  process.exit(1);
}

console.log(assetPath);
console.log(checksumPath);
console.log(`${updaterInstallerPath}.sig`);
