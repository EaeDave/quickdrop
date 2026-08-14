# Graph Report - quickdrop  (2026-08-14)

## Corpus Check
- 103 files · ~57,211 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1171 nodes · 2576 edges · 63 communities (45 shown, 18 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c336463f`
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
- Tauri Application Config
- System Architecture
- Windows Bundle Config
- Linux Bar Integration
- Windows Installer Logic
- Tauri Permissions
- QuickDrop Window Launcher
- config.ts
- index.ts
- package-macos-qd-release.ts
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
- C
- T
- TextDrop
- text-rooms-repository.ts
- OsString
- Path
- PathBuf
- Self

## God Nodes (most connected - your core abstractions)
1. `QdError` - 58 edges
2. `App` - 42 edges
3. `scripts` - 36 edges
4. `registerTextSessionRoutes()` - 23 edges
5. `handle_key()` - 22 edges
6. `buildApp()` - 21 edges
7. `handle_timeline_key()` - 21 edges
8. `run_mouse_action()` - 21 edges
9. `compilerOptions` - 20 edges
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

## Communities (63 total, 18 thin omitted)

### Community 0 - "install-macos.sh"
Cohesion: 0.53
Nodes (4): fail(), info(), install-macos.sh script, warn()

### Community 1 - "lib.rs"
Cohesion: 0.06
Nodes (87): AppHandle, Color, HashMap, Monitor, PhysicalPosition, Position, autostart_configured_marker_lives_in_app_config_dir(), autostart_configured_marker_path() (+79 more)

### Community 2 - "QdError"
Cohesion: 0.06
Nodes (99): C, access_existing_room(), add_missing_pin_guidance(), copy_to_system_clipboard(), empty_room_does_not_invoke_the_clipboard_writer(), endpoint(), http_client(), latest_content() (+91 more)

### Community 3 - "text-session-service.ts"
Cohesion: 0.06
Nodes (52): buildR2Key(), generateSessionCode(), isValidCustomSessionCode(), normalizeSessionCode(), sanitizeFilename(), classifyTextDrop(), looksLikeJson(), TextDropContentType (+44 more)

### Community 4 - "text-client.ts"
Cohesion: 0.08
Nodes (51): root, ClientTextMetric, ClientTextMetricErrorCategory, connectRoom(), createJsonRequest(), createRoom(), fetchSnapshot(), formatIdleWindow() (+43 more)

### Community 5 - "text-session-service.test.ts"
Cohesion: 0.05
Nodes (40): clearDrops(), ClearTextDropsResult, createDrop(), CreateTextDropInput, CreateTextDropResult, deleteDrop(), DeleteTextDropResult, findExpiredDrops() (+32 more)

### Community 6 - "storage-quota.ts"
Cohesion: 0.13
Nodes (20): generateShortId(), storageQuota, StorageQuotaRecord, StorageReservationRecord, storageReservations, TextDropRecord, textDrops, TextFunnelMetricRecord (+12 more)

### Community 7 - "Build Configuration"
Cohesion: 0.04
Nodes (39): bun, DOM, DOM.Iterable, ESNext, executable(), fakePath(), hasToolchain, installer (+31 more)

### Community 8 - "App.tsx"
Cohesion: 0.10
Nodes (30): App(), copyTextToClipboard(), extractBackendMessage(), formatError(), formatSelectionName(), getFileName(), INSTALL_PLATFORMS, InstallPlatform (+22 more)

### Community 9 - "text-funnel-metrics.ts"
Cohesion: 0.09
Nodes (24): days, since, sql, incrementTextFunnelMetric(), metricDateUtc(), MetricsLogger, normalizeMetric(), retentionCutoffDate() (+16 more)

### Community 10 - "scripts"
Cohesion: 0.06
Nodes (36): scripts, bar:install, cleanup:run, db:check, db:generate, db:migrate, desktop:build, desktop:build:web (+28 more)

### Community 11 - "JSONC Bar Patcher"
Cohesion: 0.10
Nodes (32): ensure_in_modules_right(), find_matching_brace(), find_matching_delimiter(), find_module_range(), find_modules_right_arrays(), last_significant_end(), line_start(), main() (+24 more)

### Community 12 - "dependencies"
Cohesion: 0.06
Nodes (31): @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, drizzle-orm, fastify, @fastify/cors, @fastify/multipart, @fastify/rate-limit, @fastify/static (+23 more)

### Community 13 - "upload-service.ts"
Cohesion: 0.08
Nodes (28): generateUploadId(), putObject(), releaseUploadStorageReservation(), reserveUploadStorage(), defaultStorageQuotaGateway, deleteRegisteredUpload(), deleteUploadedObject(), drainMultipartFile() (+20 more)

### Community 14 - "tui.rs"
Cohesion: 0.05
Nodes (112): Action, ActionRegion, App, App<'a>, apply_network_event(), apply_update_event(), cancel_composer(), centered_rect() (+104 more)

### Community 15 - "download-service.ts"
Cohesion: 0.18
Nodes (17): cleanupExpiredUploads(), startCleanupJob(), AppConfig, DownloadDeps, handleDownload(), computeExpiresAt(), computeSignedUrlExpirySeconds(), isExpired() (+9 more)

### Community 16 - "Desktop Manifest Metadata"
Cohesion: 0.10
Nodes (20): bar-widget, author, barWidget, allowMultiple, category, defaults, defaultSection, description (+12 more)

### Community 17 - "release.ts"
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
Cohesion: 0.54
Nodes (6): loadConfig(), readBoolean(), readOptional(), readPositiveInteger(), readRequired(), requiredEnv

### Community 28 - "index.ts"
Cohesion: 0.12
Nodes (32): fetchLatestRelease(), fetchReleaseAsset(), githubHeaders(), GitHubRelease, GitHubReleaseAsset, handleReleaseAssetDownload(), MISSING_GITHUB_TOKEN_MESSAGE, ReleaseAssetDownloadOptions (+24 more)

### Community 29 - "package-macos-qd-release.ts"
Cohesion: 0.50
Nodes (3): architectures, releaseDirectory, { version }

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

### Community 58 - "text-rooms-repository.ts"
Cohesion: 0.18
Nodes (11): Database, db, SqlClient, textRooms, createdRoomIds, activeRoomFilter(), createTextRoomWithinLimit(), findExpiredTextRooms() (+3 more)

## Knowledge Gaps
- **234 isolated node(s):** `name`, `type`, `private`, `server:dev`, `server:start` (+229 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `App` connect `tui.rs` to `lib.rs`, `QdError`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `bun` connect `Build Configuration` to `text-rooms-repository.ts`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `QdError` connect `QdError` to `tui.rs`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **What connects `name`, `type`, `private` to the rest of the system?**
  _234 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `lib.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.05672948791166952 - nodes in this community are weakly interconnected._
- **Should `QdError` be split into smaller, more focused modules?**
  _Cohesion score 0.057254502208630646 - nodes in this community are weakly interconnected._
- **Should `text-session-service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0647887323943662 - nodes in this community are weakly interconnected._