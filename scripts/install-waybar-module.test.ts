import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const patcher = resolve("scripts/install-waybar-module.py");

async function patch(input: string, launcher = "/home/user/.local/bin/quickdrop-launcher") {
  const root = await mkdtemp(join(tmpdir(), "quickdrop-waybar-patch-"));
  const configPath = join(root, "config.jsonc");
  await writeFile(configPath, input);

  const process = Bun.spawn(["python3", patcher, configPath, launcher], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect(exitCode).toBe(0);

  return { root, configPath, text: await readFile(configPath, "utf8"), stdout, stderr };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("install-waybar-module.py", () => {
  test("adds QuickDrop to modules-right and defines the module", async () => {
    const { text } = await patch(`{
  "modules-right": [
    "clock",
    "tray"
  ],
  "tray": { "icon-size": 12 }
}`);

    expect(text).toContain(`"modules-right": [\n    "custom/quickdrop",\n    "clock"`);
    expect(text).toContain(`"custom/quickdrop": {`);
    expect(text).toContain(`"on-click": "'/home/user/.local/bin/quickdrop-launcher'"`);
  });

  test("skips truthfully when modules-right is absent", async () => {
    const input = `{
  "layer": "top",
  "tray": { "icon-size": 12 }
}`;
    const { text, stdout, stderr } = await patch(input);

    expect(text).toBe(input);
    expect(text).not.toContain("custom/quickdrop");
    expect(stdout).toContain("skipped");
    expect(stderr).toContain('no "modules-right" array found');
  });

  test("patches every object in a multi-bar configuration", async () => {
    const { text } = await patch(`[
  {
    "name": "primary",
    "modules-right": ["clock"],
    "clock": { "format": "{:%H:%M}" }
  },
  {
    "name": "secondary",
    "modules-right": ["tray"],
    "tray": { "icon-size": 12 }
  }
]`);

    expect(occurrences(text, '"custom/quickdrop"')).toBe(4);
    expect(occurrences(text, '"custom/quickdrop": {')).toBe(2);
  });

  test("inserts a comma before a trailing line comment", async () => {
    const { text } = await patch(`{
  "modules-right": ["clock"],
  "clock": { "format": "{:%H:%M}" } // keep this comment
}`);

    expect(text).toContain(`"clock": { "format": "{:%H:%M}" }, // keep this comment`);
    expect(text).toContain(`"custom/quickdrop": {`);
  });

  test("shell-quotes a launcher path containing an apostrophe", async () => {
    const { text } = await patch(`{
  "modules-right": ["tray"],
  "tray": { "icon-size": 12 }
}`, "/home/dave's/bin/quickdrop-launcher");

    expect(text).toContain(`'/home/dave'\\\"'\\\"'s/bin/quickdrop-launcher'`);
  });

  test("replaces an old direct-binary module", async () => {
    const { text } = await patch(`{
  "modules-right": ["custom/quickdrop", "tray"],
  "custom/quickdrop": {
    "format": "?",
    "tooltip": "QuickDrop",
    "on-click": "quickdrop"
  },
  "tray": { "icon-size": 12 }
}`);

    expect(text).not.toContain(`"on-click": "quickdrop"`);
    expect(text).toContain(`"tooltip-format": "QuickDrop\\nDrop files to upload"`);
  });

  test("is idempotent and creates only the first backup", async () => {
    const result = await patch(`{
  "modules-right": ["tray"],
  "tray": { "icon-size": 12 }
}`);
    const afterFirst = result.text;

    const process = Bun.spawn(["python3", patcher, result.configPath, "/home/user/.local/bin/quickdrop-launcher"]);
    expect(await process.exited).toBe(0);
    const afterSecond = await readFile(result.configPath, "utf8");
    const backups = (await readdir(result.root)).filter((name) => name.includes(".bak.quickdrop."));

    expect(afterSecond).toBe(afterFirst);
    expect(backups).toHaveLength(1);
  });
});
