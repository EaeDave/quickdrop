# Contributing

## Local setup

1. Install Bun, Rust stable, and PostgreSQL. GPUI desktop builds also need the native platform libraries: X11/Wayland, fontconfig, libxkbcommon, and a Vulkan-capable graphics driver on Linux; Xcode command-line tools on macOS; or Visual Studio C++ build tools on Windows.
2. Copy `.env.example` to `.env` and provide your own database and R2 credentials.
3. Set `QUICKDROP_PUBLIC_BASE_URL` to your deployment origin. For local server work, use `QUICKDROP_LOCAL_PUBLIC_BASE_URL=http://127.0.0.1:3000`.
4. Fork distributors need their own updater signing key pair and must set `QUICKDROP_UPDATER_PUBLIC_KEY` to its public half for desktop builds. Release bundles retain the Tauri updater signature format. Official releases use the existing persistent production key; never rotate or replace it, and never commit private keys.

Run the standard checks before opening a pull request:

```bash
bun run typecheck
bun test
cargo test --manifest-path cli/Cargo.toml
cargo test --manifest-path desktop-gpui/Cargo.toml
bun run desktop:build:web
```

## Pull requests

Keep changes focused, add regression tests, and do not include generated binaries, credentials, clipboard contents, or `.env` files. Release tags and updater artifacts are created only by maintainers through the repository release process.

The official release command builds Linux locally, creates a draft GitHub release, and waits for Windows and macOS jobs to sign and upload their assets. It verifies all required assets, updater signatures against the configured public key, and the updater manifest before publishing the draft. Missing signing secrets or public variables must be restored, not replaced with a new key pair. A failed build or verification leaves the draft unpublished.

The `qd:package:windows` and `qd:package:macos` commands package only the prebuilt CLI. Desktop release packaging additionally runs `scripts/package-desktop-release.ts` on the target operating system.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
