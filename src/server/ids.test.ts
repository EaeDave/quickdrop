import { describe, expect, test } from "bun:test";
import { buildR2Key, sanitizeFilename } from "./ids";

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
