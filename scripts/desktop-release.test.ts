import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cargoPackageVersion, macosInfoPlist, verifyUpdaterSignature, writeChecksum } from "./desktop-release";

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

  test("verifies updater bytes, signing identity, and trusted comment before publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quickdrop-signature-test-"));
    const encode = (value: string) => Buffer.from(value).toString("base64");
    const publicKey = encode("untrusted comment: test\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
    const text = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
    try {
      const path = join(directory, "payload");
      await Bun.write(path, "test");
      await verifyUpdaterSignature(path, encode(text), publicKey);
      await expect(verifyUpdaterSignature(path, encode(text.replace("file:test", "file:evil")), publicKey))
        .rejects.toThrow("trusted-comment");
      const wrongKey = Buffer.from(publicKey, "base64").toString().split("\n");
      const packet = Buffer.from(wrongKey[1]!, "base64");
      packet[2] = packet[2]! ^ 1;
      wrongKey[1] = packet.toString("base64");
      await expect(verifyUpdaterSignature(path, encode(text), encode(wrongKey.join("\n"))))
        .rejects.toThrow("key ID");
      await Bun.write(path, "Test");
      await expect(verifyUpdaterSignature(path, encode(text), publicKey)).rejects.toThrow("data signature");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
