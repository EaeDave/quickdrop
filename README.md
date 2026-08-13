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

Open the web application and enter a code containing 1–16 ASCII letters, numbers, `_`, or `-`. The same operation opens an active clipboard or creates it when it does not exist.

Each publication creates a drop. By default, a clipboard retains its 10 newest drops, and each drop expires after 12 hours. Public custom codes are intentionally easy to type and must not be treated as secrets. PIN-protected clipboards are available through the web interface and interactive TUI.

Canonical URLs use this form:

```text
https://quickdrop.example/MYCODE
```

### Native CLI

The `qd` client is a standalone Rust binary and does not require Bun or Node.js at runtime.

Install it from the repository:

```bash
mise exec rust@stable -- cargo install --path cli
```
Run `qd` in an interactive terminal to open the room chooser:

```bash
qd
```

The canonical room commands are:

```bash
qd ROOM                         # open the TUI; create a public room if needed
qd ROOM PIN                     # open the TUI; create a PIN-protected room if needed
qd ROOM --msg "text to publish" # publish without opening the TUI
qd ROOM PIN --msg "secret text" # publish with a positional PIN
qd ROOM --msg - < message.txt   # read the message from stdin and publish it
qd ROOM --copy                  # print and copy the newest drop
```

`qd ROOM` and `qd ROOM PIN` open the TUI directly. A PIN supplied for an existing public room is an error: remove the PIN and use `qd ROOM --msg <text>` or `qd ROOM --copy` as appropriate. It is never ignored. `--msg` and `--copy` are mutually exclusive, duplicate options and extra positionals are errors. Interactive commands require a terminal; otherwise `qd` explains: `interactive mode requires a terminal; use --msg <text> or --copy instead.`

Keyboard shortcuts:

| Context | Keys | Action |
|---|---|---|
| Code | `Enter` | Open a clipboard or create a public one |
| Code | `Ctrl+P` | Start a PIN-protected create; Enter then asks for the PIN |
| Timeline | `j`/`J`/`↓`, `k`/`K`/`↑` | Select the next or previous drop |
| Timeline | `g`/`G`/`Home`, `End` | Select the first or last drop |
| Timeline | `Enter`, `i`/`I`, `Tab` | Focus the composer |
| Timeline | `e`/`E`, `c`/`C`, `r`/`R`, `d`/`D` | Edit, copy, resend, or delete the selected drop |
| Any screen | `Ctrl+O` | Leave the current clipboard and enter another code |
| Any screen | `Ctrl+U` | Install an available `qd` update and restart the TUI |
| Timeline | `?`, `q`/`Q` | Open help or quit |
| Confirm delete | `y`/`Y`, `Enter`; `n`/`N`, `Esc` | Confirm or cancel the deletion |
| Composer | `Enter`, `Ctrl+Enter`/`Shift+Enter` | Publish a new drop or insert a line break |
| Composer | `Esc` | Return to the timeline |
| Editor | `Enter`, `Ctrl+Enter`/`Shift+Enter` | Save changes or insert a line break |
| Editor | `Esc` | Cancel editing |

Mouse input can select timeline drops, focus the composer, scroll either region, and activate the visible action buttons. Hovering highlights clickable controls, timeline rows, and the composer; completed mouse actions report concise feedback in the footer. Hold `Shift` while dragging to use the terminal's native text selection.

Room entry feedback distinguishes an opened room from a newly created room and reports whether it is public or PIN-protected from the authoritative server response. Presence is explicit in the header and connection status. Each drop's origin is `Unknown` for snapshot-only data, `Self` when `by` matches this client, or `Remote` for another client; the newest `Remote` drop stays cyan until it is superseded, deleted, or cleared, while `NEW` is a separate temporary marker.

The layout adapts to small terminals and respects the `NO_COLOR` environment variable. It uses only standard Unicode symbols and does not require a Nerd Font.

Non-interactive commands remain suitable for pipes and scripts: requested content alone goes to stdout, while diagnostics and feedback go to stderr.

Update the installed `qd` binary from the latest public release:

```bash
qd update
qd update --check
```


The TUI header shows the canonical room URL. Hovering highlights it as an interactive control; clicking copies the URL to the system clipboard, opens it in the default browser, and reports both results in the footer.
The TUI checks for a newer release on launch. If one is available, press `Ctrl+U` from any screen to download it, verify the published SHA-256 checksum, replace the running binary, and restart the TUI.


Publish without opening the TUI:

```bash
qd MYCODE --msg "text from SSH"
qd MYCODE 1234 --msg "secret text"
printf '%s\n' "text from stdin" | qd MYCODE --msg -
printf '%s\n' "secret from stdin" | qd MYCODE 1234 --msg -
```

`--msg -` reads the message from stdin. Publishing creates a missing room (publicly, or PIN-protected when a PIN is supplied). A PIN supplied for an existing public room fails instead of being ignored.

Print and copy the newest drop:

```bash
qd MYCODE --copy
qd MYCODE 1234 --copy
```

`--copy` never creates a missing room. For an empty room it prints `qd: No messages found.` to stderr and does not change the local clipboard. For non-empty rooms, the newest content is the only stdout output; operational feedback (including `Copied the latest message.`) always goes to stderr.

Show help or the installed version:

```bash
qd --help
qd --version
```

Use another QuickDrop backend:

```bash
qd --server http://127.0.0.1:3000
qd MYCODE --server http://127.0.0.1:3000
qd MYCODE --msg "local test" --server http://127.0.0.1:3000
```

On Linux, copied content uses `wl-copy`, `xclip`, or `xsel`. On Windows, it uses PowerShell `Set-Clipboard`. The interactive TUI prompts for protected-room PINs; non-interactive commands take the PIN positionally.

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

### Publishing a release

From a clean, up-to-date `main` branch on an x86_64 Linux host, publish with one command:

```bash
bun run release patch
# or: bun run release minor
# or: bun run release 1.0.0
```

The command keeps the desktop and CLI manifests aligned, validates them, builds and packages all Linux assets locally, commits the version, and atomically pushes `main` with its annotated tag. It immediately creates the GitHub release with the Linux desktop and CLI/TUI binaries plus checksum. The tag starts the cached Windows Actions job, which adds the Windows installer and CLI/TUI assets. The command waits for that job and verifies every public download before succeeding. Linux is intentionally never built in Actions; use `bun run release:check` for a non-publishing manifest check.

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

## Knowledge graph

The versioned [`graphify-out/`](graphify-out/) artifacts provide an interactive architecture map, a plain-language audit report, and queryable graph data:

- `graph.html` — interactive visualization
- `GRAPH_REPORT.md` — architecture and graph-health report
- `graph.json` — machine-readable graph

Install [graphify](https://github.com/safishamsi/graphify) and enable automatic code-only rebuilds for commits and branch switches with:

```bash
graphify hook install
```

Git hooks are local to each clone. Run `graphify query "<question>"` to explore the committed graph, or run `graphify .` for a complete rebuild including documentation and images.

## License

No license file is currently included. Add one before distributing QuickDrop outside its intended private environment.
