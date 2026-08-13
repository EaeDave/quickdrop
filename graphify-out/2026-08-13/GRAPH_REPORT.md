# Graph Report - quickdrop  (2026-08-13)

## Corpus Check
- 104 files · ~53,294 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1119 nodes · 2459 edges · 60 communities (48 shown, 12 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `27ad030e`
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
- text-funnel-metrics.ts
- Project Scripts
- JSONC Bar Patcher
- Runtime Dependencies
- upload-service.ts
- index.ts
- Storage and Downloads
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
- Environment Configuration
- GitHub Release Client
- upload-service.test.ts
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

## God Nodes (most connected - your core abstractions)
1. `QdError` - 49 edges
2. `App` - 41 edges
3. `scripts` - 34 edges
4. `registerTextSessionRoutes()` - 23 edges
5. `handle_key()` - 22 edges
6. `handle_timeline_key()` - 21 edges
7. `run_mouse_action()` - 21 edges
8. `compilerOptions` - 20 edges
9. `buildApp()` - 18 edges
10. `InMemoryTextRoomsRepository` - 18 edges

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

## Communities (60 total, 12 thin omitted)

### Community 0 - "tui.rs"
Cohesion: 0.05
Nodes (111): C, Action, ActionRegion, App, App<'a>, apply_network_event(), apply_update_event(), cancel_composer() (+103 more)

### Community 1 - "lib.rs"
Cohesion: 0.06
Nodes (86): AppHandle, HashMap, Monitor, PhysicalPosition, Position, autostart_configured_marker_lives_in_app_config_dir(), autostart_configured_marker_path(), build_quickdrop_window() (+78 more)

### Community 2 - "QdError"
Cohesion: 0.07
Nodes (77): copy_to_system_clipboard(), endpoint(), http_client(), latest_content(), latest_drop(), main(), open_in_browser(), open_room() (+69 more)

### Community 3 - "text-session-service.ts"
Cohesion: 0.07
Nodes (47): buildR2Key(), generateSessionCode(), isValidCustomSessionCode(), normalizeSessionCode(), sanitizeFilename(), classifyTextDrop(), looksLikeJson(), TextDropContentType (+39 more)

### Community 4 - "Web Clipboard Client"
Cohesion: 0.08
Nodes (51): root, ClientTextMetric, ClientTextMetricErrorCategory, connectRoom(), createJsonRequest(), createRoom(), fetchSnapshot(), formatIdleWindow() (+43 more)

### Community 5 - "InMemoryTextDropsRepository"
Cohesion: 0.22
Nodes (4): TextDropRow, copyDrop(), DelayedListTextDropsRepository, InMemoryTextDropsRepository

### Community 6 - "storage-quota.ts"
Cohesion: 0.11
Nodes (24): Database, SqlClient, generateShortId(), storageQuota, StorageQuotaRecord, StorageReservationRecord, storageReservations, TextDropRecord (+16 more)

### Community 7 - "Build Configuration"
Cohesion: 0.04
Nodes (39): bun, DOM, DOM.Iterable, ESNext, executable(), fakePath(), hasToolchain, installer (+31 more)

### Community 8 - "Tauri Upload Bridge"
Cohesion: 0.10
Nodes (30): App(), copyTextToClipboard(), extractBackendMessage(), formatError(), formatSelectionName(), getFileName(), INSTALL_PLATFORMS, InstallPlatform (+22 more)

### Community 9 - "text-funnel-metrics.ts"
Cohesion: 0.09
Nodes (25): days, since, sql, incrementTextFunnelMetric(), metricDateUtc(), MetricsLogger, normalizeMetric(), retentionCutoffDate() (+17 more)

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
Cohesion: 0.11
Nodes (23): generateUploadId(), putObject(), releaseUploadStorageReservation(), reserveUploadStorage(), defaultStorageQuotaGateway, deleteRegisteredUpload(), deleteUploadedObject(), drainMultipartFile() (+15 more)

### Community 14 - "index.ts"
Cohesion: 0.17
Nodes (22): handleReleaseAssetDownload(), buildApp(), canonicalRoomCodeFromRawUrl(), isSensitiveTextRoute(), redactTextCodeFromUrl(), startServer(), envKeys, previousEnv (+14 more)

### Community 15 - "Storage and Downloads"
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

### Community 27 - "Environment Configuration"
Cohesion: 0.54
Nodes (6): loadConfig(), readBoolean(), readOptional(), readPositiveInteger(), readRequired(), requiredEnv

### Community 28 - "GitHub Release Client"
Cohesion: 0.32
Nodes (7): fetchLatestRelease(), fetchReleaseAsset(), githubHeaders(), GitHubRelease, GitHubReleaseAsset, MISSING_GITHUB_TOKEN_MESSAGE, ReleaseAssetDownloadOptions

### Community 29 - "upload-service.test.ts"
Cohesion: 0.22
Nodes (5): config, injectUpload(), multipartHeaders, multipartPayload, UploadDeps

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
Cohesion: 0.12
Nodes (16): ClearTextDropsResult, CreateTextDropInput, CreateTextDropResult, DeleteTextDropResult, TextDropsRepository, UpdateTextDropInput, UpdateTextDropResult, expectJoined() (+8 more)

### Community 56 - "InMemoryTextRoomsRepository"
Cohesion: 0.20
Nodes (7): CreateTextRoomInput, TextRoomCreationResult, TextRoomRow, TextRoomsRepository, BarrierTextRoomsRepository, copyRoom(), InMemoryTextRoomsRepository

### Community 57 - "text-drops-repository.ts"
Cohesion: 0.26
Nodes (15): db, textRooms, clearDrops(), createDrop(), deleteDrop(), findExpiredDrops(), listActiveDrops(), lockRoom() (+7 more)

### Community 58 - "text-rooms-repository.ts"
Cohesion: 0.27
Nodes (6): activeRoomFilter(), createTextRoomWithinLimit(), findExpiredTextRooms(), findTextRoomByCode(), toTextRoomRow(), updateTextRoomText()

## Knowledge Gaps
- **229 isolated node(s):** `quickdrop-cli`, `databaseUrl`, `uploads`, `storage_quota`, `storage_reservations` (+224 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `App` connect `tui.rs` to `lib.rs`, `QdError`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `QdError` connect `QdError` to `tui.rs`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `build_quickdrop_window()` connect `lib.rs` to `tui.rs`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `quickdrop-cli`, `databaseUrl`, `uploads` to the rest of the system?**
  _229 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `tui.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.0501934770591487 - nodes in this community are weakly interconnected._
- **Should `lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.05765870704717531 - nodes in this community are weakly interconnected._
- **Should `QdError` be split into smaller, more focused modules?**
  _Cohesion score 0.07343660355708548 - nodes in this community are weakly interconnected._