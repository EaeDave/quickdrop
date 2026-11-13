import { describe, expect, test } from "bun:test";
import {
  assertReleasePlatform,
  assertReleaseRepository,
  assertUpdaterSigningSecret,
  nextVersion,
  parseVersion,
  replacePackageVersion,
} from "./release";

describe("release version selection", () => {
  test("increments semantic versions", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  });

  test("accepts an explicit version with or without v", () => {
    expect(nextVersion("1.2.3", "2.0.1")).toBe("2.0.1");
    expect(nextVersion("1.2.3", "v2.0.1")).toBe("2.0.1");
  });

  test("rejects malformed or ambiguous versions", () => {
    for (const version of ["1.2", "1.2.3-beta", "01.2.3", "latest"]) {
      expect(() => parseVersion(version)).toThrow("Invalid semantic version");
    }
  });
});

describe("release manifest updates", () => {
  test("replaces standard Cargo package versions only", () => {
    const manifest = `[package]\nname = "quickdrop-cli"\nversion = "0.1.2"\n\n[dependencies]\nexample = "0.1.2"\n`;
    expect(replacePackageVersion(manifest, "quickdrop-cli", "0.1.2", "0.1.3")).toBe(
      `[package]\nname = "quickdrop-cli"\nversion = "0.1.3"\n\n[dependencies]\nexample = "0.1.2"\n`,
    );
  });

  test("updates only the native desktop package in a Cargo lockfile", () => {
    const lock = `version = 4\n\n[[package]]\nname = "dependency"\nversion = "0.1.17"\n\n[[package]]\nname = "quickdrop"\nversion = "0.1.17"\ndependencies = ["dependency"]\n`;
    expect(replacePackageVersion(lock, "quickdrop", "0.1.17", "0.1.18")).toBe(
      `version = 4\n\n[[package]]\nname = "dependency"\nversion = "0.1.17"\n\n[[package]]\nname = "quickdrop"\nversion = "0.1.18"\ndependencies = ["dependency"]\n`,
    );
    expect(() => replacePackageVersion(lock, "quickdrop", "0.1.16", "0.1.18")).toThrow("Could not update quickdrop version");
    expect(() => replacePackageVersion(lock, "quickdrop-gpui", "0.1.17", "0.1.18")).toThrow("Could not update");
  });
});

describe("release host validation", () => {
  test("only accepts x86_64 Linux", () => {
    expect(() => assertReleasePlatform("linux", "x64")).not.toThrow();
    expect(() => assertReleasePlatform("linux", "arm64")).toThrow("x86_64 Linux");
    expect(() => assertReleasePlatform("win32", "x64")).toThrow("x86_64 Linux");
  });

  test("rejects a release repository different from the checkout", () => {
    expect(() => assertReleaseRepository("owner/quickdrop", "owner/quickdrop")).not.toThrow();
    expect(() => assertReleaseRepository("owner/fork", "owner/quickdrop")).toThrow(
      "does not match the current checkout",
    );
  });

  test("requires the existing repository signing key before publishing", () => {
    expect(() => assertUpdaterSigningSecret(["TAURI_SIGNING_PRIVATE_KEY"])).not.toThrow();
    expect(() => assertUpdaterSigningSecret([])).toThrow("Restore the persistent TAURI_SIGNING_PRIVATE_KEY");
    expect(() => assertUpdaterSigningSecret(["A_NEW_SIGNING_KEY"])).toThrow("Restore the persistent");
  });
});
