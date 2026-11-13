import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cargoPackageVersion, macosInfoPlist, writeChecksum } from "./desktop-release";

describe("native release metadata", () => {
  test("reads the production Cargo package without depending on field order", () => {
    expect(cargoPackageVersion('[package]\nedition = "2021"\nversion = "0.1.17"\nname = "quickdrop"\n[dependencies]\nexample = "9.8.7"\n')).toBe("0.1.17");
  });

  test("rejects another application or an invalid release version", () => {
    for (const manifest of [
      '[package]\nname = "quickdrop-gpui"\nversion = "0.1.17"',
      '[package]\nname = "quickdrop"\nversion = "01.2.3"',
      '[package]\nname = "quickdrop"\nversion = "0.1.17-beta"',
      '[package]\nname = "quickdrop"',
    ]) expect(() => cargoPackageVersion(manifest)).toThrow("Expected quickdrop package");
  });

  test("macOS app preserves updater and accessory identities", () => {
    const plist = macosInfoPlist("1.2.3");
    const values = Object.fromEntries([...plist.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)]
      .map((match) => [match[1], match[2]]));
    expect(values.CFBundleIdentifier).toBe("dev.quickdrop.quickdrop");
    expect(values.CFBundleExecutable).toBe("quickdrop");
    expect(values.CFBundleShortVersionString).toBe("1.2.3");
    expect(values.CFBundleVersion).toBe("1.2.3");
    expect(plist).toMatch(/<key>LSUIElement<\/key>\s*<true\s*\/>/);
    expect(() => macosInfoPlist('1.2.3</string>')).toThrow("Invalid bundle version");
  });

  test("writes installer-compatible SHA256 files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quickdrop-release-test-"));
    try {
      const path = join(directory, "qd_1.2.3_aarch64-macos");
      await Bun.write(path, "release payload");
      await writeChecksum(path);
      expect(await Bun.file(`${path}.sha256`).text()).toBe(
        `${createHash("sha256").update("release payload").digest("hex")}  qd_1.2.3_aarch64-macos\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
