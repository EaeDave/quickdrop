import { describe, expect, test } from "bun:test";
import { assertReleasePlatform, nextVersion, parseVersion } from "./release";

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

describe("release host validation", () => {
  test("only accepts x86_64 Linux", () => {
    expect(() => assertReleasePlatform("linux", "x64")).not.toThrow();
    expect(() => assertReleasePlatform("linux", "arm64")).toThrow("x86_64 Linux");
    expect(() => assertReleasePlatform("win32", "x64")).toThrow("x86_64 Linux");
  });
});
