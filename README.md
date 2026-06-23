# QuickDrop

<!-- business-readme:business-rules:start -->
## Regras de negócio

 - QuickDrop é um app de envio de arquivos com interface desktop Linux/Wayland (aberta pela Waybar), cliente Windows com ícone residente na system tray e uma interface web minimalista correspondente, servida diretamente na raiz do servidor (`GET /`). Fonte: UI `src/desktop/App.tsx`, comandos Tauri `src-tauri/src/lib.rs`, config Windows `src-tauri/tauri.windows.conf.json` e `@fastify/static` em `src/server/index.ts`.
- No Windows, o executável empacotado usa `https://quickdrop.eaedave.xyz` como backend padrão quando `QUICKDROP_API_BASE_URL` não está definido; no Linux/Wayland, o launcher da Waybar injeta esse mesmo backend remoto por padrão. Fonte: `DesktopConfig::from_env` em `src-tauri/src/lib.rs` e `scripts/quickdrop-waybar`.
- Tanto o cliente desktop quanto o cliente web aceitam 1 ou vários arquivos por ação (drag-and-drop, clique para selecionar ou `Ctrl+V`). Com múltiplos arquivos, a compactação ZIP é feita no lado do cliente (no Rust/Tauri para caminhos locais; usando `fflate` no navegador/clipboard para arquivos em memória) antes do envio, gerando apenas 1 link público. Fonte: `src/desktop/App.tsx`, `src/desktop/tauri.ts` e `upload_files` no Rust.
- Ao colar com `Ctrl+V`, imagens/arquivos do clipboard são enviados como arquivo normal; texto do clipboard vira automaticamente `quickdrop-paste.txt` (`text/plain`) antes do upload. No desktop Wayland, o atalho usa `wl-paste` nativo para contornar limitações do paste event do WebView com imagens; no Windows, o paste event padrão do WebView2 é usado. Fonte: `src/desktop/App.tsx` e `src-tauri/src/lib.rs`.
- O backend aceita 1 arquivo por requisição multipart, de qualquer tipo, e valida multipart, arquivo vazio e tamanho máximo. Para múltiplos arquivos, esse arquivo é o ZIP gerado pelo desktop; o limite padrão de 500 MB se aplica ao pacote final e pode ser alterado por `MAX_FILE_SIZE_MB`. Fonte: Endpoint interno `POST /api/upload` em `src/server/upload-service.ts`.
- Uploads são públicos e não exigem autenticação no MVP. Há limite de 20 uploads por hora por IP. Fonte: Endpoint interno `POST /api/upload` em `src/server/index.ts`.
- Upload válido é enviado ao Cloudflare R2, registrado no PostgreSQL e retorna `{ id, url, expiresAt }`. A URL pública tem formato `${PUBLIC_BASE_URL}/f/:shortId`. Fonte: Endpoint interno `POST /api/upload` e tabela `uploads`.
- Links públicos são acessíveis sem autenticação. `GET /f/:shortId` busca o registro, verifica expiração, incrementa `download_count` e redireciona para uma URL assinada temporária do R2. Fonte: Endpoint interno `GET /f/:shortId` em `src/server/download-service.ts`.
- Arquivos expiram por padrão após 24 horas, configurável por `FILE_EXPIRATION_HOURS`. Upload expirado é removido do R2 e marcado com `deleted_at`; depois disso o link retorna expirado ou não encontrado. Fonte: Job interno `cleanupExpiredUploads` e Endpoint interno `GET /f/:shortId`.
- Ao concluir o upload no desktop, o app copia o link único e exibe notificação de sucesso. No Linux/Wayland usa `wl-copy` e `notify-send`; no Windows usa os plugins nativos de clipboard e notification do Tauri. Se a cópia falhar, a UI mostra o link para cópia manual; se a notificação falhar, o upload continua como sucesso com aviso. Fonte: comandos desktop `copy_link` e `notify_success`.
- A janela do MVP tem 500x300, exibe progresso, estados de sucesso/erro e pode ser fechada pelo botão visível ou pela tecla `Esc`. No Linux/Wayland, fechar encerra a janela como antes; no Windows, fechar oculta a janela, mantém o app vivo na tray até o usuário escolher `Sair`, abre posicionada acima da área da tray e pode ser arrastada pela barra superior customizada. No primeiro start no Windows, o app ativa `Iniciar com Windows` automaticamente e grava um marcador local; se o usuário desativar o autostart no menu da tray, o app não reativa sozinho em starts futuros. Fonte: configuração Tauri `src-tauri/tauri.conf.json`, tray/posicionamento/autostart em `src-tauri/src/lib.rs` e UI `src/desktop/App.tsx`.
- A instalação Windows por PowerShell é pública no endpoint `GET /install.ps1`; o `.exe` é baixado pelo endpoint interno `GET /windows/latest.exe`, que usa um token GitHub configurado somente no servidor para buscar o asset privado `QuickDrop_*_x64-setup.exe` da última release sem expor credenciais ao usuário final. Fonte: `scripts/install-windows.ps1`, `src/server/index.ts` e `src/server/windows-installer-service.ts`.
<!-- business-readme:business-rules:end -->

