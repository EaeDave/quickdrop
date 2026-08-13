import { describe, expect, test } from "bun:test";
import { classifyTextDrop } from "./text-drop-content";

describe("classifyTextDrop", () => {
  test("recognizes a complete HTTP URL without executing or fetching it", () => {
    expect(classifyTextDrop("https://example.com/path?q=1")).toBe("url");
    expect(classifyTextDrop("see https://example.com")).toBe("text");
  });

  test("recognizes JSON objects and arrays", () => {
    expect(classifyTextDrop('{"ok":true}')).toBe("json");
    expect(classifyTextDrop("[1, 2, 3]")).toBe("json");
    expect(classifyTextDrop("{not-json}")).toBe("text");
  });

  test("recognizes common shell and PowerShell commands conservatively", () => {
    expect(classifyTextDrop("$ echo hello")).toBe("command");
    expect(classifyTextDrop("$ 100")).toBe("text");
    expect(classifyTextDrop("sudo systemctl restart app")).toBe("command");
    expect(classifyTextDrop("pwsh -File install.ps1")).toBe("command");
    expect(classifyTextDrop("go test ./...")).toBe("command");
    expect(classifyTextDrop("make --version")).toBe("command");
    expect(classifyTextDrop("A normal sentence with git in it.")).toBe("text");
    expect(classifyTextDrop("go to lunch")).toBe("text");
    expect(classifyTextDrop("make this easier")).toBe("text");
  });
});
