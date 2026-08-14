# Repository instructions

## Releases

- Releases MUST be started from a clean, up-to-date local `main` branch on an x86_64 Linux host with `bun run release <patch|minor|major|X.Y.Z>`.
- Agents MUST use the release command instead of manually editing versions, creating tags, creating GitHub releases, or uploading individual assets.
- Pull-request commits MUST NOT trigger release builds. Wait for review approval and merge first; only the release tag or an explicit manual rebuild may start the Windows Actions job.
- After a user-facing change is validated, approved, and merged into `main`, agents MUST complete the work by starting the appropriate release with the official release command. A successful merge is not the delivery endpoint unless the user explicitly defers the release.
- Linux desktop and `qd` binaries MUST be built locally and uploaded by `scripts/release.ts`; do not add a Linux GitHub Actions build.
- Windows desktop installer and `qd.exe` MUST be built by `.github/workflows/release.yml` on `windows-latest`; do not attempt to cross-compile or publish them locally.
- Apple Silicon and Intel macOS desktop DMGs and `qd` binaries MUST be built by `.github/workflows/release.yml` on a macOS runner; do not attempt to publish them from the Linux release host.
- A release is complete only after the Linux assets are public, the Windows and macOS workflow jobs succeed, and every public download endpoint returns the matching release assets.
- `bun run release:check` is the non-publishing validation command.
