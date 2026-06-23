import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { installWaybarModule } from "./install-waybar-module.ts";

const releaseBinary = "src-tauri/target/release/quickdrop";
const home = process.env.HOME;

if (!home) {
  console.error("HOME is not set.");
  process.exit(1);
}

if (!(await Bun.file(releaseBinary).exists())) {
  console.error("Run bun run desktop:build first.");
  process.exit(1);
}

const binDir = join(home, ".local", "bin");
const target = join(binDir, "quickdrop");
await mkdir(binDir, { recursive: true });
await Bun.write(target, Bun.file(releaseBinary));
await chmod(target, 0o755);
await installWaybarModule({ launcherPath: join(binDir, "quickdrop-waybar") });

console.log("Installed quickdrop to ~/.local/bin/quickdrop");
console.log("Installed quickdrop-waybar to ~/.local/bin/quickdrop-waybar");
