import { chmod, mkdir, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const build = Bun.spawn([
  "mise", "exec", "rust@stable", "--", "cargo", "build",
  "--locked", "--manifest-path", "desktop-gpui/Cargo.toml", "-j", "4",
], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const buildExit = await build.exited;
if (buildExit !== 0) process.exit(buildExit);

const env = { ...process.env };
env.QUICKDROP_API_BASE_URL ??= env.QUICKDROP_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000";
const binary = resolve(`desktop-gpui/target/debug/quickdrop${process.platform === "win32" ? ".exe" : ""}`);
if (process.platform === "linux" && !env.HYPRLAND_INSTANCE_SIGNATURE) {
  const directory = `${env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`}/hypr`;
  const instances = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (instances.length === 1) env.HYPRLAND_INSTANCE_SIGNATURE = instances[0];
}

const useLauncher = process.platform === "linux" && Boolean(env.HYPRLAND_INSTANCE_SIGNATURE);
if (useLauncher) {
  env.QUICKDROP_BIN = binary;
  const directory = join(env.XDG_CACHE_HOME ?? join(env.HOME!, ".cache"), "quickdrop");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  env.QUICKDROP_LOG_FILE = join(directory, "desktop-dev.log");
  const log = await open(env.QUICKDROP_LOG_FILE, "a", 0o600);
  await log.close();
  await chmod(env.QUICKDROP_LOG_FILE, 0o600);
  console.log(`Desktop logs: ${env.QUICKDROP_LOG_FILE}`);
}
const child = Bun.spawn(useLauncher ? ["bash", resolve("scripts/quickdrop-launcher")] : [binary], {
  env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
