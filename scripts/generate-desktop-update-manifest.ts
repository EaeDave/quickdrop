import { join } from "node:path";
import { publicBaseUrl, updaterBaseUrl } from "./public-config";
import { desktopVersion } from "./desktop-release";

export type DesktopUpdatePlatform = {
  signature: string;
  url: string;
};

export type DesktopUpdateManifest = {
  version: string;
  notes: string;
  platforms: Record<string, DesktopUpdatePlatform>;
};

export const updaterAssets = (version: string) => ({
  "linux-x86_64": `quickdrop_${version}_x86_64-linux`,
  "windows-x86_64": `QuickDrop_${version}_x64-setup.exe`,
  "darwin-aarch64": `QuickDrop_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64": `QuickDrop_${version}_x64.app.tar.gz`,
});

export function createDesktopUpdateManifest(
  version: string,
  tag: string,
  signatures: Record<string, string>,
  updateBaseUrl: string,
): DesktopUpdateManifest {
  const platforms: Record<string, DesktopUpdatePlatform> = {};
  for (const [platform, asset] of Object.entries(updaterAssets(version))) {
    const signature = signatures[asset]?.trim();
    if (!signature) {
      throw new Error(`Missing updater signature for ${asset}`);
    }
    platforms[platform] = {
      signature,
      url: `${updateBaseUrl}/${version}/${platform}`,
    };
  }

  return {
    version,
    notes: `QuickDrop ${tag}`,
    platforms,
  };
}

async function main(): Promise<void> {
  const version = await desktopVersion();

  const tag = process.env.RELEASE_TAG ?? `v${version}`;
  if (tag !== `v${version}`) {
    throw new Error(`RELEASE_TAG must be v${version}, received ${tag}`);
  }
  const signatureDirectory = process.env.QUICKDROP_UPDATE_SIGNATURE_DIR ?? "updater-signatures";
  const signatures: Record<string, string> = {};

  for (const asset of Object.values(updaterAssets(version))) {
    signatures[asset] = await Bun.file(join(signatureDirectory, `${asset}.sig`)).text();
  }

  const manifest = createDesktopUpdateManifest(
    version,
    tag,
    signatures,
    updaterBaseUrl(publicBaseUrl()),
  );
  const outputPath = process.env.QUICKDROP_UPDATE_MANIFEST_PATH ?? "latest.json";
  await Bun.write(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(outputPath);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
