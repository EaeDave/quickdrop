import { describe, expect, test } from "bun:test";
import { dropContentTypeLabel, isPublishDropShortcut } from "./text-session-shortcuts";

const baseEvent = {
  key: "Enter",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
};

describe("text session shortcuts", () => {
  test("accepts Ctrl+Enter and Meta+Enter for publishing a drop", () => {
    expect(isPublishDropShortcut({ ...baseEvent, ctrlKey: true })).toBe(true);
    expect(isPublishDropShortcut({ ...baseEvent, metaKey: true })).toBe(true);
  });

  test("ignores plain, modified, and composing Enter presses", () => {
    expect(isPublishDropShortcut(baseEvent)).toBe(false);
    expect(isPublishDropShortcut({ ...baseEvent, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPublishDropShortcut({ ...baseEvent, ctrlKey: true, altKey: true })).toBe(false);
    expect(isPublishDropShortcut({ ...baseEvent, ctrlKey: true, isComposing: true })).toBe(false);
    expect(isPublishDropShortcut({ ...baseEvent, key: "Escape", ctrlKey: true })).toBe(false);
  });
});

describe("dropContentTypeLabel", () => {
  test("returns presentation-only labels for every safe content type", () => {
    expect(dropContentTypeLabel("text")).toBe("Text");
    expect(dropContentTypeLabel("url")).toBe("URL");
    expect(dropContentTypeLabel("command")).toBe("Command");
    expect(dropContentTypeLabel("json")).toBe("JSON");
  });
});
