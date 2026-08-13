import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

const releaseBinary = "src-tauri/target/release/quickdrop";
const qdReleaseBinary = "cli/target/x86_64-unknown-linux-gnu/release/qd";
const tauriConfigPath = "src-tauri/tauri.conf.json";

if (!(await Bun.file(releaseBinary).exists())) {
  console.error("Build the Linux binary first: bun run desktop:build");
  process.exit(1);
}
if (!(await Bun.file(qdReleaseBinary).exists())) {
  console.error("Build the qd Linux binary first: bun run qd:build:linux");
  process.exit(1);
}

const { version } = (await Bun.file(tauriConfigPath).json()) as { version: string };

if (!version) {
  console.error(`Could not read version from ${tauriConfigPath}`);
  process.exit(1);
}

const assets = [
  {
    source: releaseBinary,
    path: join("src-tauri", "target", "release", `quickdrop_${version}_x86_64-linux`),
  },
  {
    source: qdReleaseBinary,
    path: join("cli", "target", "release", `qd_${version}_x86_64-linux`),
  },
];

const qdChecksumPath = `${assets[1]!.path}.sha256`;

for (const asset of assets) {
  await Bun.write(asset.path, Bun.file(asset.source));
  await chmod(asset.path, 0o755);
  console.log(asset.path);
}

const qdBytes = await Bun.file(assets[1]!.path).arrayBuffer();
const qdChecksum = createHash("sha256").update(new Uint8Array(qdBytes)).digest("hex");
await Bun.write(qdChecksumPath, `${qdChecksum}  ${assets[1]!.path.split("/").at(-1)}\n`);
console.log(qdChecksumPath);
