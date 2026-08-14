# Graph Report - quickdrop  (2026-08-13)

## Corpus Check
- 100 files · ~55,973 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1161 nodes · 2572 edges · 70 communities (53 shown, 17 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `82132e3c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- handle_timeline_key
- lib.rs
- QdError
- text-session-service.ts
- text-client.ts
- text-session-service.test.ts
- storage-quota.ts
- Build Configuration
- App.tsx
- index.ts
- Project Scripts
- JSONC Bar Patcher
- dependencies
- upload-service.ts
- tui.rs
- download-service.ts
- Desktop Manifest Metadata
- Release Orchestration
- Development Dependencies
- Linux Installer Core
- Tauri Application Config
- System Architecture
- Windows Bundle Config
- Linux Bar Integration
- Windows Installer Logic
- Tauri Permissions
- QuickDrop Window Launcher
- config.ts
- App
- TextSession.tsx
- Product Capabilities
- Release Policy Workflow
- Waybar Patcher Tests
- Windows CLI Packaging
- Text Schema Migrations
- Package Metadata
- Desktop Installer Service
- Linux Release Packaging
- Storage Schema Migrations
- Drizzle Configuration
- Upload Schema Migration
- Metrics Schema Migration
- Container Entrypoint
- Local Bar Installer
- HTML Type Declarations
- Desktop Crate
- CLI Crate
- Option
- TerminalGuard
- text-drops-repository.ts
- web-route.ts
- formatRoomExpiry
- App<'a>
- .draw
- .new
- upload-service.test.ts
- Client
- TextDrop
- Drop
- HashMap
- Self
- TextDrop

## God Nodes (most connected - your core abstractions)
1. `QdError` - 56 edges
2. `App` - 44 edges
3. `scripts` - 34 edges
4. `registerTextSessionRoutes()` - 23 edges
5. `handle_key()` - 22 edges
6. `handle_timeline_key()` - 21 edges
7. `run_mouse_action()` - 21 edges
8. `compilerOptions` - 20 edges
9. `App<'a>` - 19 edges
10. `run()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `PostgreSQL Container` --semantically_similar_to--> `PostgreSQL Persistence`  [INFERRED] [semantically similar]
  compose.yml → README.md
- `Download Arrow Symbol` --conceptually_related_to--> `Temporary File Transfer`  [INFERRED]
  src-tauri/icons/icon.png → README.md
- `build_quickdrop_window()` --calls--> `App`  [EXTRACTED]
  src-tauri/src/lib.rs → cli/src/tui.rs
- `setup_windows_tray()` --references--> `App`  [EXTRACTED]
  src-tauri/src/lib.rs → cli/src/tui.rs
- `QuickDrop Server Container` --conceptually_related_to--> `Bun Fastify Backend`  [INFERRED]
  compose.yml → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cross-platform QuickDrop Clients** — readme_desktop_architecture, readme_native_cli, readme_backend_architecture [EXTRACTED 1.00]
- **Verified Cross-platform Release Assets** — agents_release_policy, readme_release_pipeline, _github_workflows_release_windows_release [EXTRACTED 1.00]

## Communities (70 total, 17 thin omitted)

### Community 0 - "handle_timeline_key"
Cohesion: 0.21
Nodes (17): Action, cancel_composer(), confirm_delete(), copy_selected(), ctrl_or_shift_enter_inserts_a_newline_without_publishing(), enter_publishes_and_clears_the_composer(), handle_mouse(), handle_timeline_key() (+9 more)

### Community 1 - "lib.rs"
Cohesion: 0.06
Nodes (87): AppHandle, Color, Monitor, PhysicalPosition, Position, autostart_configured_marker_lives_in_app_config_dir(), autostart_configured_marker_path(), build_quickdrop_window() (+79 more)

### Community 2 - "QdError"
Cohesion: 0.06
Nodes (96): access_existing_room(), add_missing_pin_guidance(), copy_to_system_clipboard(), empty_room_does_not_invoke_the_clipboard_writer(), endpoint(), http_client(), latest_content(), latest_drop() (+88 more)

### Community 3 - "text-session-service.ts"
Cohesion: 0.07
Nodes (51): buildR2Key(), generateSessionCode(), isValidCustomSessionCode(), normalizeSessionCode(), sanitizeFilename(), classifyTextDrop(), looksLikeJson(), TextDropContentType (+43 more)

### Community 4 - "text-client.ts"
Cohesion: 0.20
Nodes (25): ClientTextMetric, connectRoom(), createJsonRequest(), createRoom(), fetchSnapshot(), getErrorCode(), getErrorMessage(), getRoomUrl() (+17 more)

### Community 5 - "text-session-service.test.ts"
Cohesion: 0.05
Nodes (34): TextRoomRecord, ClearTextDropsResult, CreateTextDropInput, CreateTextDropResult, DeleteTextDropResult, TextDropRow, UpdateTextDropInput, UpdateTextDropResult (+26 more)

### Community 6 - "storage-quota.ts"
Cohesion: 0.13
Nodes (21): generateShortId(), storageQuota, StorageQuotaRecord, StorageReservationRecord, storageReservations, TextDropRecord, textDrops, TextFunnelMetricRecord (+13 more)

### Community 7 - "Build Configuration"
Cohesion: 0.04
Nodes (39): bun, DOM, DOM.Iterable, ESNext, executable(), fakePath(), hasToolchain, installer (+31 more)

### Community 8 - "App.tsx"
Cohesion: 0.09
Nodes (31): App(), copyTextToClipboard(), extractBackendMessage(), formatError(), formatSelectionName(), getFileName(), INSTALL_PLATFORMS, InstallPlatform (+23 more)

### Community 9 - "index.ts"
Cohesion: 0.06
Nodes (52): days, since, sql, fetchLatestRelease(), fetchReleaseAsset(), githubHeaders(), GitHubRelease, GitHubReleaseAsset (+44 more)

### Community 10 - "Project Scripts"
Cohesion: 0.06
Nodes (34): scripts, bar:install, cleanup:run, db:check, db:generate, db:migrate, desktop:build, desktop:build:web (+26 more)

### Community 11 - "JSONC Bar Patcher"
Cohesion: 0.10
Nodes (32): ensure_in_modules_right(), find_matching_brace(), find_matching_delimiter(), find_module_range(), find_modules_right_arrays(), last_significant_end(), line_start(), main() (+24 more)

### Community 12 - "dependencies"
Cohesion: 0.06
Nodes (31): @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, drizzle-orm, fastify, @fastify/cors, @fastify/multipart, @fastify/rate-limit, @fastify/static (+23 more)

### Community 13 - "upload-service.ts"
Cohesion: 0.10
Nodes (24): generateUploadId(), putObject(), releaseUploadStorageReservation(), reserveUploadStorage(), defaultStorageQuotaGateway, deleteRegisteredUpload(), deleteUploadedObject(), drainMultipartFile() (+16 more)

### Community 14 - "tui.rs"
Cohesion: 0.11
Nodes (22): apply_update_event(), ctrl_o_leaves_the_current_room_without_quitting(), ctrl_p_requests_a_pin_before_creating_a_protected_room(), ctrl_p_with_empty_code_enters_protected_create_then_asks_for_pin(), ctrl_u_requests_an_available_update_from_every_screen(), direct_entry_seeds_pin_and_authoritative_feedback(), entry_feedback_expires_without_clearing_newer_status(), handle_key() (+14 more)

### Community 15 - "download-service.ts"
Cohesion: 0.20
Nodes (15): cleanupExpiredUploads(), startCleanupJob(), AppConfig, DownloadDeps, handleDownload(), computeExpiresAt(), computeSignedUrlExpirySeconds(), isExpired() (+7 more)

### Community 16 - "Desktop Manifest Metadata"
Cohesion: 0.10
Nodes (20): bar-widget, author, barWidget, allowMultiple, category, defaults, defaultSection, description (+12 more)

### Community 17 - "Release Orchestration"
Cohesion: 0.22
Nodes (18): assertReleasePlatform(), currentVersion(), escapeRegExp(), main(), manifestVersions(), nextVersion(), output(), parseVersion() (+10 more)

### Community 18 - "Development Dependencies"
Cohesion: 0.11
Nodes (19): drizzle-kit, devDependencies, drizzle-kit, tailwindcss, @tailwindcss/cli, @tauri-apps/cli, @types/bun, @types/react (+11 more)

### Community 19 - "Linux Installer Core"
Cohesion: 0.30
Nodes (15): check_runtime_deps(), detect_environment(), ensure_tmp_dir(), fail(), info(), install_bar_integration(), install_binary(), install_integration_assets() (+7 more)

### Community 20 - "Tauri Application Config"
Cohesion: 0.14
Nodes (13): app, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist, bundle (+5 more)

### Community 21 - "System Architecture"
Cohesion: 0.18
Nodes (13): PostgreSQL Container, Local Docker Stack, QuickDrop Server Container, Bun Development Guidelines, Bun Frontend Pipeline, Bun Native APIs, Bun Fastify Backend, Cloudflare R2 Storage (+5 more)

### Community 22 - "Windows Bundle Config"
Cohesion: 0.15
Nodes (12): icons/icon.ico, icons/icon.png, nsis, bundle, active, icon, targets, windows (+4 more)

### Community 23 - "Linux Bar Integration"
Cohesion: 0.39
Nodes (11): detect_bar(), fail(), info(), install_omarchy(), install_waybar(), omarchy_available(), omarchy_bar_active(), install-bar-integration.sh script (+3 more)

### Community 24 - "Windows Installer Logic"
Cohesion: 0.27
Nodes (7): Get-InstalledQuickDropPath(), Join-OptionalPath(), Resolve-DirectoryPath(), Resolve-ExecutablePath(), Resolve-PathValue(), Start-InstalledQuickDrop(), Test-ExistingFile()

### Community 25 - "Tauri Permissions"
Cohesion: 0.18
Nodes (10): core:default, core:window:allow-close, core:window:allow-start-dragging, dialog:default, main, description, identifier, permissions (+2 more)

### Community 26 - "QuickDrop Window Launcher"
Cohesion: 0.46
Nodes (6): quickdrop-launcher script, cleanup_spawn_rule(), close_quickdrop_window(), disable_spawn_rule(), install_spawn_rule(), place_quickdrop_window()

### Community 27 - "config.ts"
Cohesion: 0.35
Nodes (8): loadConfig(), readBoolean(), readOptional(), readPositiveInteger(), readRequired(), requiredEnv, Database, SqlClient

### Community 28 - "App"
Cohesion: 0.18
Nodes (13): App, DropOrigin, Focus, HoverTarget, open_room_link(), room_link_uses_the_canonical_url_and_runs_both_click_actions(), room_url(), C (+5 more)

### Community 29 - "TextSession.tsx"
Cohesion: 0.12
Nodes (18): ClientTextMetricErrorCategory, recordTextMetric(), RoomAccessError, RoomController, RoomKind, TextDrop, TextDropContentType, dropContentTypeLabel() (+10 more)

### Community 30 - "Product Capabilities"
Cohesion: 0.33
Nodes (6): Temporary File Transfer, Privacy-preserving Clipboard Model, QuickDrop, Real-time Text Clipboards, Download Arrow Symbol, QuickDrop App Icon

### Community 31 - "Release Policy Workflow"
Cohesion: 0.50
Nodes (5): GitHub Release Asset Upload, Windows Desktop and CLI Build, Windows Release Workflow, Release Policy, Cross-platform Release Pipeline

### Community 33 - "Windows CLI Packaging"
Cohesion: 0.40
Nodes (4): assetPath, checksum, releaseDirectory, { version }

### Community 35 - "Package Metadata"
Cohesion: 0.50
Nodes (3): name, private, type

### Community 36 - "Desktop Installer Service"
Cohesion: 0.50
Nodes (3): installer, qdReleaseBinary, releaseBinary

### Community 37 - "Linux Release Packaging"
Cohesion: 0.50
Nodes (3): assets, qdChecksum, { version }

### Community 55 - "Option"
Cohesion: 0.14
Nodes (23): AvailableUpdate, ConnectionState, days_from_civil(), error_message(), expired_access_returns_to_pin_and_reconnect_releases_the_editor(), format_compact_remaining(), format_remaining_clock(), format_room_expiry() (+15 more)

### Community 56 - "TerminalGuard"
Cohesion: 0.20
Nodes (9): keyboard_enhancement_is_optional(), terminal_error(), TerminalGuard, CrosstermBackend, Drop, Error, Self, Stdout (+1 more)

### Community 57 - "text-drops-repository.ts"
Cohesion: 0.26
Nodes (15): db, textRooms, clearDrops(), createDrop(), deleteDrop(), findExpiredDrops(), listActiveDrops(), lockRoom() (+7 more)

### Community 58 - "web-route.ts"
Cohesion: 0.57
Nodes (6): initialRoomCode(), isTextRoute(), normalizeRoomCode(), roomCodeFromPathname(), setRoomInUrl(), textRoomPath()

### Community 59 - "formatRoomExpiry"
Cohesion: 0.50
Nodes (3): formatIdleWindow(), formatRemaining(), formatRoomExpiry()

### Community 60 - "App<'a>"
Cohesion: 0.23
Nodes (11): TextDrop, App<'a>, apply_network_event(), drop(), e_edits_the_selected_drop_and_restores_the_composer_draft(), keeps_newest_drops_first_and_selection_valid(), origin_expiry_snapshot_preservation_and_remote_fallback_are_independent(), Vec (+3 more)

### Community 61 - ".draw"
Cohesion: 0.28
Nodes (8): mouse_event(), mouse_hover_visually_tracks_every_interactive_region(), mouse_selects_drops_focuses_composer_and_runs_visible_actions(), overlays_do_not_hover_inactive_timeline_regions(), CompletedFrame, F, MouseEvent, MouseEventKind

### Community 62 - ".new"
Cohesion: 0.30
Nodes (17): ActionRegion, centered_rect(), MouseAction, register_centered_actions(), render(), render_action_footer(), render_centered_actions(), render_code() (+9 more)

### Community 63 - "upload-service.test.ts"
Cohesion: 0.25
Nodes (4): config, multipartHeaders, multipartPayload, UploadDeps

## Knowledge Gaps
- **230 isolated node(s):** `ConnectionPhase`, `DropOrigin`, `ExportState`, `SpooledUpload`, `StorageQuotaGateway` (+225 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `App` connect `App` to `handle_timeline_key`, `lib.rs`, `tui.rs`, `Option`, `App<'a>`, `.new`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Why does `QdError` connect `QdError` to `handle_timeline_key`, `TerminalGuard`, `tui.rs`, `Option`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `bun` connect `Build Configuration` to `config.ts`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `ConnectionPhase`, `DropOrigin`, `ExportState` to the rest of the system?**
  _230 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.05672948791166952 - nodes in this community are weakly interconnected._
- **Should `QdError` be split into smaller, more focused modules?**
  _Cohesion score 0.059157509157509156 - nodes in this community are weakly interconnected._
- **Should `text-session-service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06583850931677018 - nodes in this community are weakly interconnected._