# Repository instructions

## Releases

- Releases MUST be started from a clean, up-to-date local `main` branch on an x86_64 Linux host with `bun run release <patch|minor|major|X.Y.Z>`.
- Agents MUST use the release command instead of manually editing versions, creating tags, creating GitHub releases, or uploading individual assets.
- Pull-request commits MUST NOT trigger release builds. Wait for review approval and merge first; only the release tag or an explicit manual rebuild may start the Windows Actions job.
- Linux desktop and `qd` binaries MUST be built locally and uploaded by `scripts/release.ts`; do not add a Linux GitHub Actions build.
- Windows desktop installer and `qd.exe` MUST be built by `.github/workflows/release.yml` on `windows-latest`; do not attempt to cross-compile or publish them locally.
- A release is complete only after the Linux assets are public, the Windows workflow succeeds, and every public download endpoint returns the matching release assets.
- `bun run release:check` is the non-publishing validation command.
