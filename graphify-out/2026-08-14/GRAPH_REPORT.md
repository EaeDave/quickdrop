# Graph Report - quickdrop  (2026-08-14)

## Corpus Check
- 108 files · ~61,008 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1252 nodes · 2729 edges · 78 communities (55 shown, 23 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `45756512`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- install-macos.sh
- lib.rs
- QdError
- text-session-service.ts
- text-client.ts
- text-session-service.test.ts
- storage-quota.ts
- Build Configuration
- App.tsx
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
- App
- index.ts
- package-macos-qd-release.ts
- Product Capabilities
- Release Policy Workflow
- Waybar Patcher Tests
- package-windows-qd-release.ts
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
- .replace_drops
- .new
- App<'a>
- InMemoryTextRoomsRepository
- bundle
- TerminalGuard
- index.test.ts
- config.ts
- InMemoryTextDropsRepository
- text-drops-repository.ts
- DelayedExpiryTextRoomsRepository
- text-rooms-repository.ts
- install-macos.test.ts
- Drop
- HashMap
- Option
- OsString
- Path
- PathBuf
- Result
- Self
- String
- Vec

## God Nodes (most connected - your core abstractions)
1. `QdError` - 58 edges
2. `App` - 42 edges
3. `scripts` - 38 edges
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
- `QuickDrop Server Container` --conceptually_related_to--> `Bun Fastify Backend`  [INFERRED]
  compose.yml → README.md
- `Bun Frontend Pipeline` --conceptually_related_to--> `Desktop HTML Entry`  [INFERRED]
  docs/CLAUDE.md → src/desktop/index.html
- `Desktop HTML Entry` --conceptually_related_to--> `React Tauri Desktop`  [INFERRED]
  src/desktop/index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cross-platform QuickDrop Clients** — readme_desktop_architecture, readme_native_cli, readme_backend_architecture [EXTRACTED 1.00]
- **Verified Cross-platform Release Assets** — agents_release_policy, readme_release_pipeline, _github_workflows_release_windows_release [EXTRACTED 1.00]

## Communities (78 total, 23 thin omitted)

### Community 0 - "install-macos.sh"
Cohesion: 0.47
Nodes (8): acquire_app_lock(), cleanup(), fail(), info(), release_app_lock(), install-macos.sh script, verify_download(), warn()

### Community 1 - "lib.rs"
Cohesion: 0.06
Nodes (91): App, AppHandle, Color, Drop, HashMap, Monitor, Option, OsString (+83 more)

### Community 2 - "QdError"
Cohesion: 0.06
Nodes (100): access_existing_room(), add_missing_pin_guidance(), copy_to_system_clipboard(), empty_room_does_not_invoke_the_clipboard_writer(), endpoint(), http_client(), latest_content(), latest_drop() (+92 more)

### Community 3 - "text-session-service.ts"
Cohesion: 0.07
Nodes (49): buildR2Key(), generateSessionCode(), isValidCustomSessionCode(), normalizeSessionCode(), sanitizeFilename(), classifyTextDrop(), looksLikeJson(), TextDropContentType (+41 more)

### Community 4 - "text-client.ts"
Cohesion: 0.07
Nodes (53): root, ClientTextMetric, ClientTextMetricErrorCategory, connectRoom(), createJsonRequest(), createRoom(), fetchSnapshot(), formatIdleWindow() (+45 more)

### Community 5 - "text-session-service.test.ts"
Cohesion: 0.17
Nodes (12): CreateTextRoomInput, TextRoomCreationResult, BarrierTextRoomsRepository, expectJoined(), MutableClock, nextMessage(), nextMessageOfType(), pendingReceivers (+4 more)

### Community 6 - "storage-quota.ts"
Cohesion: 0.12
Nodes (22): Database, db, SqlClient, generateShortId(), storageQuota, StorageQuotaRecord, StorageReservationRecord, storageReservations (+14 more)

### Community 7 - "Build Configuration"
Cohesion: 0.04
Nodes (39): bun, DOM, DOM.Iterable, ESNext, executable(), fakePath(), hasToolchain, installer (+31 more)

### Community 8 - "App.tsx"
Cohesion: 0.09
Nodes (35): App(), copyTextToClipboard(), extractBackendMessage(), formatError(), formatSelectionName(), getFileName(), INSTALL_PLATFORMS, InstallPlatform (+27 more)

### Community 9 - "text-funnel-metrics.ts"
Cohesion: 0.09
Nodes (26): days, since, sql, createTextFunnelMetrics(), incrementTextFunnelMetric(), metricDateUtc(), MetricsLogger, normalizeMetric() (+18 more)

### Community 10 - "scripts"
Cohesion: 0.05
Nodes (38): scripts, bar:install, cleanup:run, db:check, db:generate, db:migrate, desktop:build, desktop:build:macos (+30 more)

### Community 11 - "JSONC Bar Patcher"
Cohesion: 0.10
Nodes (32): ensure_in_modules_right(), find_matching_brace(), find_matching_delimiter(), find_module_range(), find_modules_right_arrays(), last_significant_end(), line_start(), main() (+24 more)

### Community 12 - "dependencies"
Cohesion: 0.06
Nodes (35): @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, drizzle-orm, fastify, @fastify/cors, @fastify/multipart, @fastify/rate-limit, @fastify/static (+27 more)

### Community 13 - "upload-service.ts"
Cohesion: 0.08
Nodes (28): generateUploadId(), putObject(), releaseUploadStorageReservation(), reserveUploadStorage(), defaultStorageQuotaGateway, deleteRegisteredUpload(), deleteUploadedObject(), drainMultipartFile() (+20 more)

### Community 14 - "tui.rs"
Cohesion: 0.08
Nodes (42): apply_update_event(), ConnectionState, ctrl_or_shift_enter_inserts_a_newline_without_publishing(), ctrl_u_requests_an_available_update_from_every_screen(), days_from_civil(), direct_entry_seeds_pin_and_authoritative_feedback(), DropOrigin, enter_publishes_and_clears_the_composer() (+34 more)

### Community 15 - "download-service.ts"
Cohesion: 0.33
Nodes (9): DownloadDeps, handleDownload(), computeExpiresAt(), computeSignedUrlExpirySeconds(), isExpired(), signedDownloadUrl(), findActiveByShortId(), incrementDownloadCount() (+1 more)

### Community 16 - "Desktop Manifest Metadata"
Cohesion: 0.10
Nodes (20): bar-widget, author, barWidget, allowMultiple, category, defaults, defaultSection, description (+12 more)

### Community 17 - "release.ts"
Cohesion: 0.15
Nodes (24): createTauriUpdateManifest(), main(), TauriUpdateManifest, TauriUpdatePlatform, updaterAssets(), assertReleasePlatform(), configureUpdaterSigning(), currentVersion() (+16 more)

### Community 18 - "Development Dependencies"
Cohesion: 0.11
Nodes (19): drizzle-kit, devDependencies, drizzle-kit, tailwindcss, @tailwindcss/cli, @tauri-apps/cli, @types/bun, @types/react (+11 more)

### Community 19 - "Linux Installer Core"
Cohesion: 0.30
Nodes (15): check_runtime_deps(), detect_environment(), ensure_tmp_dir(), fail(), info(), install_bar_integration(), install_binary(), install_integration_assets() (+7 more)

### Community 20 - "tauri.conf.json"
Cohesion: 0.10
Nodes (20): https://quickdrop.eaedave.xyz/desktop/update/latest.json, app, macOSPrivateApi, windows, build, beforeBuildCommand, beforeDevCommand, devUrl (+12 more)

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

### Community 27 - "App"
Cohesion: 0.17
Nodes (26): Action, App, cancel_composer(), confirm_delete(), copy_selected(), ctrl_p_requests_a_pin_before_creating_a_protected_room(), ctrl_p_with_empty_code_enters_protected_create_then_asks_for_pin(), handle_key() (+18 more)

### Community 28 - "index.ts"
Cohesion: 0.11
Nodes (39): DesktopUpdatePlatform, escapeRegExp(), handleDesktopUpdateDownload(), handleDesktopUpdateManifestDownload(), isDesktopUpdatePlatform(), PLATFORM_ASSET_NAMES, fetchRelease(), fetchReleaseAsset() (+31 more)

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

### Community 35 - "Package Metadata"
Cohesion: 0.50
Nodes (3): name, private, type

### Community 36 - "Desktop Installer Service"
Cohesion: 0.50
Nodes (3): installer, qdReleaseBinary, releaseBinary

### Community 37 - "Linux Release Packaging"
Cohesion: 0.50
Nodes (3): assets, qdChecksum, { version }

### Community 55 - ".replace_drops"
Cohesion: 0.15
Nodes (21): apply_network_event(), ctrl_o_leaves_the_current_room_without_quitting(), drop(), e_edits_the_selected_drop_and_restores_the_composer_draft(), keeps_newest_drops_first_and_selection_valid(), mouse_event(), mouse_hover_visually_tracks_every_interactive_region(), mouse_selects_drops_focuses_composer_and_runs_visible_actions() (+13 more)

### Community 56 - ".new"
Cohesion: 0.29
Nodes (16): ActionRegion, centered_rect(), MouseAction, register_centered_actions(), render_action_footer(), render_centered_actions(), render_code(), render_confirmation() (+8 more)

### Community 57 - "App<'a>"
Cohesion: 0.21
Nodes (5): App<'a>, entry_feedback_expires_without_clearing_newer_status(), normalize_code(), PinPurpose, Instant

### Community 58 - "InMemoryTextRoomsRepository"
Cohesion: 0.35
Nodes (3): TextRoomRow, copyRoom(), InMemoryTextRoomsRepository

### Community 59 - "bundle"
Cohesion: 0.15
Nodes (12): dmg, icons/icon.icns, icons/icon.png, bundle, active, category, icon, macOS (+4 more)

### Community 60 - "TerminalGuard"
Cohesion: 0.20
Nodes (9): keyboard_enhancement_is_optional(), Drop, Self, terminal_error(), TerminalGuard, CrosstermBackend, Error, Stdout (+1 more)

### Community 61 - "index.test.ts"
Cohesion: 0.50
Nodes (3): envKeys, previousEnv, testEnv

### Community 62 - "config.ts"
Cohesion: 0.22
Nodes (14): cleanupExpiredUploads(), startCleanupJob(), AppConfig, loadConfig(), readBoolean(), readOptional(), readPositiveInteger(), readRequired() (+6 more)

### Community 63 - "InMemoryTextDropsRepository"
Cohesion: 0.13
Nodes (11): ClearTextDropsResult, CreateTextDropInput, CreateTextDropResult, DeleteTextDropResult, TextDropRow, TextDropsRepository, UpdateTextDropInput, UpdateTextDropResult (+3 more)

### Community 64 - "text-drops-repository.ts"
Cohesion: 0.28
Nodes (14): textRooms, clearDrops(), createDrop(), deleteDrop(), findExpiredDrops(), listActiveDrops(), lockRoom(), markDropsDeleted() (+6 more)

### Community 67 - "text-rooms-repository.ts"
Cohesion: 0.22
Nodes (8): TextRoomRecord, activeRoomFilter(), createTextRoomWithinLimit(), findExpiredTextRooms(), findTextRoomByCode(), TextRoomsRepository, toTextRoomRow(), updateTextRoomText()

## Knowledge Gaps
- **260 isolated node(s):** `TauriUpdatePlatform`, `TauriUpdateManifest`, `VERSION_FILES`, `ReleaseKind`, `ReleaseAsset` (+255 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **23 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Build Configuration` to `storage-quota.ts`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Why does `QdError` connect `QdError` to `App`, `TerminalGuard`, `tui.rs`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `render_timeline()` connect `.new` to `App<'a>`, `App`, `tui.rs`, `.replace_drops`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **What connects `TauriUpdatePlatform`, `TauriUpdateManifest`, `VERSION_FILES` to the rest of the system?**
  _260 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.05536942338211955 - nodes in this community are weakly interconnected._
- **Should `QdError` be split into smaller, more focused modules?**
  _Cohesion score 0.05621351125938282 - nodes in this community are weakly interconnected._
- **Should `text-session-service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06892010535557506 - nodes in this community are weakly interconnected._