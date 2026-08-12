import { describe, expect, test } from "bun:test";
import { buildR2Key, isValidCustomSessionCode, sanitizeFilename } from "./ids";

describe("sanitizeFilename", () => {
  test("normalizes unsafe characters and path segments", () => {
    expect(sanitizeFilename("../../relatório final.pdf")).toBe("relat_rio_final.pdf");
  });

  test("uses file for empty or unsafe names", () => {
    expect(sanitizeFilename(undefined)).toBe("file");
    expect(sanitizeFilename("...")).toBe("file");
  });
});

describe("buildR2Key", () => {
  test("builds UTC year month key with sanitized filename", () => {
    expect(buildR2Key("6e4d7f1a", "relatório final.pdf", new Date("2026-06-22T00:00:00Z"))).toBe(
      "uploads/2026/06/6e4d7f1a-relat_rio_final.pdf",
    );
  });
});

describe("isValidCustomSessionCode", () => {
  test("accepts short human codes", () => {
    expect(isValidCustomSessionCode("a")).toBe(true);
    expect(isValidCustomSessionCode("server-1")).toBe(true);
    expect(isValidCustomSessionCode("DEV_TEST")).toBe(true);
  });

  test("rejects empty, long, spaced, or ambiguous path input", () => {
    expect(isValidCustomSessionCode("")).toBe(false);
    expect(isValidCustomSessionCode("a".repeat(17))).toBe(false);
    expect(isValidCustomSessionCode("MY ROOM")).toBe(false);
    expect(isValidCustomSessionCode("A/B")).toBe(false);
  });
});
