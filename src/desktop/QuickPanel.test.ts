import { describe, expect, test } from "bun:test";
import { shouldNotifyRemoteDrop } from "./QuickPanel";

describe("QuickPanel notifications", () => {
  test("notifies only new drops from another connected client", () => {
    expect(shouldNotifyRemoteDrop("remote", "self", false)).toBe(true);
    expect(shouldNotifyRemoteDrop("self", "self", false)).toBe(false);
    expect(shouldNotifyRemoteDrop("remote", null, false)).toBe(false);
    expect(shouldNotifyRemoteDrop("remote", "self", true)).toBe(false);
  });
});
