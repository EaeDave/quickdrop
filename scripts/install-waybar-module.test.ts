import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { installWaybarModule, patchWaybarConfig } from "./install-waybar-module.ts";

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

  test("installs compact launcher alongside the Waybar module", async () => {
    const root = await mkdtemp(join(tmpdir(), "quickdrop-waybar-"));
    const configPath = join(root, "config.jsonc");
    const launcherPath = join(root, "bin", "quickdrop-waybar");
    const sourcePath = join(root, "source-quickdrop-waybar");

    await writeFile(configPath, `{
  "modules-right": ["tray"],
  "tray": { "icon-size": 12 }
}`);
    await writeFile(sourcePath, "#!/usr/bin/env bash\nwindow_width=432\nwindow_height=272\n");

    const result = await installWaybarModule({
      configPath,
      home: root,
      launcherPath,
      launcherSourcePath: sourcePath,
      restart: false,
    });

    const launcher = await readFile(launcherPath, "utf8");
    const mode = (await stat(launcherPath)).mode;

    expect(result.launcherInstalled).toBe(true);
    expect(result.modulePresent).toBe(true);
    expect(launcher).toContain("window_width=432");
    expect(launcher).toContain("window_height=272");
    expect(mode & 0o111).not.toBe(0);
  });
});
