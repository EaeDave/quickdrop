# Contributing

## Local setup

1. Install Bun, Rust stable, PostgreSQL, and the platform dependencies required by Tauri.
2. Copy `.env.example` to `.env` and provide your own database and R2 credentials.
3. Set `QUICKDROP_PUBLIC_BASE_URL` to your deployment origin. For local server work, use `QUICKDROP_LOCAL_PUBLIC_BASE_URL=http://127.0.0.1:3000`.
4. Use your own Tauri updater key pair for distributable desktop builds. Never commit the private key.

Run the standard checks before opening a pull request:

```bash
bun run typecheck
bun test
cargo test --manifest-path cli/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
bun run desktop:build:web
```

## Pull requests

Keep changes focused, add regression tests, and do not include generated binaries, credentials, clipboard contents, or `.env` files. Release tags and updater artifacts are created only by maintainers through the repository release process.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
