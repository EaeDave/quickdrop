# Graph Report - quickdrop  (2026-08-14)

## Corpus Check
- 118 files · ~64,802 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1313 nodes · 2879 edges · 79 communities (66 shown, 13 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 57 edges (avg confidence: 0.64)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0fdffb2a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- install-macos.sh
- lib.rs
- QdError
- text-session-service.ts
- TextSession.tsx
- Contributing
- storage-quota.ts
- compilerOptions
- tauri.ts
- text-funnel-metrics.ts
- scripts
- JSONC Bar Patcher
- dependencies
- upload-service.ts
- tui.rs
- download-service.ts
- Desktop Manifest Metadata
- release.ts
- Development Dependencies
- Linux Installer Core
- tauri.conf.json
- System Architecture
- bundle
- Linux Bar Integration
- Windows Installer Logic
- permissions
- QuickDrop Window Launcher
- handle_key
- index.ts
- package-macos-qd-release.ts
- Product Capabilities
- Release Policy Workflow
- Waybar Patcher Tests
- package-windows-qd-release.ts
- Text Schema Migrations
- package.json
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
- .new
- App
- run_tui
- Open-source readiness audit
- bundle
- TerminalGuard
- text-client.ts
- handle_mouse
- InMemoryTextDropsRepository
- text-drops-repository.ts
- github-release.ts
- QuickPanel.tsx
- text-rooms-repository.ts
- schema.ts
- install-macos.test.ts
- text-session-service.test.ts
- InMemoryTextRoomsRepository
- install-linux.test.ts
- bun
- DelayedExpiryTextRoomsRepository
- config.ts
- install-bar-integration.test.ts
- lib

## God Nodes (most connected - your core abstractions)
1. `QdError` - 58 edges
2. `App` - 44 edges
3. `scripts` - 39 edges
4. `buildApp()` - 26 edges
5. `registerTextSessionRoutes()` - 23 edges
6. `handle_key()` - 22 edges
7. `handle_timeline_key()` - 21 edges
8. `run_mouse_action()` - 21 edges
9. `compilerOptions` - 20 edges
10. `handleReleaseAssetDownload()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `PostgreSQL Container` --semantically_similar_to--> `PostgreSQL Persistence`  [INFERRED] [semantically similar]
  compose.yml → README.md
- `Download Arrow Symbol` --conceptually_related_to--> `Temporary File Transfer`  [INFERRED]
  src-tauri/icons/icon.png → README.md
- `build_quickdrop_window()` --calls--> `App`  [EXTRACTED]
  src-tauri/src/lib.rs → cli/src/tui.rs
- `setup_desktop_tray()` --references--> `App`  [EXTRACTED]
  src-tauri/src/lib.rs → cli/src/tui.rs
- `QuickDrop Server Container` --conceptually_related_to--> `Bun Fastify Backend`  [INFERRED]
  compose.yml → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cross-platform QuickDrop Clients** — readme_desktop_architecture, readme_native_cli, readme_backend_architecture [EXTRACTED 1.00]
- **Verified Cross-platform Release Assets** — agents_release_policy, readme_release_pipeline, _github_workflows_release_windows_release [EXTRACTED 1.00]

## Communities (79 total, 13 thin omitted)

### Community 0 - "install-macos.sh"
Cohesion: 0.47
Nodes (8): acquire_app_lock(), cleanup(), fail(), info(), release_app_lock(), install-macos.sh script, verify_download(), warn()

### Community 1 - "lib.rs"
Cohesion: 0.05
Nodes (95): AppHandle, Monitor, PhysicalPosition, Position, autostart_configured_marker_lives_in_app_config_dir(), autostart_configured_marker_path(), build_quickdrop_window(), clamp_window_position() (+87 more)

### Community 2 - "QdError"
Cohesion: 0.06
Nodes (100): access_existing_room(), add_missing_pin_guidance(), copy_to_system_clipboard(), empty_room_does_not_invoke_the_clipboard_writer(), endpoint(), http_client(), latest_content(), latest_drop() (+92 more)

### Community 3 - "text-session-service.ts"
Cohesion: 0.07
Nodes (49): generateSessionCode(), normalizeSessionCode(), classifyTextDrop(), looksLikeJson(), TextDropContentType, clearRoomAccessCookie(), cookieName(), createRoomAccessCookie() (+41 more)

### Community 4 - "TextSession.tsx"
Cohesion: 0.12
Nodes (23): root, ClientTextMetricErrorCategory, RoomController, RoomKind, TextDrop, TextDropContentType, dropContentTypeLabel(), isPublishDropShortcut() (+15 more)

### Community 5 - "Contributing"
Cohesion: 0.22
Nodes (7): Contributing, Local setup, Pull requests, Security, Reporting a vulnerability, Security policy, Supported versions

### Community 6 - "storage-quota.ts"
Cohesion: 0.17
Nodes (17): cleanupExpiredUploads(), startCleanupJob(), generateShortId(), createR2Client(), uploads, hasPostgresUniqueViolation(), registerUploadWithStorageReservation(), releaseExpiredStorageReservations() (+9 more)

### Community 7 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, allowImportingTsExtensions, allowJs, jsx, module, moduleDetection, moduleResolution, noEmit (+10 more)

### Community 8 - "tauri.ts"
Cohesion: 0.08
Nodes (37): App(), copyTextToClipboard(), extractBackendMessage(), formatError(), formatSelectionName(), getFileName(), INSTALL_PLATFORMS, InstallPlatform (+29 more)

### Community 9 - "text-funnel-metrics.ts"
Cohesion: 0.09
Nodes (24): days, since, sql, incrementTextFunnelMetric(), metricDateUtc(), MetricsLogger, normalizeMetric(), retentionCutoffDate() (+16 more)

### Community 10 - "scripts"
Cohesion: 0.05
Nodes (39): scripts, bar:install, cleanup:run, db:check, db:generate, db:migrate, desktop:build, desktop:build:macos (+31 more)

### Community 11 - "JSONC Bar Patcher"
Cohesion: 0.10
Nodes (32): ensure_in_modules_right(), find_matching_brace(), find_matching_delimiter(), find_module_range(), find_modules_right_arrays(), last_significant_end(), line_start(), main() (+24 more)

### Community 12 - "dependencies"
Cohesion: 0.06
Nodes (35): @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, drizzle-orm, fastify, @fastify/cors, @fastify/multipart, @fastify/rate-limit, @fastify/static (+27 more)

### Community 13 - "upload-service.ts"
Cohesion: 0.08
Nodes (31): buildR2Key(), generateUploadId(), isValidCustomSessionCode(), sanitizeFilename(), putObject(), releaseUploadStorageReservation(), reserveUploadStorage(), defaultStorageQuotaGateway (+23 more)

### Community 14 - "tui.rs"
Cohesion: 0.09
Nodes (35): apply_update_event(), ConnectionState, ctrl_or_shift_enter_inserts_a_newline_without_publishing(), ctrl_u_requests_an_available_update_from_every_screen(), days_from_civil(), direct_entry_seeds_pin_and_authoritative_feedback(), DropOrigin, enter_publishes_and_clears_the_composer() (+27 more)

### Community 15 - "download-service.ts"
Cohesion: 0.27
Nodes (10): AppConfig, DownloadDeps, handleDownload(), computeExpiresAt(), computeSignedUrlExpirySeconds(), isExpired(), deleteObject(), signedDownloadUrl() (+2 more)

### Community 16 - "Desktop Manifest Metadata"
Cohesion: 0.10
Nodes (20): bar-widget, author, barWidget, allowMultiple, category, defaults, defaultSection, description (+12 more)

### Community 17 - "release.ts"
Cohesion: 0.09
Nodes (38): createTauriUpdateManifest(), main(), TauriUpdateManifest, TauriUpdatePlatform, updaterAssets(), LOCAL_BASE_URLS, publicBaseUrl(), updaterBaseUrl() (+30 more)

### Community 18 - "Development Dependencies"
Cohesion: 0.11
Nodes (19): drizzle-kit, devDependencies, drizzle-kit, tailwindcss, @tailwindcss/cli, @tauri-apps/cli, @types/bun, @types/react (+11 more)

### Community 19 - "Linux Installer Core"
Cohesion: 0.30
Nodes (15): check_runtime_deps(), detect_environment(), ensure_tmp_dir(), fail(), info(), install_bar_integration(), install_binary(), install_integration_assets() (+7 more)

### Community 20 - "tauri.conf.json"
Cohesion: 0.11
Nodes (17): app, macOSPrivateApi, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+9 more)

### Community 21 - "System Architecture"
Cohesion: 0.18
Nodes (13): PostgreSQL Container, Local Docker Stack, QuickDrop Server Container, Bun Development Guidelines, Bun Frontend Pipeline, Bun Native APIs, Bun Fastify Backend, Cloudflare R2 Storage (+5 more)

### Community 22 - "bundle"
Cohesion: 0.15
Nodes (12): icons/icon.ico, nsis, bundle, active, icon, targets, windows, icons/icon.png (+4 more)

### Community 23 - "Linux Bar Integration"
Cohesion: 0.39
Nodes (11): detect_bar(), fail(), info(), install_omarchy(), install_waybar(), omarchy_available(), omarchy_bar_active(), install-bar-integration.sh script (+3 more)

### Community 24 - "Windows Installer Logic"
Cohesion: 0.27
Nodes (7): Get-InstalledQuickDropPath(), Join-OptionalPath(), Resolve-DirectoryPath(), Resolve-ExecutablePath(), Resolve-PathValue(), Start-InstalledQuickDrop(), Test-ExistingFile()

### Community 25 - "permissions"
Cohesion: 0.15
Nodes (12): core:default, core:window:allow-close, core:window:allow-start-dragging, dialog:default, main, process:allow-restart, updater:default, description (+4 more)

### Community 26 - "QuickDrop Window Launcher"
Cohesion: 0.46
Nodes (6): quickdrop-launcher script, cleanup_spawn_rule(), close_quickdrop_window(), disable_spawn_rule(), install_spawn_rule(), place_quickdrop_window()

### Community 27 - "handle_key"
Cohesion: 0.20
Nodes (19): Action, cancel_composer(), confirm_delete(), copy_selected(), ctrl_p_requests_a_pin_before_creating_a_protected_room(), ctrl_p_with_empty_code_enters_protected_create_then_asks_for_pin(), handle_key(), handle_timeline_key() (+11 more)

### Community 28 - "index.ts"
Cohesion: 0.12
Nodes (36): DesktopUpdatePlatform, escapeRegExp(), handleDesktopUpdateDownload(), handleDesktopUpdateManifestDownload(), isDesktopUpdatePlatform(), PLATFORM_ASSET_NAMES, handleReleaseAssetDownload(), buildApp() (+28 more)

### Community 29 - "package-macos-qd-release.ts"
Cohesion: 0.40
Nodes (3): architectures, qdReleaseDirectory, { version }

### Community 30 - "Product Capabilities"
Cohesion: 0.33
Nodes (6): Temporary File Transfer, Privacy-preserving Clipboard Model, QuickDrop, Real-time Text Clipboards, Download Arrow Symbol, QuickDrop App Icon

### Community 31 - "Release Policy Workflow"
Cohesion: 0.50
Nodes (5): GitHub Release Asset Upload, Windows Desktop and CLI Build, Windows Release Workflow, Release Policy, Cross-platform Release Pipeline

### Community 33 - "package-windows-qd-release.ts"
Cohesion: 0.33
Nodes (5): assetPath, checksum, releaseDirectory, updaterInstallerPath, { version }

### Community 35 - "package.json"
Cohesion: 0.20
Nodes (9): license, name, overrides, brace-expansion, esbuild, fast-uri, find-my-way, private (+1 more)

### Community 36 - "Desktop Installer Service"
Cohesion: 0.50
Nodes (3): installer, qdReleaseBinary, releaseBinary

### Community 37 - "Linux Release Packaging"
Cohesion: 0.50
Nodes (3): assets, qdChecksum, { version }

### Community 55 - ".new"
Cohesion: 0.24
Nodes (13): App<'a>, apply_network_event(), ctrl_o_leaves_the_current_room_without_quitting(), drop(), e_edits_the_selected_drop_and_restores_the_composer_draft(), keeps_newest_drops_first_and_selection_valid(), origin_expiry_snapshot_preservation_and_remote_fallback_are_independent(), q_quits_from_help_and_failed_publish_restores_the_composer() (+5 more)

### Community 56 - "App"
Cohesion: 0.17
Nodes (28): ActionRegion, App, centered_rect(), HoverTarget, MouseAction, open_room_link(), register_centered_actions(), render() (+20 more)

### Community 57 - "run_tui"
Cohesion: 0.33
Nodes (5): entry_feedback_expires_without_clearing_newer_status(), is_open_feedback_message(), open_feedback(), run_tui(), Instant

### Community 58 - "Open-source readiness audit"
Cohesion: 0.33
Nodes (5): Completed hardening, Expected public values, Open-source readiness audit, Remaining checks before changing visibility, Residual dependency notices

### Community 59 - "bundle"
Cohesion: 0.15
Nodes (12): dmg, icons/icon.icns, bundle, active, category, icon, macOS, targets (+4 more)

### Community 60 - "TerminalGuard"
Cohesion: 0.20
Nodes (9): keyboard_enhancement_is_optional(), Drop, Self, terminal_error(), TerminalGuard, CrosstermBackend, Error, Stdout (+1 more)

### Community 61 - "text-client.ts"
Cohesion: 0.17
Nodes (30): ClientTextMetric, connectRoom(), createJsonRequest(), createRoom(), fetchSnapshot(), formatIdleWindow(), formatRemaining(), formatRoomExpiry() (+22 more)

### Community 62 - "handle_mouse"
Cohesion: 0.23
Nodes (11): handle_mouse(), mouse_event(), mouse_hover_visually_tracks_every_interactive_region(), mouse_selects_drops_focuses_composer_and_runs_visible_actions(), overlays_do_not_hover_inactive_timeline_regions(), point_in_rect(), update_hover(), CompletedFrame (+3 more)

### Community 63 - "InMemoryTextDropsRepository"
Cohesion: 0.22
Nodes (4): TextDropRow, copyDrop(), DelayedListTextDropsRepository, InMemoryTextDropsRepository

### Community 64 - "text-drops-repository.ts"
Cohesion: 0.21
Nodes (17): Database, db, SqlClient, textRooms, clearDrops(), createDrop(), deleteDrop(), findExpiredDrops() (+9 more)

### Community 65 - "github-release.ts"
Cohesion: 0.38
Nodes (6): fetchRelease(), fetchReleaseAsset(), githubHeaders(), GitHubRelease, GitHubReleaseAsset, ReleaseAssetDownloadOptions

### Community 66 - "QuickPanel.tsx"
Cohesion: 0.16
Nodes (17): formatError(), normalizeCode(), PanelStatus, preview(), QuickPanel(), readNotificationsMuted(), readRecentCodes(), shouldNotifyRemoteDrop() (+9 more)

### Community 67 - "text-rooms-repository.ts"
Cohesion: 0.24
Nodes (7): activeRoomFilter(), createTextRoomWithinLimit(), findExpiredTextRooms(), findTextRoomByCode(), TextRoomsRepository, toTextRoomRow(), updateTextRoomText()

### Community 68 - "schema.ts"
Cohesion: 0.18
Nodes (10): storageQuota, StorageQuotaRecord, StorageReservationRecord, storageReservations, TextDropRecord, textDrops, TextFunnelMetricRecord, textFunnelMetrics (+2 more)

### Community 82 - "text-session-service.test.ts"
Cohesion: 0.13
Nodes (15): ClearTextDropsResult, CreateTextDropInput, CreateTextDropResult, DeleteTextDropResult, TextDropsRepository, UpdateTextDropInput, UpdateTextDropResult, expectJoined() (+7 more)

### Community 83 - "InMemoryTextRoomsRepository"
Cohesion: 0.22
Nodes (6): CreateTextRoomInput, TextRoomCreationResult, TextRoomRow, BarrierTextRoomsRepository, copyRoom(), InMemoryTextRoomsRepository

### Community 84 - "install-linux.test.ts"
Cohesion: 0.18
Nodes (7): barInstallerSource, hasToolchain, launcherSource, omarchyPluginSource, Sandbox, scriptPath, waybarPatcherSource

### Community 85 - "bun"
Cohesion: 0.22
Nodes (6): bun, launcher, runner, migrate(), waitForDatabase(), types

### Community 87 - "config.ts"
Cohesion: 0.47
Nodes (7): loadConfig(), normalizePublicBaseUrl(), readBoolean(), readOptional(), readPositiveInteger(), readRequired(), requiredEnv

### Community 88 - "install-bar-integration.test.ts"
Cohesion: 0.40
Nodes (5): executable(), fakePath(), hasToolchain, installer, pluginSource

### Community 89 - "lib"
Cohesion: 0.50
Nodes (4): DOM, DOM.Iterable, ESNext, lib

## Knowledge Gaps
- **285 isolated node(s):** `runner`, `args`, `command`, `baseUrl`, `updaterPublicKey` (+280 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `App` connect `App` to `lib.rs`, `QdError`, `tui.rs`, `.new`, `run_tui`, `handle_key`, `handle_mouse`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `QdError` connect `QdError` to `tui.rs`, `run_tui`, `handle_key`, `TerminalGuard`, `handle_mouse`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `bun` connect `bun` to `install-bar-integration.test.ts`, `text-drops-repository.ts`, `install-linux.test.ts`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `runner`, `args`, `command` to the rest of the system?**
  _285 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.05404551201011378 - nodes in this community are weakly interconnected._
- **Should `QdError` be split into smaller, more focused modules?**
  _Cohesion score 0.05536445536445536 - nodes in this community are weakly interconnected._
- **Should `text-session-service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0675990675990676 - nodes in this community are weakly interconnected._