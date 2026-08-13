# QuickDrop

QuickDrop is a self-hosted, cross-platform tool for moving files and short text snippets between machines. It combines temporary public file links, real-time text clipboards, native desktop clients, and the `qd` command-line client behind one backend.

## Features

- Temporary file uploads backed by Cloudflare R2 and PostgreSQL
- Public download links with configurable expiration and storage limits
- Real-time text clipboards addressed by short, human-readable codes
- Text-drop timeline with per-item edit, copy, resend, and delete actions
- Native Rust CLI for SSH, remote desktops, Linux, and Windows
- Linux desktop integration for OmarchyBar and Waybar
- Windows desktop client with system tray and autostart support
- Optional privacy-preserving aggregate funnel metrics

## Architecture

| Component | Technology | Location |
|---|---|---|
| HTTP and WebSocket backend | Bun, Fastify, PostgreSQL, Drizzle | `src/server/` |
| Web and desktop interface | React, Tailwind CSS | `src/desktop/` |
| Desktop shell | Rust, Tauri 2 | `src-tauri/` |
| Native text CLI | Rust | `cli/` |
| Database migrations | SQL, Drizzle | `migrations/` |
| Linux and Windows installers | Bash, PowerShell | `scripts/` |

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- Docker with Compose for local PostgreSQL
- Rust stable for the desktop application and `qd` CLI
- Cloudflare R2 credentials for production file uploads
- Linux desktop builds: GTK 3, WebKitGTK 4.1, `wl-clipboard`, and `libnotify`
- Windows desktop builds: Windows 10/11 and WebView2 Runtime

