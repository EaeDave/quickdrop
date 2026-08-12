import { resolve } from "node:path";

const releaseBinary = resolve("src-tauri/target/release/quickdrop");

if (!(await Bun.file(releaseBinary).exists())) {
  console.error("Run bun run desktop:build first.");
  process.exit(1);
}

const installer = Bun.spawn(["bash", resolve("scripts/install-linux.sh")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    QUICKDROP_LINUX_BINARY: releaseBinary,
    QUICKDROP_LAUNCHER_FILE: resolve("scripts/quickdrop-launcher"),
    QUICKDROP_BAR_INTEGRATION_FILE: resolve("scripts/install-bar-integration.sh"),
    QUICKDROP_WAYBAR_PATCHER_FILE: resolve("scripts/install-waybar-module.py"),
    QUICKDROP_OMARCHY_PLUGIN_SOURCE: resolve("scripts/omarchy-quickdrop"),
  },
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await installer.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}