<!-- business-readme:technical:start -->
## Guia técnico

### Requisitos

- Bun 1.3+
- Docker/Compose para PostgreSQL local e backend local opcional
- Rust e dependências Linux do Tauri v2
- `wl-copy`, `wl-paste` e `notify-send` para o fluxo desktop Wayland
- Windows 10/11 com WebView2 Runtime para o cliente Tauri/tray
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
QUICKDROP_GITHUB_TOKEN=
QUICKDROP_GITHUB_REPOSITORY=EaeDave/quickdrop
```

Preencha `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` e `PUBLIC_BASE_URL` antes de iniciar um backend real. Para uso diário na máquina local, o modo recomendado é deixar a Waybar apontando para o backend remoto `https://quickdrop.eaedave.xyz`; assim o QuickDrop continua funcionando após reiniciar o computador sem depender de um processo local.

O backend aceita preflight CORS para o cliente desktop Tauri/WebView enviar arquivos em memória ao backend remoto, incluindo o header `x-quickdrop-file-size` usado para R2/Cloudflare receber `Content-Length` correto.

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
QUICKDROP_GITHUB_TOKEN=github_pat_...
QUICKDROP_GITHUB_REPOSITORY=EaeDave/quickdrop
```

`PUBLIC_BASE_URL` deve ser o domínio público do backend no Coolify, não o bucket R2 direto. A URL copiada pelo desktop será `${PUBLIC_BASE_URL}/f/:shortId`, e esse endpoint redireciona para uma URL assinada temporária do R2. Para o instalador Windows funcionar com o repositório GitHub privado, configure `QUICKDROP_GITHUB_TOKEN` no ambiente do servidor com permissão de leitura do repositório; `GITHUB_TOKEN` também é aceito como fallback, mas não deve ser embutido no script público.

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

Na janela desktop ou web, o usuário pode arrastar 1 ou vários arquivos para a caixa, clicar na seta para selecionar arquivos locais ou usar `Ctrl+V` para colar imagem/arquivo/texto do clipboard. Texto colado vira `quickdrop-paste.txt`; no desktop Wayland o `Ctrl+V` lê o clipboard via `wl-paste`; no Windows o WebView2 entrega o paste event padrão; múltiplos arquivos são compactados em um ZIP temporário antes do envio e geram um único link.

Build web/Tauri:

```bash
bun run desktop:build:web
bun run desktop:build
```

Instalação Windows via PowerShell:

```powershell
irm https://quickdrop.eaedave.xyz/install.ps1 | iex
```

O endpoint interno `GET /install.ps1` serve `scripts/install-windows.ps1`. O script baixa o instalador em `GET /windows/latest.exe` (ou `QUICKDROP_WINDOWS_INSTALLER_URL`, se definido); o backend usa `QUICKDROP_GITHUB_TOKEN`/`GITHUB_TOKEN` server-side para buscar o asset privado `QuickDrop_*_x64-setup.exe` do último GitHub Release, repassa o binário ao Windows, roda o NSIS em modo silencioso para o usuário atual e inicia o app com `--tray-start`.

Build Windows (em Windows local/CI; o CI do GitHub Actions pode ser religado depois quando houver cota):

```bash
bun run desktop:build:windows
```

No Windows, o app cria um ícone na system tray. Clique esquerdo abre/foca a janela QuickDrop posicionada acima da tray; a barra superior customizada permite arrastar a janela; botão fechar/Esc apenas ocultam a janela; no primeiro start o autostart é ativado automaticamente; o menu da tray tem `Abrir QuickDrop`, `Iniciar com Windows` e `Sair`.

O executável Windows gerado aponta para produção por padrão: se `QUICKDROP_API_BASE_URL` não estiver definido no ambiente do usuário, o app usa `https://quickdrop.eaedave.xyz`. Defina `QUICKDROP_API_BASE_URL` apenas para testar outro backend.

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
cargo test --manifest-path src-tauri/Cargo.toml
bun run desktop:build:web
bun run desktop:build
```

O teste de upload/download de ponta a ponta exige PostgreSQL e R2 reais configurados no `.env`.
<!-- business-readme:technical:end -->
