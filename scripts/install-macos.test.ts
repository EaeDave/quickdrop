import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

describe("install-macos.sh", () => {
  test("installs the menu bar app and qd for Apple Silicon", async () => {
    const root = await mkdtemp(join(tmpdir(), "quickdrop-macos-test-"));
    temporaryDirectories.push(root);
    const mockBin = join(root, "mock-bin");
    const home = join(root, "home");
    const sourceQd = join(root, "qd");
    const sourceDmg = join(root, "QuickDrop.dmg");
    const openLog = join(root, "open.log");
    await mkdir(mockBin, { recursive: true });
    await mkdir(home, { recursive: true });
    await executable(sourceQd, "#!/bin/sh\nexit 0\n");
    await writeFile(sourceDmg, "local test dmg");

    await executable(
      join(mockBin, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) exit 1 ;; esac\n',
    );
    await executable(
      join(mockBin, "hdiutil"),
      '#!/bin/sh\nif [ "$1" = attach ]; then while [ "$#" -gt 0 ]; do if [ "$1" = -mountpoint ]; then shift; mount_dir="$1"; fi; shift; done; mkdir -p "$mount_dir/QuickDrop.app/Contents/MacOS"; printf app > "$mount_dir/QuickDrop.app/Contents/MacOS/quickdrop"; fi\n',
    );
    await executable(join(mockBin, "ditto"), '#!/bin/sh\ncp -R "$1" "$2"\n');
    await executable(join(mockBin, "open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${openLog}"\n`);

    const child = Bun.spawn(["bash", "scripts/install-macos.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        HOME: home,
        QUICKDROP_QD_BINARY: sourceQd,
        QUICKDROP_MACOS_DMG: sourceDmg,
        QUICKDROP_BIN_DIR: join(root, "bin"),
        QUICKDROP_APPLICATIONS_DIR: join(root, "Applications"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await child.exited).toBe(0);
    expect(await Bun.file(join(root, "bin", "qd")).exists()).toBe(true);
    expect(
      await Bun.file(join(root, "Applications", "QuickDrop.app", "Contents", "MacOS", "quickdrop")).exists(),
    ).toBe(true);
    expect(await readFile(openLog, "utf8")).toContain("QuickDrop.app");
  });
});
