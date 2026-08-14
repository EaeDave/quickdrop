import { describe, expect, test } from "bun:test";
import { createTauriUpdateManifest, updaterAssets } from "./generate-tauri-update-manifest";

describe("Tauri update manifest", () => {
  test("maps signed desktop artifacts to every supported platform", () => {
    const assets = updaterAssets("1.2.3");
    const signatures = Object.fromEntries(
      Object.values(assets).map((asset) => [asset, `signature for ${asset}\n`]),
    );

    const manifest = createTauriUpdateManifest(
      "1.2.3",
      "EaeDave/quickdrop",
      "v1.2.3",
      signatures,
    );

    expect(manifest.version).toBe("1.2.3");
    expect(Object.keys(manifest.platforms)).toEqual([
      "linux-x86_64",
      "windows-x86_64",
      "darwin-aarch64",
      "darwin-x86_64",
    ]);
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      signature: "signature for QuickDrop_1.2.3_aarch64.app.tar.gz",
      url: "https://github.com/EaeDave/quickdrop/releases/download/v1.2.3/QuickDrop_1.2.3_aarch64.app.tar.gz",
    });
  });

  test("rejects a platform without a matching signature", () => {
    expect(() => createTauriUpdateManifest("1.2.3", "EaeDave/quickdrop", "v1.2.3", {})).toThrow(
      "Missing updater signature",
    );
  });
});
