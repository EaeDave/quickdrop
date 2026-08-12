import { describe, expect, test } from "bun:test";
import { roomCodeFromPathname, textRoomPath } from "./web-route";

describe("textRoomPath", () => {
  test("builds a canonical, normalized clipboard path", () => {
    expect(textRoomPath(" a ")).toBe("/t/A");
    expect(textRoomPath("server-1")).toBe("/t/SERVER-1");
  });
});

describe("roomCodeFromPathname", () => {
  test("decodes and normalizes the canonical path segment", () => {
    expect(roomCodeFromPathname("/t/%41")).toBe("A");
    expect(roomCodeFromPathname("/t/server-1")).toBe("SERVER-1");
    expect(roomCodeFromPathname("/t")).toBeNull();
  });

  test("does not crash on malformed percent encoding", () => {
    expect(roomCodeFromPathname("/t/%ZZ")).toBe("%ZZ");
  });
});
