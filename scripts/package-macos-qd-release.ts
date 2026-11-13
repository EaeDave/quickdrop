import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { desktopVersion, writeChecksum } from "./desktop-release";
import { macosArchitectures, packageMacos } from "./package-desktop-release";

const qdReleaseDirectory = join("cli", "target", "release");
const version = await desktopVersion();

await mkdir(qdReleaseDirectory, { recursive: true });

for (const architecture of macosArchitectures) {
  const sourceBinary = join("cli", "target", architecture.target, "release", "qd");
  if (!(await Bun.file(sourceBinary).exists())) {
    console.error(`Build qd for ${architecture.target} first.`);
    process.exit(1);
  }

  const qdAssetName = `qd_${version}_${architecture.qd}`;
  const qdAssetPath = join(qdReleaseDirectory, qdAssetName);
  await Bun.write(qdAssetPath, Bun.file(sourceBinary));
  await chmod(qdAssetPath, 0o755);
  console.log(qdAssetPath);
  await writeChecksum(qdAssetPath);

}

await packageMacos(version);
