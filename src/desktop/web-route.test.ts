import { describe, expect, test } from "bun:test";
import { textRoomPath } from "./web-route";

describe("textRoomPath", () => {
  test("builds a canonical, normalized clipboard path", () => {
    expect(textRoomPath(" a ")).toBe("/t/A");
    expect(textRoomPath("server-1")).toBe("/t/SERVER-1");
  });
});
