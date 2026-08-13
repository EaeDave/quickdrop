# Graph Report - quickdrop  (2026-08-13)

## Corpus Check
- 104 files · ~53,908 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1131 nodes · 2480 edges · 70 communities (52 shown, 18 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b5d43f71`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- tui.rs
- lib.rs
- QdError
- text-session-service.ts
- Web Clipboard Client
- InMemoryTextDropsRepository
- storage-quota.ts
- Build Configuration
- Tauri Upload Bridge
- index.ts
- Project Scripts
- JSONC Bar Patcher
- Runtime Dependencies
- upload-service.ts
- App
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
- Option
- App<'a>
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
- text-session-service.test.ts
- InMemoryTextRoomsRepository
- text-drops-repository.ts
- text-rooms-repository.ts
- DelayedExpiryTextRoomsRepository
- .new
- TerminalGuard
- .draw
- cleanup.ts
- C
- Client
- TextDrop
- Drop
- Self
- TextDrop

## God Nodes (most connected - your core abstractions)
1. `QdError` - 50 edges
2. `App` - 42 edges
3. `scripts` - 34 edges
4. `registerTextSessionRoutes()` - 23 edges
5. `handle_key()` - 22 edges
6. `handle_timeline_key()` - 21 edges
7. `run_mouse_action()` - 21 edges
8. `compilerOptions` - 20 edges
9. `InMemoryTextRoomsRepository` - 18 edges
10. `buildApp()` - 18 edges

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

## Communities (70 total, 18 thin omitted)

### Community 0 - "tui.rs"
Cohesion: 0.11
Nodes (28): AvailableUpdate, apply_update_event(), ConnectionState, error_message(), expired_access_returns_to_pin_and_reconnect_releases_the_editor(), format_compact_remaining(), format_remaining_clock(), NetEvent (+20 more)

### Community 1 - "lib.rs"
Cohesion: 0.06
Nodes (87): AppHandle, Color, HashMap, Monitor, PhysicalPosition, Position, autostart_configured_marker_lives_in_app_config_dir(), autostart_configured_marker_path() (+79 more)

### Community 2 - "QdError"
Cohesion: 0.07
Nodes (80): copy_to_system_clipboard(), empty_room_does_not_invoke_the_clipboard_writer(), endpoint(), http_client(), latest_content(), latest_drop(), main(), open_in_browser() (+72 more)

### Community 3 - "text-session-service.ts"
Cohesion: 0.07
Nodes (48): buildR2Key(), generateSessionCode(), isValidCustomSessionCode(), normalizeSessionCode(), sanitizeFilename(), classifyTextDrop(), looksLikeJson(), TextDropContentType (+40 more)

### Community 4 - "Web Clipboard Client"
Cohesion: 0.08
Nodes (51): root, ClientTextMetric, ClientTextMetricErrorCategory, connectRoom(), createJsonRequest(), createRoom(), fetchSnapshot(), formatIdleWindow() (+43 more)

### Community 5 - "InMemoryTextDropsRepository"
Cohesion: 0.18
Nodes (6): CreateTextDropInput, CreateTextDropResult, TextDropRow, copyDrop(), DelayedListTextDropsRepository, InMemoryTextDropsRepository

### Community 6 - "storage-quota.ts"
Cohesion: 0.13
Nodes (21): generateShortId(), storageQuota, StorageQuotaRecord, StorageReservationRecord, storageReservations, TextDropRecord, textDrops, TextFunnelMetricRecord (+13 more)

### Community 7 - "Build Configuration"
Cohesion: 0.04
Nodes (39): bun, DOM, DOM.Iterable, ESNext, executable(), fakePath(), hasToolchain, installer (+31 more)

### Community 8 - "Tauri Upload Bridge"
Cohesion: 0.10
Nodes (30): App(), copyTextToClipboard(), extractBackendMessage(), formatError(), formatSelectionName(), getFileName(), INSTALL_PLATFORMS, InstallPlatform (+22 more)

### Community 9 - "index.ts"
Cohesion: 0.06
Nodes (53): days, since, fetchLatestRelease(), fetchReleaseAsset(), githubHeaders(), GitHubRelease, GitHubReleaseAsset, handleReleaseAssetDownload() (+45 more)

### Community 10 - "Project Scripts"
Cohesion: 0.06
Nodes (34): scripts, bar:install, cleanup:run, db:check, db:generate, db:migrate, desktop:build, desktop:build:web (+26 more)

### Community 11 - "JSONC Bar Patcher"
Cohesion: 0.10
Nodes (32): ensure_in_modules_right(), find_matching_brace(), find_matching_delimiter(), find_module_range(), find_modules_right_arrays(), last_significant_end(), line_start(), main() (+24 more)

### Community 12 - "Runtime Dependencies"
Cohesion: 0.06
Nodes (31): @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, drizzle-orm, fastify, @fastify/cors, @fastify/multipart, @fastify/rate-limit, @fastify/static (+23 more)

### Community 13 - "upload-service.ts"
Cohesion: 0.08
Nodes (28): generateUploadId(), putObject(), releaseUploadStorageReservation(), reserveUploadStorage(), defaultStorageQuotaGateway, deleteRegisteredUpload(), deleteUploadedObject(), drainMultipartFile() (+20 more)

### Community 14 - "App"
Cohesion: 0.20
Nodes (24): ActionRegion, App, centered_rect(), Focus, HoverTarget, MouseAction, register_centered_actions(), render() (+16 more)

### Community 15 - "download-service.ts"
Cohesion: 0.36
Nodes (8): DownloadDeps, handleDownload(), computeExpiresAt(), computeSignedUrlExpirySeconds(), isExpired(), deleteObject(), signedDownloadUrl(), incrementDownloadCount()

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
Cohesion: 0.28
Nodes (9): loadConfig(), readBoolean(), readOptional(), readPositiveInteger(), readRequired(), requiredEnv, Database, sql (+1 more)

### Community 28 - "Option"
Cohesion: 0.25
Nodes (18): Action, cancel_composer(), confirm_delete(), copy_selected(), days_from_civil(), format_room_expiry(), handle_mouse(), handle_timeline_key() (+10 more)

### Community 29 - "App<'a>"
Cohesion: 0.24
Nodes (9): TextDrop, App<'a>, apply_network_event(), drop(), e_edits_the_selected_drop_and_restores_the_composer_draft(), keeps_newest_drops_first_and_selection_valid(), remote_additions_preserve_selection_and_clear_events_empty_the_timeline(), sort_drops() (+1 more)

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

### Community 55 - "text-session-service.test.ts"
Cohesion: 0.15
Nodes (13): ClearTextDropsResult, DeleteTextDropResult, TextDropsRepository, UpdateTextDropInput, UpdateTextDropResult, expectJoined(), MutableClock, nextMessage() (+5 more)

### Community 56 - "InMemoryTextRoomsRepository"
Cohesion: 0.24
Nodes (6): CreateTextRoomInput, TextRoomCreationResult, TextRoomRow, BarrierTextRoomsRepository, copyRoom(), InMemoryTextRoomsRepository

### Community 57 - "text-drops-repository.ts"
Cohesion: 0.26
Nodes (15): db, textRooms, clearDrops(), createDrop(), deleteDrop(), findExpiredDrops(), listActiveDrops(), lockRoom() (+7 more)

### Community 58 - "text-rooms-repository.ts"
Cohesion: 0.22
Nodes (8): TextRoomRecord, activeRoomFilter(), createTextRoomWithinLimit(), findExpiredTextRooms(), findTextRoomByCode(), TextRoomsRepository, toTextRoomRow(), updateTextRoomText()

### Community 60 - ".new"
Cohesion: 0.16
Nodes (16): ctrl_o_leaves_the_current_room_without_quitting(), ctrl_or_shift_enter_inserts_a_newline_without_publishing(), ctrl_p_requests_a_pin_before_creating_a_protected_room(), ctrl_p_with_empty_code_enters_protected_create_then_asks_for_pin(), ctrl_u_requests_an_available_update_from_every_screen(), enter_publishes_and_clears_the_composer(), handle_key(), mouse_clear_and_cancel_report_immediate_feedback() (+8 more)

### Community 61 - "TerminalGuard"
Cohesion: 0.20
Nodes (9): keyboard_enhancement_is_optional(), terminal_error(), TerminalGuard, CrosstermBackend, Drop, Error, Self, Stdout (+1 more)

### Community 62 - ".draw"
Cohesion: 0.24
Nodes (9): mouse_event(), mouse_hover_visually_tracks_every_interactive_region(), mouse_selects_drops_focuses_composer_and_runs_visible_actions(), overlays_do_not_hover_inactive_timeline_regions(), renders_regular_and_compact_timelines(), CompletedFrame, F, MouseEvent (+1 more)

### Community 63 - "cleanup.ts"
Cohesion: 0.36
Nodes (7): cleanupExpiredUploads(), startCleanupJob(), AppConfig, createR2Client(), config, releaseExpiredStorageReservations(), markDeleted()

## Knowledge Gaps
- **229 isolated node(s):** `quickdrop-cli`, `SpooledUpload`, `StorageQuotaGateway`, `UploadedObject`, `UploadResponse` (+224 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `App` connect `App` to `tui.rs`, `lib.rs`, `.new`, `Option`, `App<'a>`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `QdError` connect `QdError` to `tui.rs`, `Option`, `TerminalGuard`, `.new`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `bun` connect `Build Configuration` to `config.ts`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `quickdrop-cli`, `SpooledUpload`, `StorageQuotaGateway` to the rest of the system?**
  _229 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `tui.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.10873440285204991 - nodes in this community are weakly interconnected._
- **Should `lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.05672948791166952 - nodes in this community are weakly interconnected._
- **Should `QdError` be split into smaller, more focused modules?**
  _Cohesion score 0.07105538140020899 - nodes in this community are weakly interconnected._