import { chmod } from "node:fs/promises";
import { join } from "node:path";

const releaseBinary = "src-tauri/target/release/quickdrop";
const tauriConfigPath = "src-tauri/tauri.conf.json";

if (!(await Bun.file(releaseBinary).exists())) {
  console.error("Build the Linux binary first: bun run desktop:build");
  process.exit(1);
}

const { version } = (await Bun.file(tauriConfigPath).json()) as { version: string };

if (!version) {
  console.error(`Could not read version from ${tauriConfigPath}`);
  process.exit(1);
}

const assetName = `quickdrop_${version}_x86_64-linux`;
const assetPath = join("src-tauri", "target", "release", assetName);

await Bun.write(assetPath, Bun.file(releaseBinary));
await chmod(assetPath, 0o755);

console.log(assetPath);
