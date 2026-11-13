import { createHash } from "node:crypto";
import { basename } from "node:path";

export const desktopManifestPath = "desktop-gpui/Cargo.toml";

export function cargoPackageVersion(text: string, name = "quickdrop"): string {
  const manifest = Bun.TOML.parse(text) as { package?: { name?: string; version?: string } };
  const version = manifest.package?.version;
  if (manifest.package?.name !== name || !version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected ${name} package with a semantic version`);
  }
  return version;
}

export async function desktopVersion(): Promise<string> {
  const version = cargoPackageVersion(await Bun.file(desktopManifestPath).text());
  if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${version}`) {
    throw new Error(`Source version v${version} does not match ${process.env.RELEASE_TAG}`);
  }
  return version;
}

export async function run(command: string[], env = process.env): Promise<void> {
  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) {
    throw new Error(`Command failed: ${command.map((arg) => arg.startsWith("--password=") ? "--password=[redacted]" : arg).join(" ")}`);
  }
}

export async function signUpdater(asset: string): Promise<void> {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error("Restore the persistent TAURI_SIGNING_PRIVATE_KEY before packaging updater assets");
  }
  await run(["bun", "x", "--no-install", "tauri", "signer", "sign",
    `--password=${process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ""}`, asset]);
  if (!(await Bun.file(`${asset}.sig`).exists())) throw new Error(`Missing updater signature: ${asset}.sig`);
}

export async function writeChecksum(asset: string): Promise<void> {
  const checksum = createHash("sha256").update(new Uint8Array(await Bun.file(asset).arrayBuffer())).digest("hex");
  await Bun.write(`${asset}.sha256`, `${checksum}  ${basename(asset)}\n`);
  console.log(`${asset}.sha256`);
}

export function macosInfoPlist(version: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Invalid bundle version");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.quickdrop.quickdrop</string>
<key>CFBundleName</key><string>QuickDrop</string>
<key>CFBundleDisplayName</key><string>QuickDrop</string>
<key>CFBundleExecutable</key><string>quickdrop</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`;
}

if (import.meta.main) console.log(await desktopVersion());
