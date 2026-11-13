import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
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
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
}

export async function signUpdater(asset: string): Promise<void> {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error("Restore the persistent TAURI_SIGNING_PRIVATE_KEY before packaging updater assets");
  }
  await run(["bun", "x", "--no-install", "tauri", "signer", "sign", asset], {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  });
  await verifyUpdaterSignature(asset, await Bun.file(`${asset}.sig`).text());
}

function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.toString("base64") !== value) throw new Error("Invalid updater signature or public key encoding");
  return decoded;
}

export async function verifyUpdaterSignature(
  asset: string,
  signature: string,
  publicKey = process.env.QUICKDROP_UPDATER_PUBLIC_KEY,
): Promise<void> {
  if (!publicKey?.trim()) throw new Error("Restore the existing TAURI_UPDATER_PUBLIC_KEY repository variable before signing");
  const keyLines = decodeBase64(publicKey.trim()).toString("utf8").trimEnd().split(/\r?\n/);
  const signatureLines = decodeBase64(signature.trim()).toString("utf8").trimEnd().split(/\r?\n/);
  if (keyLines.length !== 2 || !keyLines[0]!.startsWith("untrusted comment: ") ||
      signatureLines.length !== 4 || !signatureLines[0]!.startsWith("untrusted comment: ") ||
      !signatureLines[2]!.startsWith("trusted comment: ")) {
    throw new Error("Invalid Minisign public key or signature");
  }
  const key = decodeBase64(keyLines[1]!);
  const packet = decodeBase64(signatureLines[1]!);
  const commentSignature = decodeBase64(signatureLines[3]!);
  if (key.length !== 42 || !["Ed", "ED"].includes(key.subarray(0, 2).toString()) ||
      packet.length !== 74 || packet.subarray(0, 2).toString() !== "ED" ||
      commentSignature.length !== 64) {
    throw new Error("Expected prehashed Minisign Ed25519 updater signature");
  }
  if (!key.subarray(2, 10).equals(packet.subarray(2, 10))) {
    throw new Error(`Updater signature key ID does not match the configured public key: ${asset}`);
  }
  const ed25519Key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const dataSignature = packet.subarray(10);
  const trustedComment = Buffer.from(signatureLines[2]!.slice("trusted comment: ".length));
  if (!verify(null, Buffer.concat([dataSignature, trustedComment]), ed25519Key, commentSignature)) {
    throw new Error(`Invalid updater trusted-comment signature: ${asset}`);
  }
  const hash = createHash("blake2b512");
  for await (const chunk of createReadStream(asset)) hash.update(chunk);
  if (!verify(null, hash.digest(), ed25519Key, dataSignature)) {
    throw new Error(`Invalid updater data signature: ${asset}`);
  }
}

export async function writeChecksum(asset: string): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(asset)) hash.update(chunk);
  const checksum = hash.digest("hex");
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
