import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { expect, test } from "bun:test";

const runner = resolve("scripts/run-tauri.ts");

test("Tauri runner normalizes the child build environment and allows keyless development", async () => {
  const root = await mkdtemp(join(tmpdir(), "quickdrop-tauri-runner-"));
  const bunx = join(root, "bunx");
  const output = join(root, "env.json");
  await writeFile(
    bunx,
    `#!/bin/sh
printf '%s' "$TAURI_CONFIG" > "$TAURI_TEST_CONFIG"
printf '%s' "$QUICKDROP_PUBLIC_BASE_URL" > "$TAURI_TEST_BASE_URL"
printf '%s' "$*" > "$TAURI_TEST_ARGS"
`,
  );
  await chmod(bunx, 0o755);

  await $`bun ${runner} dev`
    .env({
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      QUICKDROP_PUBLIC_BASE_URL: " http://127.0.0.1:3000/ ",
      TAURI_UPDATER_PUBLIC_KEY: "",
      TAURI_TEST_CONFIG: output,
      TAURI_TEST_BASE_URL: `${output}.url`,
      TAURI_TEST_ARGS: `${output}.args`,
    })
    .quiet();

  expect(await readFile(`${output}.url`, "utf8")).toBe("http://127.0.0.1:3000");
  const config = JSON.parse(await readFile(output, "utf8"));
  expect(config.plugins.updater.endpoints).toEqual([
    "http://127.0.0.1:3000/desktop/update/latest.json",
  ]);
  expect(config.plugins.updater.pubkey).toBeUndefined();
  expect(await readFile(`${output}.args`, "utf8")).toContain("--config");
});

test("Tauri runner passes signer commands through without build configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "quickdrop-tauri-signer-"));
  const bunx = join(root, "bunx");
  const output = join(root, "args.txt");
  await writeFile(
    bunx,
    `#!/bin/sh
printf '%s' "$*" > "$TAURI_TEST_ARGS"
printf '%s' "$TAURI_CONFIG" > "$TAURI_TEST_CONFIG"
`,
  );
  await chmod(bunx, 0o755);

  await $`bun ${runner} signer sign --password= artifact`
    .env({
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      QUICKDROP_PUBLIC_BASE_URL: "",
      TAURI_UPDATER_PUBLIC_KEY: "",
      TAURI_CONFIG: "",
      TAURI_TEST_ARGS: output,
      TAURI_TEST_CONFIG: `${output}.config`,
    })
    .quiet();

  expect(await readFile(output, "utf8")).toBe("tauri signer sign --password= artifact");
  expect(await readFile(`${output}.config`, "utf8")).toBe("");
});
