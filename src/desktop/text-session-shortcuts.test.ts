import { describe, expect, test } from "bun:test";
import { isCopyTextShortcut, remoteContentNotice } from "./text-session-shortcuts";

const baseEvent = {
  key: "Enter",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
};

describe("text session shortcuts", () => {
  test("accepts Ctrl+Enter and Meta+Enter for copying", () => {
    expect(isCopyTextShortcut({ ...baseEvent, ctrlKey: true })).toBe(true);
    expect(isCopyTextShortcut({ ...baseEvent, metaKey: true })).toBe(true);
  });

  test("ignores plain, modified, and composing Enter presses", () => {
    expect(isCopyTextShortcut(baseEvent)).toBe(false);
    expect(isCopyTextShortcut({ ...baseEvent, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isCopyTextShortcut({ ...baseEvent, ctrlKey: true, altKey: true })).toBe(false);
    expect(isCopyTextShortcut({ ...baseEvent, ctrlKey: true, isComposing: true })).toBe(false);
    expect(isCopyTextShortcut({ ...baseEvent, key: "Escape", ctrlKey: true })).toBe(false);
  });
});

describe("remoteContentNotice", () => {
  test("distinguishes received text from a remote clear", () => {
    expect(remoteContentNotice("hello")).toBe("Novo texto recebido de outro dispositivo.");
    expect(remoteContentNotice("")).toBe("Clipboard limpo em outro dispositivo.");
  });
});
