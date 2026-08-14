import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const tauriConfigPath = "src-tauri/tauri.conf.json";
const releaseDirectory = join("cli", "target", "release");
const architectures = [
  { target: "aarch64-apple-darwin", asset: "aarch64-macos" },
  { target: "x86_64-apple-darwin", asset: "x86_64-macos" },
] as const;

const { version } = (await Bun.file(tauriConfigPath).json()) as {
  version: string;
};
if (!version) {
  console.error(`Could not read version from ${tauriConfigPath}`);
  process.exit(1);
}

await mkdir(releaseDirectory, { recursive: true });

for (const architecture of architectures) {
  const sourceBinary = join(
    "cli",
    "target",
    architecture.target,
    "release",
    "qd",
  );
  if (!(await Bun.file(sourceBinary).exists())) {
    console.error(`Build qd for ${architecture.target} first.`);
    process.exit(1);
  }

  const assetName = `qd_${version}_${architecture.asset}`;
  const assetPath = join(releaseDirectory, assetName);
  const checksumPath = `${assetPath}.sha256`;
  await Bun.write(assetPath, Bun.file(sourceBinary));
  await chmod(assetPath, 0o755);

  const bytes = await Bun.file(assetPath).arrayBuffer();
  const checksum = createHash("sha256")
    .update(new Uint8Array(bytes))
    .digest("hex");
  await Bun.write(checksumPath, `${checksum}  ${assetName}\n`);

  console.log(assetPath);
  console.log(checksumPath);
}
