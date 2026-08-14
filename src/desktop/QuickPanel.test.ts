import { describe, expect, test } from "bun:test";
import { isPinReady, isRoomWritable, shouldNotifyRemoteDrop } from "./QuickPanel";

describe("QuickPanel notifications", () => {
  test("notifies only new drops from another connected client", () => {
    expect(shouldNotifyRemoteDrop("remote", "self", false)).toBe(true);
    expect(shouldNotifyRemoteDrop("self", "self", false)).toBe(false);
    expect(shouldNotifyRemoteDrop("remote", null, false)).toBe(false);
    expect(shouldNotifyRemoteDrop("remote", "self", true)).toBe(false);
  });
});

describe("QuickPanel room readiness", () => {
  test("rejects whitespace-only PINs", () => {
    expect(isPinReady("    ")).toBe(false);
    expect(isPinReady(" 1234 ")).toBe(true);
  });

  test("waits for the initial snapshot before enabling writes", () => {
    expect(isRoomWritable("open", false)).toBe(false);
    expect(isRoomWritable("open", true)).toBe(true);
    expect(isRoomWritable("connecting", true)).toBe(false);
  });
});
