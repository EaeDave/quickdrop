import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { desktopVersion, writeChecksum } from "./desktop-release";

const releaseBinary = "desktop-gpui/target/release/quickdrop";
const qdReleaseBinary = "cli/target/x86_64-unknown-linux-gnu/release/qd";

if (!(await Bun.file(releaseBinary).exists())) {
  console.error("Build the Linux binary first: bun run desktop:build");
  process.exit(1);
}
if (!(await Bun.file(qdReleaseBinary).exists())) {
  console.error("Build the qd Linux binary first: bun run qd:build:linux");
  process.exit(1);
}

const version = await desktopVersion();

const assets = [
  {
    source: releaseBinary,
    path: join("desktop-gpui", "target", "release", `quickdrop_${version}_x86_64-linux`),
  },
  {
    source: qdReleaseBinary,
    path: join("cli", "target", "release", `qd_${version}_x86_64-linux`),
  },
];

for (const asset of assets) {
  await Bun.write(asset.path, Bun.file(asset.source));
  await chmod(asset.path, 0o755);
  console.log(asset.path);
}

await writeChecksum(assets[1]!.path);
