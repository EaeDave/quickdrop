import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { expect, test } from "bun:test";

const launcher = resolve("scripts/quickdrop-launcher");

async function executable(path: string, content: string) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

test("launcher maps QuickDrop at its final position without initial focus", async () => {
  const root = await mkdtemp(join(tmpdir(), "quickdrop-launcher-"));
  const bin = join(root, "bin");
  const configDir = join(root, ".config", "quickdrop");
  const eventLog = join(root, "events.log");
  const fakeQuickdrop = join(bin, "quickdrop");
  const marker = join(root, "must-not-exist");
  await mkdir(bin, { recursive: true });
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(configDir, "config.env"),
    `QUICKDROP_API_BASE_URL='https://example.test/'\ntouch '${marker}'\n`,
  );
  await executable(join(bin, "hyprctl"), `#!/bin/sh
case "$1" in
  cursorpos) printf '%s\\n' '965, 0' ;;
  monitors) printf '%s\\n' '[{"x":0,"y":0,"width":1920,"height":1080,"focused":true,"reserved":[0,26,0,0]}]' ;;
  clients) printf '%s\\n' '[]' ;;
  eval) printf 'eval:%s\\n' "$2" >> "$EVENT_LOG" ;;
  dispatch) printf 'dispatch:%s\\n' "$2" >> "$EVENT_LOG" ;;
esac
`);
  await executable(fakeQuickdrop, `#!/bin/sh
printf 'launch:%s\\n' "$QUICKDROP_API_BASE_URL" >> "$EVENT_LOG"
`);
  await executable(join(bin, "bun"), `#!/bin/sh
if [ -n "\${MONITORS_JSON:-}" ]; then
  printf '%s\\n' '749 26 749 26'
  exit
fi
if [ -f "$EVENT_LOG" ] && grep -q '^launch:' "$EVENT_LOG"; then
  printf '%s\\n' '0x1'
fi
exit 0
`);

  await $`bash ${launcher}`
    .env({
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_RUNTIME_DIR: root,
      EVENT_LOG: eventLog,
      QUICKDROP_BIN: fakeQuickdrop,
      QUICKDROP_API_BASE_URL: undefined,
    })
    .quiet();

  expect(await Bun.file(marker).exists()).toBe(false);
  const events = await readFile(eventLog, "utf8");
  expect(events).toContain("no_initial_focus = true");
  expect(events).toContain("no_anim = true");
  expect(events).toContain("move = { 749, 26 }");
  expect(events.indexOf("quickdrop-spawn")).toBeLessThan(events.indexOf("launch:https://example.test"));
  expect(events).not.toContain("hl.dsp.focus");
});
