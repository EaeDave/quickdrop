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
RUN_MIGRATIONS_ON_START=true
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

### Deploy Coolify / Dockerfile

O `Dockerfile` publica somente o backend HTTP. No Coolify, use build por Dockerfile, exponha a porta `3000` ou a porta injetada em `PORT`, e configure estas variáveis no app:

```env
PORT=3000
DATABASE_URL=postgres://...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=quickdrop
PUBLIC_BASE_URL=https://files.seu-dominio.com
FILE_EXPIRATION_HOURS=24
MAX_FILE_SIZE_MB=500
RUN_MIGRATIONS_ON_START=true
```

`PUBLIC_BASE_URL` deve ser o domínio público do backend no Coolify, não o bucket R2 direto. A URL copiada pelo desktop será `${PUBLIC_BASE_URL}/f/:shortId`, e esse endpoint redireciona para uma URL assinada temporária do R2.

Na inicialização, o container executa `bun run db:migrate` antes de `bun run server:start`. Se quiser rodar migrações fora do container, defina `RUN_MIGRATIONS_ON_START=false`. Health check: `/api/health`.

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

Instalar binário e integrar com Waybar:

```bash
bun run desktop:install
test -x "$HOME/.local/bin/quickdrop"
test -x "$HOME/.local/bin/quickdrop-waybar"
```

`desktop:install` copia o binário, instala o launcher `quickdrop-waybar`, atualiza `~/.config/waybar/config.jsonc`, cria backup `config.jsonc.bak.quickdrop.*` e reinicia a Waybar quando `omarchy` está disponível. Para reaplicar só o módulo Waybar:

```bash
bun run waybar:install
```

Snippet manual equivalente:

```json
"custom/quickdrop": {
  "format": "󰇚",
  "tooltip": true,
  "tooltip-format": "QuickDrop\nArraste um arquivo para enviar",
  "on-click": "/home/<user>/.local/bin/quickdrop-waybar"
}
```

Inclua `"custom/quickdrop"` em `modules-right` ou no bloco da Waybar onde o ícone deve aparecer.

### Verificação

```bash
bun run typecheck
bun test
bun run desktop:build:web
bun run desktop:build
```

O teste de upload/download de ponta a ponta exige PostgreSQL e R2 reais configurados no `.env`.
<!-- business-readme:technical:end -->
