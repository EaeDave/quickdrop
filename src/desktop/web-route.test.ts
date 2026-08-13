import { describe, expect, test } from "bun:test";
import { roomCodeFromPathname, textRoomPath } from "./web-route";

describe("textRoomPath", () => {
  test("builds a canonical, normalized clipboard path", () => {
    expect(textRoomPath(" a ")).toBe("/A");
    expect(textRoomPath("server-1")).toBe("/SERVER-1");
  });
});

describe("roomCodeFromPathname", () => {
  test("decodes and normalizes the canonical path segment", () => {
    expect(roomCodeFromPathname("/%41")).toBe("A");
    expect(roomCodeFromPathname("/server-1")).toBe("SERVER-1");
    expect(roomCodeFromPathname("/")).toBeNull();
    expect(roomCodeFromPathname("/t/server-1")).toBeNull();
  });

  test("rejects malformed encoding and non-room paths", () => {
    expect(roomCodeFromPathname("/%ZZ")).toBeNull();
    expect(roomCodeFromPathname("/install.sh")).toBeNull();
  });
});
