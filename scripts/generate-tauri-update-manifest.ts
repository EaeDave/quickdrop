import { join } from "node:path";

export type TauriUpdatePlatform = {
  signature: string;
  url: string;
};

export type TauriUpdateManifest = {
  version: string;
  notes: string;
  platforms: Record<string, TauriUpdatePlatform>;
};

export const updaterAssets = (version: string) => ({
  "linux-x86_64": `quickdrop_${version}_x86_64-linux`,
  "windows-x86_64": `QuickDrop_${version}_x64-setup.exe`,
  "darwin-aarch64": `QuickDrop_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64": `QuickDrop_${version}_x64.app.tar.gz`,
});

export function createTauriUpdateManifest(
  version: string,
  tag: string,
  signatures: Record<string, string>,
  updateBaseUrl = "https://quickdrop.eaedave.xyz/desktop/update",
): TauriUpdateManifest {
  const platforms: Record<string, TauriUpdatePlatform> = {};
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
  const config = (await Bun.file("src-tauri/tauri.conf.json").json()) as { version?: string };
  const version = config.version;
  if (!version) {
    throw new Error("src-tauri/tauri.conf.json has no version");
  }

  const tag = process.env.RELEASE_TAG ?? `v${version}`;
  const signatureDirectory = process.env.TAURI_UPDATE_SIGNATURE_DIR ?? "updater-signatures";
  const signatures: Record<string, string> = {};

  for (const asset of Object.values(updaterAssets(version))) {
    signatures[asset] = await Bun.file(join(signatureDirectory, `${asset}.sig`)).text();
  }

  const manifest = createTauriUpdateManifest(version, tag, signatures);
  const outputPath = process.env.TAURI_UPDATE_MANIFEST_PATH ?? "latest.json";
  await Bun.write(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(outputPath);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
