# Contributing

## Local setup

1. Install Bun, Rust stable, and PostgreSQL. GPUI desktop builds also need the native platform libraries: X11/Wayland, fontconfig, xkbcommon, OpenGL, and Vulkan on Linux; Xcode command-line tools on macOS; or Visual Studio C++ build tools on Windows.
2. Copy `.env.example` to `.env` and provide your own database and R2 credentials.
3. Set `QUICKDROP_PUBLIC_BASE_URL` to your deployment origin. For local server work, use `QUICKDROP_LOCAL_PUBLIC_BASE_URL=http://127.0.0.1:3000`.
4. Use your own updater signing key pair for distributable desktop builds. Release bundles retain the Tauri updater signature format; never replace the persistent production key or commit private keys.

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

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
