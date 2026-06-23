# QuickDrop

<!-- business-readme:business-rules:start -->
## Regras de negócio

 - QuickDrop é um app de envio de arquivos com interface desktop Linux/Wayland (aberta pela Waybar) e uma interface web minimalista correspondente, servida diretamente na raiz do servidor (`GET /`). Fonte: UI `src/desktop/App.tsx`, comandos Tauri `src-tauri/src/lib.rs` e `@fastify/static` em `src/server/index.ts`.
 - Tanto o cliente desktop quanto o cliente web aceitam 1 ou vários arquivos por ação (drag-and-drop ou clique para selecionar). Com múltiplos arquivos, a compactação ZIP é feita no lado do cliente (no Rust/Tauri para o desktop; usando a biblioteca `fflate` no navegador para o cliente web) antes do envio, gerando apenas 1 link público. Fonte: `src/desktop/App.tsx`, `src/desktop/tauri.ts` e `upload_files` no Rust.
- O backend aceita 1 arquivo por requisição multipart, de qualquer tipo, e valida multipart, arquivo vazio e tamanho máximo. Para múltiplos arquivos, esse arquivo é o ZIP gerado pelo desktop; o limite padrão de 500 MB se aplica ao pacote final e pode ser alterado por `MAX_FILE_SIZE_MB`. Fonte: Endpoint interno `POST /api/upload` em `src/server/upload-service.ts`.
- Uploads são públicos e não exigem autenticação no MVP. Há limite de 20 uploads por hora por IP. Fonte: Endpoint interno `POST /api/upload` em `src/server/index.ts`.
- Upload válido é enviado ao Cloudflare R2, registrado no PostgreSQL e retorna `{ id, url, expiresAt }`. A URL pública tem formato `${PUBLIC_BASE_URL}/f/:shortId`. Fonte: Endpoint interno `POST /api/upload` e tabela `uploads`.
- Links públicos são acessíveis sem autenticação. `GET /f/:shortId` busca o registro, verifica expiração, incrementa `download_count` e redireciona para uma URL assinada temporária do R2. Fonte: Endpoint interno `GET /f/:shortId` em `src/server/download-service.ts`.
- Arquivos expiram por padrão após 24 horas, configurável por `FILE_EXPIRATION_HOURS`. Upload expirado é removido do R2 e marcado com `deleted_at`; depois disso o link retorna expirado ou não encontrado. Fonte: Job interno `cleanupExpiredUploads` e Endpoint interno `GET /f/:shortId`.
- Ao concluir o upload no desktop, o app copia o link único via `wl-copy` e chama `notify-send`. Se a cópia falhar, a UI mostra o link para cópia manual; se a notificação falhar, o upload continua como sucesso com aviso. Fonte: comandos desktop `copy_link` e `notify_success`.
- A janela do MVP tem 500x300, exibe progresso, estados de sucesso/erro e pode ser fechada pelo botão visível ou pela tecla `Esc`. Fonte: configuração Tauri `src-tauri/tauri.conf.json` e UI `src/desktop/App.tsx`.
<!-- business-readme:business-rules:end -->

<!-- business-readme:technical:start -->
## Guia técnico

### Requisitos

- Bun 1.3+
- Docker/Compose para PostgreSQL local e backend local opcional
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
QUICKDROP_LOCAL_PUBLIC_BASE_URL=http://127.0.0.1:3000
FILE_EXPIRATION_HOURS=24
MAX_FILE_SIZE_MB=500
QUICKDROP_API_BASE_URL=http://127.0.0.1:3000
RUN_MIGRATIONS_ON_START=true
```

Preencha `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` e `PUBLIC_BASE_URL` antes de iniciar um backend real. Para uso diário na máquina local, o modo recomendado é deixar a Waybar apontando para o backend remoto `https://quickdrop.eaedave.xyz`; assim o QuickDrop continua funcionando após reiniciar o computador sem depender de um processo local.

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

### Backend local opcional com Docker

O `compose.yml` também tem um serviço `server` opcional para rodar o backend localmente. Ele usa o mesmo `Dockerfile`, expõe `127.0.0.1:3000`, depende do Postgres do Compose e usa `restart: unless-stopped` para subir de novo junto com o Docker após reboot.

```bash
bun run local:server:up
curl -sS http://127.0.0.1:3000/api/health
```

Para instalar o desktop e trocar a Waybar para esse backend local em um comando:

```bash
bun run quickdrop:install:local
```

Para voltar a usar o backend remoto depois:

```bash
QUICKDROP_API_BASE_URL=https://quickdrop.eaedave.xyz bun run waybar:install
```

Logs/parada:

```bash
bun run local:server:logs
bun run local:server:stop
```

Limpeza manual de expirados:

```bash
bun run cleanup:run
```

### Desktop

```bash
bun run desktop:dev
```

Na janela desktop, o usuário pode arrastar 1 ou vários arquivos para a caixa ou clicar na seta para abrir o gerenciador de arquivos e escolher vários arquivos locais. Múltiplos arquivos são compactados em um ZIP temporário antes do envio e geram um único link.

Build web/Tauri:

```bash
bun run desktop:build:web
bun run desktop:build
```

Instalar binário e integrar com Waybar usando o backend remoto persistente:

```bash
bun run quickdrop:install
test -x "$HOME/.local/bin/quickdrop"
test -x "$HOME/.local/bin/quickdrop-waybar"
```

`quickdrop:install` instala dependências, compila o desktop, copia o binário, instala o launcher `quickdrop-waybar`, atualiza `~/.config/waybar/config.jsonc`, cria backup `config.jsonc.bak.quickdrop.*` e reinicia a Waybar quando `omarchy` está disponível. Por padrão, o módulo Waybar instalado usa `QUICKDROP_API_BASE_URL=https://quickdrop.eaedave.xyz`, então continua funcional após reboot enquanto o backend remoto estiver online. Para reaplicar só o módulo Waybar:

```bash
bun run waybar:install
```

Snippet manual equivalente:

```json
"custom/quickdrop": {
  "format": "󰇚",
  "tooltip": true,
  "tooltip-format": "QuickDrop\nArraste arquivos para enviar",
  "on-click": "env QUICKDROP_API_BASE_URL=https://quickdrop.eaedave.xyz /home/<user>/.local/bin/quickdrop-waybar"
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
