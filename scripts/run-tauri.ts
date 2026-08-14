import { publicBaseUrl } from "./public-config";

const args = process.argv.slice(2);
const command = args.find((argument) => !argument.startsWith("-"));
const isDevelopment = command === "dev";

if (isDevelopment && !process.env.QUICKDROP_PUBLIC_BASE_URL) {
  process.env.QUICKDROP_PUBLIC_BASE_URL =
    process.env.QUICKDROP_API_BASE_URL ?? "http://127.0.0.1:3000";
}

const baseUrl = publicBaseUrl(process.env, { allowLocal: isDevelopment });
const updaterPublicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
if (!updaterPublicKey && !isDevelopment) {
  throw new Error("TAURI_UPDATER_PUBLIC_KEY is required to build the Tauri application");
}
process.env.QUICKDROP_PUBLIC_BASE_URL = baseUrl;

let inheritedConfig: Record<string, unknown> = {};
if (process.env.TAURI_CONFIG?.trim()) {
  try {
    inheritedConfig = JSON.parse(process.env.TAURI_CONFIG) as Record<string, unknown>;
  } catch {
    throw new Error("TAURI_CONFIG must contain valid JSON");
  }
}

const inheritedPlugins = (inheritedConfig.plugins ?? {}) as Record<string, unknown>;
const inheritedUpdater = (inheritedPlugins.updater ?? {}) as Record<string, unknown>;
process.env.TAURI_CONFIG = JSON.stringify({
  ...inheritedConfig,
  plugins: {
    ...inheritedPlugins,
    updater: {
      ...inheritedUpdater,
      ...(updaterPublicKey ? { pubkey: updaterPublicKey } : {}),
      endpoints: [`${baseUrl}/desktop/update/latest.json`],
    },
  },
});

const child = Bun.spawn(["bunx", "tauri", ...args], {
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
