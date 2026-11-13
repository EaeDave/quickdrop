import { describe, expect, test } from "bun:test";
import { createDesktopUpdateManifest, updaterAssets } from "./generate-desktop-update-manifest";

describe("desktop update manifest", () => {
  test("maps signed desktop artifacts to every supported platform", () => {
    const assets = updaterAssets("1.2.3");
    expect(assets).toEqual({
      "linux-x86_64": "quickdrop_1.2.3_x86_64-linux",
      "windows-x86_64": "QuickDrop_1.2.3_x64-setup.exe",
      "darwin-aarch64": "QuickDrop_1.2.3_aarch64.app.tar.gz",
      "darwin-x86_64": "QuickDrop_1.2.3_x64.app.tar.gz",
    });
    const signatures = Object.fromEntries(
      Object.values(assets).map((asset) => [asset, `signature for ${asset}\n`]),
    );

    const manifest = createDesktopUpdateManifest(
      "1.2.3",
      "v1.2.3",
      signatures,
      "https://drop.example/desktop/update",
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
      url: "https://drop.example/desktop/update/1.2.3/darwin-aarch64",
    });
    for (const [platform, asset] of Object.entries(assets)) {
      expect(manifest.platforms[platform]).toEqual({
        signature: `signature for ${asset}`,
        url: `https://drop.example/desktop/update/1.2.3/${platform}`,
      });
    }
  });

  test("rejects a platform without a matching signature", () => {
    expect(() =>
      createDesktopUpdateManifest(
        "1.2.3",
        "v1.2.3",
        {},
        "https://drop.example/desktop/update",
      ),
    ).toThrow(
      "Missing updater signature",
    );
  });
});
