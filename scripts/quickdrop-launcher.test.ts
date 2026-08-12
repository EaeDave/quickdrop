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

test("launcher parses only the backend key without executing config contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "quickdrop-launcher-"));
  const bin = join(root, "bin");
  const configDir = join(root, ".config", "quickdrop");
  const dispatchLog = join(root, "dispatch.log");
  const launchLog = join(root, "launch.log");
  const fakeQuickdrop = join(bin, "quickdrop");
  const bunCalls = join(root, "bun-calls");
  const marker = join(root, "must-not-exist");
  await mkdir(bin, { recursive: true });
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(configDir, "config.env"),
    `QUICKDROP_API_BASE_URL='https://example.test/'\ntouch '${marker}'\n`,
  );
  await executable(join(bin, "hyprctl"), `#!/bin/sh
case "$1" in
  cursorpos) exit 1 ;;
  clients) printf '%s\\n' '[]' ;;
  dispatch) printf '%s\\n' "$*" >> "$DISPATCH_LOG" ;;
esac
`);
  await executable(fakeQuickdrop, `#!/bin/sh
printf '%s\n' "$QUICKDROP_API_BASE_URL" > "$LAUNCH_LOG"
`);
  await executable(join(bin, "bun"), `#!/bin/sh
count=0
[ ! -f "$BUN_CALLS" ] || count=$(cat "$BUN_CALLS")
count=$((count + 1))
printf '%s' "$count" > "$BUN_CALLS"
[ "$count" -lt 2 ] || printf '%s\\n' '0x1'
`);

  await $`bash ${launcher}`
    .env({
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_RUNTIME_DIR: root,
      DISPATCH_LOG: dispatchLog,
      LAUNCH_LOG: launchLog,
      QUICKDROP_BIN: fakeQuickdrop,
      BUN_CALLS: bunCalls,
    })
    .quiet();

  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await readFile(launchLog, "utf8")).toBe("https://example.test\n");
  const log = await readFile(dispatchLog, "utf8");
  expect(log).toContain("hl.dsp.window.float");
  expect(log).toContain("hl.dsp.focus");
});
