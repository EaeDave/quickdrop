<!-- business-readme:context:start -->
# LLM Context

## Current business rule map

- Regra: 1 arquivo por upload, sem diretórios/múltiplos no MVP. Fonte: UI `src/desktop/App.tsx`; Backend `POST /api/upload` em `src/server/upload-service.ts` valida multipart e limite de arquivos.
- Regra: upload público sem autenticação, rate limit de 20 uploads/hora/IP. Fonte: Endpoint interno `POST /api/upload` registrado em `src/server/index.ts`.
- Regra: limite padrão 500 MB e rejeição de arquivo vazio/multipart inválido. Fonte: `src/server/config.ts`, `src/server/upload-service.ts`, testes `src/server/config.test.ts`.
- Regra: URL pública `${PUBLIC_BASE_URL}/f/:shortId` redireciona para signed URL do R2 e incrementa `download_count`. Fonte: Endpoint interno `GET /f/:shortId` em `src/server/download-service.ts`.
- Regra: expiração padrão de 24h; expirados são removidos do R2 e marcados com `deleted_at`. Fonte: `src/server/expiration.ts`, Job interno `cleanupExpiredUploads` em `src/server/cleanup.ts`, CLI `src/server/cleanup-cli.ts`.
- Regra: desktop copia via `wl-copy`, notifica via `notify-send`, e mantém fallback visual se uma integração local falhar. Fonte: comandos desktop `copy_link`, `notify_success`, `upload_file` em `src-tauri/src/lib.rs` e UI `src/desktop/App.tsx`.

## Technical map for future LLMs

- Backend entrypoint: `src/server/index.ts` (Fastify, multipart, rate-limit, health, upload, download, cleanup startup).
- Persistence: PostgreSQL via Drizzle ORM on `Bun.SQL`; Drizzle Kit config in `drizzle.config.ts`; typed schema in `src/server/schema.ts`; DB helper in `src/server/db.ts`; migration SQL in `migrations/001_create_uploads.sql`.
- Storage: Cloudflare R2 via AWS SDK v3 in `src/server/r2.ts`; object keys from `src/server/ids.ts` as `uploads/YYYY/MM/{uuid}-{sanitizedFilename}`.
- Upload workflow: `src/server/upload-service.ts` streams multipart file to R2 with byte counting, then inserts metadata; short ID retry handles PostgreSQL unique violations without re-uploading R2 object.
- Download workflow: `src/server/download-service.ts` rejects missing/deleted, deletes+marks expired, otherwise signs R2 GET and redirects 302.
- Desktop Rust commands: `src-tauri/src/lib.rs` implements `upload_file`, `copy_link`, `notify_success`; config reads `QUICKDROP_API_BASE_URL` with default `http://127.0.0.1:3000`.
- Desktop UI: `src/desktop/App.tsx` uses Tauri drag-drop events, progress event `upload-progress`, close button and `Esc`; no Vite, Bun HTML import dev server in `src/desktop/dev-server.ts`.
- Commands: `bun run server:dev`, `bun run server:start`, `bun run db:generate`, `bun run db:check`, `bun run db:migrate`, `bun run cleanup:run`, `bun run desktop:dev`, `bun run desktop:build:web`, `bun run desktop:build`, `bun run desktop:install`, `bun run typecheck`, `bun test`.

## Conflicts and unknowns

- End-to-end upload/download requires real Cloudflare R2 credentials and PostgreSQL running; repository defaults do not contain secrets.
- Desktop Wayland flow requires local `wl-copy`, `wl-paste`, `notify-send`, Tauri Linux system dependencies, and a graphical Wayland session.

## History

- 2026-06-22: Implementado MVP descrito em `docs/mvp.md` com base nas convenções de `docs/CLAUDE.md`; fontes inspecionadas/implementadas incluem `package.json`, `tsconfig.json`, `drizzle.config.ts`, `src/server/*`, `src-tauri/*`, `src/desktop/*`, `migrations/001_create_uploads.sql`, `.env.example`, `compose.yml` e README. O usuário esclareceu que o projeto deve usar Drizzle como ORM, então a persistência usa Drizzle ORM sobre `Bun.SQL`.
<!-- business-readme:context:end -->
