import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";

const installer = resolve("scripts/install-bar-integration.sh");
const pluginSource = resolve("scripts/omarchy-quickdrop");
const hasToolchain = Boolean(Bun.which("bash") && Bun.which("python3"));

async function executable(path: string, content: string) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function fakePath(root: string, omarchyActive: boolean, waybarActive: boolean) {
  const bin = join(root, "fake-bin");
  await Bun.$`mkdir -p ${bin}`.quiet();
  await executable(join(bin, "omarchy-shell"), `#!/bin/sh
if [ "$2" = "listPlugins" ]; then
  ${omarchyActive ? `printf '%s\\n' '[{"id":"omarchy.bar","active":true,"kinds":["bar"]}]'` : "exit 1"}
else
  printf '%s\\n' ok
fi
`);
  await executable(join(bin, "pgrep"), `#!/bin/sh
${waybarActive ? "exit 0" : "exit 1"}
`);
  return bin;
}

describe.skipIf(!hasToolchain)("install-bar-integration.sh", () => {
  test("uses Omarchy's shared shell quoting helper in the bar widget", async () => {
    const widget = await readFile(join(pluginSource, "BarWidget.qml"), "utf8");

    expect(widget).toContain("import qs.Commons");
    expect(widget).toContain("Util.shellQuote(launcher)");
    expect(widget).not.toContain("root.bar.shellQuote");
  });

  test("auto-detects an active OmarchyBar before stale Waybar configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "quickdrop-bar-detect-"));
    const bin = await fakePath(root, true, false);
    await Bun.$`mkdir -p ${join(root, ".config/waybar")}`.quiet();
    await writeFile(join(root, ".config/waybar/config.jsonc"), "{}");

    const output = await $`bash ${installer} --detect`
      .env({ ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, QUICKDROP_BAR: "auto" })
      .text();

    expect(output.trim()).toBe("omarchy");
  });

  test("auto-detects an active Waybar when OmarchyBar is inactive", async () => {
    const root = await mkdtemp(join(tmpdir(), "quickdrop-bar-detect-"));
    const bin = await fakePath(root, false, true);

    const output = await $`bash ${installer} --detect`
      .env({ ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, QUICKDROP_BAR: "auto" })
      .text();

    expect(output.trim()).toBe("waybar");
  });

  test("installs, validates, rescans, and enables the Omarchy plugin idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "quickdrop-omarchy-install-"));
    const bin = join(root, "fake-bin");
    const calls = join(root, "calls.log");
    const target = join(root, "plugins", "quickdrop.bar");
    await Bun.$`mkdir -p ${bin}`.quiet();

    await executable(join(bin, "omarchy"), `#!/bin/sh
printf 'omarchy %s\\n' "$*" >> "$CALL_LOG"
exit 0
`);
    await executable(join(bin, "omarchy-shell"), `#!/bin/sh
printf 'omarchy-shell %s\\n' "$*" >> "$CALL_LOG"
exit 0
`);

    const env = {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      QUICKDROP_BAR: "omarchy",
      QUICKDROP_LAUNCHER_PATH: join(root, "bin", "quickdrop-launcher"),
      QUICKDROP_OMARCHY_PLUGIN_SOURCE: pluginSource,
      QUICKDROP_OMARCHY_PLUGIN_DIR: target,
    };

    await $`bash ${installer}`.env(env).quiet();
    await $`bash ${installer}`.env(env).quiet();

    expect(await Bun.file(join(target, "manifest.json")).exists()).toBe(true);
    expect(await Bun.file(join(target, "BarWidget.qml")).exists()).toBe(true);
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    expect(manifest.id).toBe("quickdrop.bar");

    const callLog = await readFile(calls, "utf8");
    expect(callLog).toContain(`omarchy plugin validate ${pluginSource}`);
    expect(callLog).toContain("omarchy-shell shell rescanPlugins");
    expect(callLog).toContain("omarchy plugin enable quickdrop.bar --section right");
    expect(callLog).toContain("omarchy bar set quickdrop.bar launcher");

    const backups = (await readdir(join(root, "plugins"))).filter((name) => name.includes(".bak.quickdrop."));
    expect(backups).toHaveLength(0);
  });

  test("does not replace a working Omarchy plugin when staged validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "quickdrop-omarchy-invalid-"));
    const bin = join(root, "fake-bin");
    const source = join(root, "invalid-source");
    const target = join(root, "plugins", "quickdrop.bar");
    await Bun.$`mkdir -p ${bin} ${source} ${target}`.quiet();
    await writeFile(join(source, "manifest.json"), "{ invalid }");
    await writeFile(join(source, "BarWidget.qml"), "invalid widget");
    await writeFile(join(target, "manifest.json"), '{"id":"working"}');
    await writeFile(join(target, "BarWidget.qml"), "working widget");

    await executable(join(bin, "omarchy"), `#!/bin/sh
if [ "$1 $2" = "plugin validate" ]; then exit 1; fi
exit 0
`);
    await executable(join(bin, "omarchy-shell"), "#!/bin/sh\nexit 0\n");

    await $`bash ${installer}`
      .env({
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env.PATH}`,
        QUICKDROP_BAR: "omarchy",
        QUICKDROP_OMARCHY_PLUGIN_SOURCE: source,
        QUICKDROP_OMARCHY_PLUGIN_DIR: target,
      })
      .quiet();

    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe('{"id":"working"}');
    expect(await readFile(join(target, "BarWidget.qml"), "utf8")).toBe("working widget");
  });
});
