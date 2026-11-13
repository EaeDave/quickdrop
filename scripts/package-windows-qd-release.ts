import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { desktopVersion, writeChecksum } from "./desktop-release";

const sourceBinary = "cli/target/x86_64-pc-windows-msvc/release/qd.exe";
const releaseDirectory = join("cli", "target", "release");

if (!(await Bun.file(sourceBinary).exists())) {
  console.error("Build the qd Windows binary first: bun run qd:build:windows");
  process.exit(1);
}

const version = await desktopVersion();

await mkdir(releaseDirectory, { recursive: true });
const assetName = `qd_${version}_x86_64-windows.exe`;
const assetPath = join(releaseDirectory, assetName);
await Bun.write(assetPath, Bun.file(sourceBinary));

await writeChecksum(assetPath);
console.log(assetPath);
