# QuickDrop

<!-- business-readme:business-rules:start -->
## Regras de negócio

- QuickDrop é um app desktop Linux/Wayland aberto pela Waybar para enviar arquivos rapidamente por drag-and-drop. Fonte: UI desktop `src/desktop/App.tsx` e comandos Tauri `src-tauri/src/lib.rs`.
- Cada upload aceita exatamente 1 arquivo. Se o usuário soltar mais de um arquivo, a UI mostra `Envie apenas um arquivo por vez.` e não chama o backend. Fonte: app desktop `src/desktop/App.tsx`.
- O backend aceita qualquer tipo de arquivo, mas valida multipart, arquivo vazio e tamanho máximo. O limite padrão é 500 MB e pode ser alterado por `MAX_FILE_SIZE_MB`. Fonte: Endpoint interno `POST /api/upload` em `src/server/upload-service.ts`.
- Uploads são públicos e não exigem autenticação no MVP. Há limite de 20 uploads por hora por IP. Fonte: Endpoint interno `POST /api/upload` em `src/server/index.ts`.
- Upload válido é enviado ao Cloudflare R2, registrado no PostgreSQL e retorna `{ id, url, expiresAt }`. A URL pública tem formato `${PUBLIC_BASE_URL}/f/:shortId`. Fonte: Endpoint interno `POST /api/upload` e tabela `uploads`.
- Links públicos são acessíveis sem autenticação. `GET /f/:shortId` busca o registro, verifica expiração, incrementa `download_count` e redireciona para uma URL assinada temporária do R2. Fonte: Endpoint interno `GET /f/:shortId` em `src/server/download-service.ts`.
- Arquivos expiram por padrão após 24 horas, configurável por `FILE_EXPIRATION_HOURS`. Upload expirado é removido do R2 e marcado com `deleted_at`; depois disso o link retorna expirado ou não encontrado. Fonte: Job interno `cleanupExpiredUploads` e Endpoint interno `GET /f/:shortId`.
- Ao concluir o upload no desktop, o app copia o link via `wl-copy` e chama `notify-send` com `Upload concluído. Link copiado para a área de transferência.`. Se a cópia falhar, a UI mostra o link para cópia manual; se a notificação falhar, o upload continua como sucesso com aviso. Fonte: comandos desktop `copy_link` e `notify_success`.
- A janela do MVP tem 500x300, exibe progresso, estados de sucesso/erro e pode ser fechada pelo botão visível ou pela tecla `Esc`. Fonte: configuração Tauri `src-tauri/tauri.conf.json` e UI `src/desktop/App.tsx`.
<!-- business-readme:business-rules:end -->

<!-- business-readme:technical:start -->
## Guia técnico

### Requisitos

- Bun 1.3+
- Docker/Compose para PostgreSQL local
- Rust e dependências Linux do Tauri v2
- `wl-copy`, `wl-paste` e `notify-send` para o fluxo desktop Wayland
- Credenciais Cloudflare R2 reais para uploads de ponta a ponta

### Configuração

```bash
bun install
cp .env.example .env
docker compose up -d db
```

Variáveis principais:

```env
PORT=3000
DATABASE_URL=postgres://quickdrop:quickdrop@127.0.0.1:5432/quickdrop
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=quickdrop
PUBLIC_BASE_URL=https://files.example.com
FILE_EXPIRATION_HOURS=24
MAX_FILE_SIZE_MB=500
QUICKDROP_API_BASE_URL=http://127.0.0.1:3000
```

Preencha `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` e `PUBLIC_BASE_URL` antes de iniciar o backend real.

### Banco de dados

O projeto usa PostgreSQL com Drizzle ORM sobre `Bun.SQL`. A configuração do Drizzle Kit fica em `drizzle.config.ts`, o schema tipado em `src/server/schema.ts`, e a migração SQL versionada em `migrations/`.

```bash
bun run db:generate
bun run db:check
bun run db:migrate
```

### Backend

```bash
bun run server:dev
# ou
bun run server:start
```

Health check:

```bash
curl -sS http://127.0.0.1:3000/api/health
```

Limpeza manual de expirados:

```bash
bun run cleanup:run
```

### Desktop

```bash
bun run desktop:dev
```

Build web/Tauri:

```bash
bun run desktop:build:web
bun run desktop:build
```

Instalar comando usado pela Waybar:

```bash
bun run desktop:install
test -x "$HOME/.local/bin/quickdrop"
```

`quickdrop` só resolve na Waybar se `~/.local/bin` estiver no `PATH`; caso contrário, use `/home/<user>/.local/bin/quickdrop` em `on-click`.

Módulo Waybar:

```json
"custom/quickdrop": {
  "format": "󰇚",
  "tooltip": "QuickDrop",
  "on-click": "quickdrop"
}
```

### Verificação

```bash
bun run typecheck
bun test
bun run desktop:build:web
bun run desktop:build
```

O teste de upload/download de ponta a ponta exige PostgreSQL e R2 reais configurados no `.env`.
<!-- business-readme:technical:end -->
