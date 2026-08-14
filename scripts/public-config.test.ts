import { describe, expect, test } from "bun:test";
import { publicBaseUrl, updaterBaseUrl } from "./public-config";

describe("public deployment configuration", () => {
  test("normalizes a secure origin", () => {
    expect(publicBaseUrl({ QUICKDROP_PUBLIC_BASE_URL: " https://drop.example/ " })).toBe(
      "https://drop.example",
    );
    expect(updaterBaseUrl("https://drop.example")).toBe(
      "https://drop.example/desktop/update",
    );
  });

  test("rejects unsafe or deployment-specific URL shapes", () => {
    for (const value of [
      "http://drop.example",
      "https://user:password@drop.example",
      "https://drop.example/base",
      "https://drop.example?tenant=one",
    ]) {
      expect(() => publicBaseUrl({ QUICKDROP_PUBLIC_BASE_URL: value })).toThrow();
    }
  });

  test("allows the local backend only for development", () => {
    const env = { QUICKDROP_PUBLIC_BASE_URL: "http://127.0.0.1:3000" };
    expect(() => publicBaseUrl(env)).toThrow("https://");
    expect(publicBaseUrl(env, { allowLocal: true })).toBe("http://127.0.0.1:3000");
  });
});