This repository uses [mise](https://mise.jdx.dev/) for local toolchain selection. Install the configured tools before building:

```bash
mise install
```

## Quick start

```bash
bun install
cp .env.example .env
docker compose up -d db
bun run db:migrate
bun run server:dev
```

The backend listens on `http://127.0.0.1:3000` by default. Verify it with:

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

Build the web interface with:

```bash
bun run desktop:build:web
```

## Configuration

The main environment variables are:

```env
PORT=3000
DATABASE_URL=postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=quickdrop
PUBLIC_BASE_URL=https://files.example.com
R2_STORAGE_HARD_LIMIT_GB=8

FILE_EXPIRATION_HOURS=6
MAX_FILE_SIZE_MB=100
UPLOAD_RATE_LIMIT_MAX=5
UPLOADS_ENABLED=true
UPLOAD_RESERVATION_TTL_MINUTES=30

TEXT_SESSION_TTL_HOURS=12
TEXT_CUSTOM_SESSION_TTL_MINUTES=30
TEXT_DROP_MAX_ITEMS=10
TEXT_DROP_TTL_HOURS=12
TEXT_SESSION_MAX_KB=256
TEXT_SESSION_CODE_LENGTH=6
TEXT_SESSION_MAX_SESSIONS=500
TEXT_SESSION_MAX_CLIENTS=20

TEXT_METRICS_ENABLED=false
TEXT_METRICS_RETENTION_DAYS=90
RUN_MIGRATIONS_ON_START=true
```

See [`.env.example`](.env.example) for the complete development template.

## Text clipboard

Open `/t` in the web application and enter a code containing 1–16 ASCII letters, numbers, `_`, or `-`. The same operation opens an active clipboard or creates it when it does not exist.

Each publication creates a drop. By default, a clipboard retains its 10 newest drops, and each drop expires after 12 hours. Public custom codes are intentionally easy to type and must not be treated as secrets. PIN-protected clipboards are available through the web interface and interactive TUI.

Canonical URLs use this form:

```text
https://quickdrop.example/t/MYCODE
```

### Native CLI

The `qd` client is a standalone Rust binary and does not require Bun or Node.js at runtime.

Install it from the repository:

```bash
mise exec rust@stable -- cargo install --path cli
```
Run `qd` in an interactive terminal to open the Ratatui interface:

```bash
qd
```

The TUI opens or creates a clipboard by code, can create a new PIN-protected clipboard with `Ctrl+P`, and prompts for the PIN when opening an existing protected clipboard. It displays the drop timeline, receives real-time updates, reconnects automatically, and provides a multiline composer. It also supports editing, copying, resending, and deleting the selected drop.

Open a code directly in the TUI:

```bash
qd --tui MYCODE
```

Keyboard shortcuts:

| Context | Keys | Action |
|---|---|---|
| Code | `Enter` | Open a clipboard or create a public one |
| Code | `Ctrl+P` | Create a PIN-protected clipboard |
| Timeline | `j`/`↓`, `k`/`↑` | Select the next or previous drop |
| Timeline | `g`/`Home`, `G`/`End` | Select the first or last drop |
| Timeline | `Enter`, `i`, `Tab` | Focus the composer |
| Timeline | `e`, `y`, `r`, `d` | Edit, copy, resend, or delete the selected drop |
| Timeline | `?`, `q` | Open help or quit |
| Composer | `Ctrl+S` or `Ctrl+Enter` | Publish a new drop |
| Composer | `Ctrl+U`, `Esc` | Clear the composer or return to the timeline |
| Editor | `Ctrl+S` or `Ctrl+Enter` | Save changes to the selected drop |
| Editor | `Ctrl+U`, `Esc` | Clear the editor or cancel editing |

The layout adapts to small terminals and respects the `NO_COLOR` environment variable. It uses only standard Unicode symbols and does not require a Nerd Font.

Non-interactive commands remain suitable for pipes and scripts.


Publish stdin as a new drop:

```bash
echo "text from SSH" | qd MYCODE
```

Print the newest drop:

```bash
qd MYCODE
```

Print and copy it to the local clipboard:

```bash
qd MYCODE --copy
```

Use another QuickDrop backend in interactive or non-interactive mode:

```bash
qd --tui MYCODE --server http://127.0.0.1:3000
qd MYCODE --server http://127.0.0.1:3000
QUICKDROP_API_BASE_URL=http://127.0.0.1:3000 qd
```

On Linux, `--copy` tries `wl-copy`, `xclip`, then `xsel`. On Windows, it uses PowerShell `Set-Clipboard`. The interactive TUI prompts for protected-room PINs; non-interactive commands still reject protected clipboards because they do not prompt for credentials.

Build release binaries:

```bash
bun run qd:build          # current platform
bun run qd:build:linux    # x86_64 Linux
bun run qd:build:windows  # x86_64 Windows, from a Windows runner
bun run qd:package:windows  # versioned qd.exe and SHA-256 assets
```

Artifacts are written below `cli/target/`.

## Desktop clients

Run the Tauri application in development:

```bash
bun run desktop:dev
```

Build for the current platform:

```bash
bun run desktop:build
```

Build the Windows client from Windows or a configured Windows CI runner:

```bash
bun run desktop:build:windows
```

Package the Linux release:

```bash
bun run desktop:package:linux
```

### End-user installation

Windows PowerShell:

```powershell
irm https://quickdrop.eaedave.xyz/install.ps1 | iex
```

The Windows installer installs or updates both the desktop/tray client and `qd.exe`, adds the CLI/TUI directory to the user `PATH`, and verifies the downloaded `qd.exe` against its published SHA-256 checksum. Open a new PowerShell window and run `qd` to start the TUI.

The standalone Windows CLI/TUI is also available from:

```text
https://quickdrop.eaedave.xyz/windows/qd/latest.exe
https://quickdrop.eaedave.xyz/windows/qd/latest.sha256
```

Linux full installation:

```bash
curl -fsSL https://quickdrop.eaedave.xyz/install.sh | bash
```

The installer is idempotent and always installs or updates the complete Linux experience: the desktop/tray client, the `qd` CLI/TUI binary, the launcher, and the detected OmarchyBar or Waybar integration. It stores the selected backend in `~/.config/quickdrop/config.env`; rerun the same command to update every component.

## Local backend with Docker

Start the optional backend service together with PostgreSQL:

```bash
bun run local:server:up
```

View logs or stop it:

```bash
bun run local:server:logs
bun run local:server:stop
```

The local service is exposed only on `127.0.0.1:3000`.

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/upload` | Upload one file or one client-generated ZIP |
| `GET` | `/f/:shortId` | Redirect to a temporary signed R2 download URL |
| `POST` | `/api/text` | Create a generated clipboard |
| `POST` | `/api/text/:code/open` | Atomically open or create a custom clipboard |
| `POST` | `/api/text/:code/access` | Validate access to a PIN-protected clipboard |
| `GET` | `/api/text/:code` | Read the current text-drop timeline |
| `GET` | `/api/text/:code/ws` | WebSocket synchronization endpoint |
| `POST` | `/api/text/metrics` | Record an allowed aggregate funnel event |

Text routes use `Cache-Control: no-store`. Clipboard codes are redacted from HTTP logs, and analytics never store clipboard codes, PINs, text content, client identifiers, IP addresses, or user agents.

## Database

Run migrations:

```bash
bun run db:migrate
```

Check the Drizzle schema and migrations:

```bash
bun run db:check
```

The container entrypoint runs migrations before starting the server when `RUN_MIGRATIONS_ON_START=true`.

## Deployment

The included [`Dockerfile`](Dockerfile) builds the web interface and runs the Bun backend. A production deployment needs:

1. A PostgreSQL database
2. A Cloudflare R2 bucket and API credentials
3. `PUBLIC_BASE_URL` set to the public QuickDrop backend URL
4. Port `3000`, or the value supplied through `PORT`, exposed by the platform
5. `QUICKDROP_GITHUB_TOKEN` when the backend must proxy private desktop release assets

The application is designed to run directly from the Dockerfile on platforms such as Coolify.

## Development checks

```bash
bun run typecheck
bun test
mise exec rust@stable -- cargo test --manifest-path cli/Cargo.toml
mise exec rust@stable -- cargo clippy --manifest-path cli/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
bun run desktop:build:web
```

File upload and download integration tests require working PostgreSQL and R2 credentials.

## License

No license file is currently included. Add one before distributing QuickDrop outside its intended private environment.
