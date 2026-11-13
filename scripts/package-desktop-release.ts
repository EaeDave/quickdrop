import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { desktopVersion, macosInfoPlist, run, signUpdater, writeChecksum } from "./desktop-release";

export const macosArchitectures = [
  { target: "aarch64-apple-darwin", asset: "aarch64", qd: "aarch64-macos" },
  { target: "x86_64-apple-darwin", asset: "x64", qd: "x86_64-macos" },
] as const;

export async function packageWindows(version: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows installers must be packaged on Windows");
  const directory = resolve("desktop-gpui/target/x86_64-pc-windows-msvc/release");
  const binary = join(directory, "quickdrop.exe");
  if (!(await Bun.file(binary).exists())) throw new Error(`Build ${binary} first`);
  const bundle = join(directory, "bundle/nsis");
  await mkdir(bundle, { recursive: true });
  const installer = join(bundle, `QuickDrop_${version}_x64-setup.exe`);
  await run([process.env.MAKENSIS ?? "makensis", "/V3", `/DVERSION=${version}`,
    `/DBINARY=${binary}`, `/DOUTPUT=${installer}`, `/DICON=${resolve("desktop-gpui/icons/icon.ico")}`,
    resolve("scripts/quickdrop.nsi")]);
  await signUpdater(installer);
  console.log(installer);
  console.log(`${installer}.sig`);
  return installer;
}

export async function packageMacos(version: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("macOS bundles must be packaged on macOS");
  for (const { target, asset } of macosArchitectures) {
    const directory = resolve(`desktop-gpui/target/${target}/release`);
    const binary = join(directory, "quickdrop");
    if (!(await Bun.file(binary).exists())) throw new Error(`Build ${binary} first`);
    const bundleDirectory = join(directory, "bundle/macos");
    const app = join(bundleDirectory, "QuickDrop.app");
    await rm(app, { recursive: true, force: true });
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await mkdir(join(app, "Contents/Resources"), { recursive: true });
    await Bun.write(join(app, "Contents/MacOS/quickdrop"), Bun.file(binary));
    await chmod(join(app, "Contents/MacOS/quickdrop"), 0o755);
    await Bun.write(join(app, "Contents/Resources/icon.icns"), Bun.file("desktop-gpui/icons/icon.icns"));
    await Bun.write(join(app, "Contents/Info.plist"), macosInfoPlist(version));
    await run(["plutil", "-lint", join(app, "Contents/Info.plist")]);
    await run(["codesign", "--force", "--sign", "-", app]);
    await run(["codesign", "--verify", "--deep", "--strict", app]);
    const archive = join(bundleDirectory, `QuickDrop_${version}_${asset}.app.tar.gz`);
    // Tauri's existing updater expects the archive root to contain QuickDrop.app.
    await run(["tar", "-czf", archive, "-C", bundleDirectory, "QuickDrop.app"], { ...process.env, COPYFILE_DISABLE: "1" });
    await signUpdater(archive);
    console.log(archive);
    console.log(`${archive}.sig`);

    const dmgDirectory = join(directory, "bundle/dmg");
    await mkdir(dmgDirectory, { recursive: true });
    const dmg = join(dmgDirectory, `QuickDrop_${version}_${asset}.dmg`);
    const staging = await mkdtemp(join(tmpdir(), "quickdrop-dmg-"));
    try {
      await run(["ditto", app, join(staging, "QuickDrop.app")]);
      await symlink("/Applications", join(staging, "Applications"));
      await run(["hdiutil", "create", "-ov", "-format", "UDZO", "-volname", "QuickDrop", "-srcfolder", staging, dmg]);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    console.log(dmg);
    await writeChecksum(dmg);
  }
}

if (import.meta.main) {
  const version = await desktopVersion();
  if (process.platform === "win32") await packageWindows(version);
  else if (process.platform === "darwin") await packageMacos(version);
  else throw new Error("Use scripts/package-linux-release.ts on Linux");
}
