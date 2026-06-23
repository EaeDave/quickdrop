import { describe, expect, test } from "bun:test";
import { patchWaybarConfig } from "./install-waybar-module.ts";

describe("patchWaybarConfig", () => {
  test("adds QuickDrop to modules-right and defines the module", () => {
    const input = `{
  "modules-right": [
    "clock",
    "tray"
  ],
  "tray": { "icon-size": 12 }
}`;

    const { text, changed } = patchWaybarConfig(input, "/home/user/.local/bin/quickdrop-waybar");

    expect(changed).toBe(true);
    expect(text).toContain(`"modules-right": [\n    "custom/quickdrop",\n    "clock"`);
    expect(text).toContain(`"custom/quickdrop": {`);
    expect(text).toContain(`"on-click": "env QUICKDROP_API_BASE_URL='https://quickdrop.eaedave.xyz' '/home/user/.local/bin/quickdrop-waybar'"`);
  });

  test("uses configured API base URL without trailing slash", () => {
    const input = `{
  "modules-right": ["tray"],
  "tray": { "icon-size": 12 }
}`;

    const { text } = patchWaybarConfig(
      input,
      "/home/user/.local/bin/quickdrop-waybar",
      "http://127.0.0.1:3000/",
    );

    expect(text).toContain(`"on-click": "env QUICKDROP_API_BASE_URL='http://127.0.0.1:3000' '/home/user/.local/bin/quickdrop-waybar'"`);
  });

  test("replaces old direct binary module with Waybar launcher", () => {
    const input = `{
  "modules-right": ["custom/quickdrop", "tray"],
  "custom/quickdrop": {
    "format": "?",
    "tooltip": "QuickDrop",
    "on-click": "quickdrop"
  },
  "tray": { "icon-size": 12 }
}`;

    const { text, changed } = patchWaybarConfig(input, "/home/user/.local/bin/quickdrop-waybar");

    expect(changed).toBe(true);
    expect(text).not.toContain(`"on-click": "quickdrop"`);
    expect(text).toContain(`"tooltip-format": "QuickDrop\\nArraste arquivos para enviar"`);
    expect(text).toContain(`"on-click": "env QUICKDROP_API_BASE_URL='https://quickdrop.eaedave.xyz' '/home/user/.local/bin/quickdrop-waybar'"`);
  });

  test("is idempotent after install", () => {
    const first = patchWaybarConfig(`{
  "modules-right": ["tray"],
  "tray": { "icon-size": 12 }
}`, "/home/user/.local/bin/quickdrop-waybar").text;

    const second = patchWaybarConfig(first, "/home/user/.local/bin/quickdrop-waybar");

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first);
  });
});
