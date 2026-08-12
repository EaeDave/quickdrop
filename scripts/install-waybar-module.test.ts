import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";

const patcher = resolve("scripts/install-waybar-module.py");
const hasPython = Boolean(Bun.which("python3"));

async function patch(input: string, launcher = "/home/user/.local/bin/quickdrop-launcher") {
  const root = await mkdtemp(join(tmpdir(), "quickdrop-waybar-patch-"));
  const configPath = join(root, "config.jsonc");
  await writeFile(configPath, input);
  await $`python3 ${patcher} ${configPath} ${launcher}`.quiet();
  return { root, configPath, text: await readFile(configPath, "utf8") };
}

describe.skipIf(!hasPython)("install-waybar-module.py", () => {
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
    expect(text).toContain(`"tooltip-format": "QuickDrop\\nArraste arquivos para enviar"`);
  });

  test("is idempotent and creates only the first backup", async () => {
    const result = await patch(`{
  "modules-right": ["tray"],
  "tray": { "icon-size": 12 }
}`);
    const afterFirst = result.text;

    await $`python3 ${patcher} ${result.configPath} /home/user/.local/bin/quickdrop-launcher`.quiet();
    const afterSecond = await readFile(result.configPath, "utf8");
    const backups = (await readdir(result.root)).filter((name) => name.includes(".bak.quickdrop."));

    expect(afterSecond).toBe(afterFirst);
    expect(backups).toHaveLength(1);
  });
});
