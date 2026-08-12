# QuickDrop

<!-- business-readme:business-rules:start -->
## Regras de negócio

- QuickDrop é um app de envio de arquivos com interface desktop Linux/Wayland (aberta pela OmarchyBar ou Waybar), cliente Windows com ícone residente na system tray e uma página web na raiz do servidor (`GET /`) com upload e comandos copiáveis de instalação para Windows (PowerShell) e Linux (Bash). Fonte: UI `src/desktop/App.tsx`, comandos Tauri `src-tauri/src/lib.rs`, integrações em `scripts/install-bar-integration.sh`, config Windows `src-tauri/tauri.windows.conf.json` e `@fastify/static` em `src/server/index.ts`.
- No Windows, o executável empacotado usa `https://quickdrop.eaedave.xyz` como backend padrão quando `QUICKDROP_API_BASE_URL` não está definido; no Linux/Wayland, o launcher genérico lê o mesmo backend remoto de `~/.config/quickdrop/config.env`, independentemente da barra utilizada. Fonte: `DesktopConfig::from_env` em `src-tauri/src/lib.rs`, `scripts/quickdrop-launcher` e `scripts/install-linux.sh`.
- Tanto o cliente desktop quanto o cliente web aceitam 1 ou vários arquivos por ação (drag-and-drop, clique para selecionar ou `Ctrl+V`). Com múltiplos arquivos, a compactação ZIP é feita no lado do cliente (no Rust/Tauri para caminhos locais; usando `fflate` no navegador/clipboard para arquivos em memória) antes do envio, gerando apenas 1 link público. Fonte: `src/desktop/App.tsx`, `src/desktop/tauri.ts` e `upload_files` no Rust.
- Ao colar com `Ctrl+V`, imagens/arquivos do clipboard são enviados como arquivo normal; texto do clipboard vira automaticamente `quickdrop-paste.txt` (`text/plain`) antes do upload. No desktop Wayland, o atalho usa `wl-paste` nativo para contornar limitações do paste event do WebView com imagens; no Windows, o paste event padrão do WebView2 é usado. Fonte: `src/desktop/App.tsx` e `src-tauri/src/lib.rs`.
- O backend aceita 1 arquivo por requisição multipart, de qualquer tipo, e valida multipart, arquivo vazio e tamanho máximo. Para múltiplos arquivos, esse arquivo é o ZIP gerado pelo desktop/web; o limite padrão de 100 MB se aplica ao pacote final e pode ser alterado por `MAX_FILE_SIZE_MB`. Fonte: Endpoint interno `POST /api/upload` em `src/server/upload-service.ts`.
- Uploads são públicos e não exigem autenticação no MVP, mas têm barreiras anti-abuso: limite padrão de 5 uploads por hora por IP (`UPLOAD_RATE_LIMIT_MAX`) e kill switch `UPLOADS_ENABLED=false` para bloquear uploads sem derrubar downloads/instaladores. Fonte: Endpoint interno `POST /api/upload` em `src/server/index.ts` e `src/server/config.ts`.
- O servidor mantém uma quota global de armazenamento antes de gravar no R2: por padrão `R2_STORAGE_HARD_LIMIT_GB=8`. Cada upload reserva bytes em PostgreSQL (`storage_reservations`/`storage_quota`) e só prossegue se `active_bytes + reserved_bytes + novo_arquivo` couber no hard cap; quando a quota estoura, o upload responde `507 storage_quota_exceeded`. Fonte: Endpoint interno `POST /api/upload`, `src/server/storage-quota.ts` e migração `migrations/003_create_storage_quota.sql`.
- Upload válido é registrado no PostgreSQL, enviado ao Cloudflare R2 e retorna `{ id, url, expiresAt }`. A URL pública tem formato `${PUBLIC_BASE_URL}/f/:shortId`. Fonte: Endpoint interno `POST /api/upload` e tabela `uploads`.
- Links públicos são acessíveis sem autenticação. `GET /f/:shortId` busca o registro, verifica expiração, incrementa `download_count` e redireciona para uma URL assinada temporária do R2. Fonte: Endpoint interno `GET /f/:shortId` em `src/server/download-service.ts`.
- Arquivos expiram por padrão após 6 horas, configurável por `FILE_EXPIRATION_HOURS`. O job `cleanupExpiredUploads` roda a cada 5 minutos, libera reservas vencidas, remove uploads expirados do R2 e marca `deleted_at`; depois disso o link retorna expirado ou não encontrado. Fonte: Job interno `cleanupExpiredUploads`, `src/server/cleanup.ts` e Endpoint interno `GET /f/:shortId`.
- Ao concluir o upload no desktop, o app copia o link único e exibe notificação de sucesso. No Linux/Wayland usa `wl-copy` e `notify-send`; no Windows usa os plugins nativos de clipboard e notification do Tauri. Se a cópia falhar, a UI mostra o link para cópia manual; se a notificação falhar, o upload continua como sucesso com aviso. Fonte: comandos desktop `copy_link` e `notify_success`.
- A janela do MVP exibe progresso, estados de sucesso/erro e pode ser fechada pelo botão visível ou pela tecla `Esc`. No Linux/Wayland, o launcher compartilhado pela OmarchyBar e Waybar abre a janela flutuante compacta em cerca de `432x272` no compositor (`380x220` de área interna Tauri) e fechar encerra a janela como antes; no Windows, a janela usa a mesma área interna compacta, fechar oculta a janela, mantém o app vivo na tray até o usuário escolher `Sair`, abre posicionada acima da área da tray e pode ser arrastada pela barra superior customizada. No primeiro start no Windows, o app ativa `Iniciar com Windows` automaticamente e grava um marcador local; se o usuário desativar o autostart no menu da tray, o app não reativa sozinho em starts futuros. Fonte: launcher `scripts/quickdrop-launcher`, configuração Tauri `src-tauri/tauri.conf.json`, tray/posicionamento/autostart em `src-tauri/src/lib.rs` e UI `src/desktop/App.tsx`.
- A instalação Windows por PowerShell é pública no endpoint `GET /install.ps1`; o `.exe` é baixado pelo endpoint interno `GET /windows/latest.exe`, que usa um token GitHub configurado somente no servidor para buscar o asset privado `QuickDrop_*_x64-setup.exe` da última release sem expor credenciais ao usuário final. A página principal exibe `irm https://quickdrop.eaedave.xyz/install.ps1 | iex` com botão de cópia. Após o NSIS silencioso concluir, o script abre o app instalado em modo visível no canto direito e libera o terminal. Fonte: `src/desktop/App.tsx`, `scripts/install-windows.ps1`, `src/server/index.ts` e `src/server/windows-installer-service.ts`.
- A instalação Linux por Bash é pública no endpoint `GET /install.sh` (`curl -fsSL https://quickdrop.eaedave.xyz/install.sh | bash`); o script detecta Linux/x86_64 e escolhe automaticamente OmarchyBar ou Waybar, com override `QUICKDROP_BAR=auto|omarchy|waybar|both|none`. Ele baixa o binário pré-compilado por `GET /linux/latest`, instala `~/.local/bin/quickdrop`, o launcher genérico `~/.local/bin/quickdrop-launcher` e o alias compatível `quickdrop-waybar`. Para OmarchyBar instala o plugin `quickdrop.bar` em `~/.config/omarchy/plugins/`; para Waybar mantém o módulo idempotente `custom/quickdrop` com backup do JSONC. Fonte: `scripts/install-linux.sh`, `scripts/install-bar-integration.sh`, `src/server/index.ts`, `src/server/linux-installer-service.ts` e `src/server/github-release.ts`.
- O QuickDrop tem um relay de texto em tempo real para colar/compartilhar texto entre máquinas sem clipboard compartilhado (ex.: máquinas Guacamole). Pela web, o usuário digita um código próprio de 1 a 16 caracteres e usa uma única ação para abrir o clipboard existente ou criá-lo automaticamente; a opção secundária preserva a geração de um código aleatório; um textarea grande é sincronizado ao vivo entre todos na mesma sala via WebSocket, no modelo último-a-escrever-vence (last-writer-wins) com versão monotônica. Edições simultâneas não sobrescrevem em silêncio: quando chega uma alteração remota durante uma edição local pendente, a UI mostra um aviso não destrutivo com opção de carregar. As salas ficam persistidas no PostgreSQL, então sobrevivem a restart/deploy; cada registro possui identidade UUID independente do código público, e apenas salas não removidas exigem código único, permitindo reutilizar um código depois da expiração e limpeza. Clipboards com código personalizado expiram 30 minutos depois que o último cliente sai; salas com código aleatório mantêm 12 horas por padrão, e nenhuma expira enquanto houver cliente conectado. As salas limitam tamanho do texto (padrão 256 KB) e número de salas/clientes. Opcionalmente, a sala pode ser criada com PIN: o texto passa a exigir o código curto **e** o PIN para leitura/sincronização, usando um cookie HttpOnly por sala em vez de colocar segredo ou token de acesso na URL/WebSocket. A interface do clipboard também mostra presença em tempo real (`1 conectado`, `2 conectados`), indica quando outras pessoas estão digitando, exibe o mouse remoto de cada peer com cor/label distintos dentro da área do editor, oferece ações diretas para copiar o texto e compartilhar a URL canônica `/t/CÓDIGO`, e permite exportar explicitamente o texto atual como arquivo `.txt` pelo mesmo fluxo público de upload do QuickDrop, retornando um link público copiável. A escrita persistida do texto foi ajustada para parecer mais imediata (janela de envio ~75 ms, com flush rápido em paste/blur), enquanto typing e mouse são efêmeros e não persistem no banco. A página é servida pelo mesmo backend (subdomínio `texto.*`, com entrada direta em `/t` e `/t/:code`, além do legado `?c=CÓDIGO` na raiz). Fontes: Endpoints internos `POST /api/text`, `POST /api/text/:code/access`, `GET /api/text/:code`, `WS /api/text/:code/ws` (sync + presence + typing + pointer) e `POST /api/upload`; rotas públicas `GET /t` e `GET /t/:code`; repositório `src/server/text-rooms-repository.ts`, hub `src/server/text-session-hub.ts`, serviço `src/server/text-session-service.ts`, UI `src/desktop/TextSession.tsx`.
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
FILE_EXPIRATION_HOURS=6
MAX_FILE_SIZE_MB=100
UPLOAD_RATE_LIMIT_MAX=5
UPLOADS_ENABLED=true
R2_STORAGE_HARD_LIMIT_GB=8
UPLOAD_RESERVATION_TTL_MINUTES=30
TEXT_SESSION_TTL_HOURS=12
TEXT_CUSTOM_SESSION_TTL_MINUTES=30
TEXT_SESSION_MAX_KB=256
TEXT_SESSION_CODE_LENGTH=6
TEXT_SESSION_MAX_SESSIONS=500
TEXT_SESSION_MAX_CLIENTS=20
QUICKDROP_API_BASE_URL=http://127.0.0.1:3000
RUN_MIGRATIONS_ON_START=true
QUICKDROP_GITHUB_TOKEN=
QUICKDROP_GITHUB_REPOSITORY=EaeDave/quickdrop
```

Preencha `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` e `PUBLIC_BASE_URL` antes de iniciar um backend real. Para uso diário na máquina local, o launcher compartilhado pelas barras aponta por padrão para `https://quickdrop.eaedave.xyz`; assim o QuickDrop continua funcionando após reiniciar o computador sem depender de um processo local.

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

### Sessões de texto (relay de texto)

Relay de texto em tempo real entre máquinas, no mesmo backend:

- `POST /api/text` — cria uma sala aleatória e retorna `{ code, protected, kind, expiresAfterMinutes }` (6 caracteres base32 sem ambíguos), com rate limit; `pin` opcional no body cria uma sala protegida e já concede o acesso inicial ao criador por cookie HttpOnly.
- `POST /api/text/:code/open` — abre ou cria atomicamente um clipboard com código escolhido pelo usuário (1 a 16 letras, números, `_` ou `-`) e retorna `{ code, created, protected, kind, expiresAfterMinutes }`; o índice parcial no PostgreSQL garante somente uma sala ativa por código, e o endpoint também valida PIN de uma sala protegida.
- `POST /api/text/:code/access` — endpoint compatível que valida o PIN da sala protegida (ou reaproveita um cookie ainda válido), define/renova o cookie HttpOnly por sala e libera a entrada. Sala pública responde sem exigir PIN.
- `GET /api/text/:code` — snapshot atual `{ text, version, protected, kind, expiresAfterMinutes }` (404 se a sala não existe, 401 se for protegida e o acesso não estiver autorizado).
- `WS /api/text/:code/ws` — o servidor envia `snapshot` ao conectar, `update` quando outro cliente escreve, `presence` com a contagem de clientes conectados, `typing` quando um peer está digitando, `pointer` com a posição normalizada do mouse dentro do editor, `peer_left` para limpar estados efêmeros de quem saiu, `ack` ao autor após cada escrita e `error` (texto acima do limite, sala inválida ou acesso protegido sem PIN). O cliente envia `{ type: "write", text, baseVersion }`, `{ type: "typing", active }` e `{ type: "pointer", visible, x, y }`. Heartbeat ping/pong derruba conexões mortas.
- O texto persistido usa uma janela de envio curta (~75 ms) para reduzir a sensação de atraso sem abandonar o modelo atual last-writer-wins; a interface permite limpar o conteúdo para todos os clientes com confirmação. `typing`, `pointer` e `peer_left` são puramente efêmeros e nunca vão para o PostgreSQL.

```env
TEXT_SESSION_TTL_HOURS=12
TEXT_CUSTOM_SESSION_TTL_MINUTES=30
TEXT_SESSION_MAX_KB=256
TEXT_SESSION_CODE_LENGTH=6
TEXT_SESSION_MAX_SESSIONS=500
TEXT_SESSION_MAX_CLIENTS=20
```

Rotas de texto usam `Cache-Control: no-store`, bloqueiam framing, removem referrer e mascaram o código nos logs HTTP. A página web é servida pela mesma SPA: abre direto quando o host começa com `texto.`, em `/t` e na URL canônica `/t/CÓDIGO`. Links legados com `?c=CÓDIGO` na raiz continuam aceitos e são substituídos pela URL canônica depois que o clipboard abre. Para usar o subdomínio, aponte `texto.<seu-domínio>` para a mesma service no Coolify.

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
FILE_EXPIRATION_HOURS=6
MAX_FILE_SIZE_MB=100
UPLOAD_RATE_LIMIT_MAX=5
UPLOADS_ENABLED=true
R2_STORAGE_HARD_LIMIT_GB=8
UPLOAD_RESERVATION_TTL_MINUTES=30
TEXT_SESSION_TTL_HOURS=12
TEXT_CUSTOM_SESSION_TTL_MINUTES=30
TEXT_SESSION_MAX_KB=256
TEXT_SESSION_CODE_LENGTH=6
TEXT_SESSION_MAX_SESSIONS=500
TEXT_SESSION_MAX_CLIENTS=20
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

Para instalar o desktop e configurar a barra detectada para esse backend local em um comando:

```bash
bun run quickdrop:install:local
```

Para voltar a usar o backend remoto depois:

```bash
QUICKDROP_API_BASE_URL=https://quickdrop.eaedave.xyz bun run quickdrop:install
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

Página principal:

- `GET /` serve a landing page web com hero, abas Windows/Linux para copiar o comando de instalação (`irm https://quickdrop.eaedave.xyz/install.ps1 | iex` no Windows, `curl -fsSL https://quickdrop.eaedave.xyz/install.sh | bash` no Linux), link “Ver script” para `GET /install.ps1` ou `GET /install.sh` conforme a aba, e a área de upload web.

Instalação Windows via PowerShell:

```powershell
irm https://quickdrop.eaedave.xyz/install.ps1 | iex
```

O endpoint interno `GET /install.ps1` serve `scripts/install-windows.ps1`. O script baixa o instalador em `GET /windows/latest.exe` (ou `QUICKDROP_WINDOWS_INSTALLER_URL`, se definido); o backend usa `QUICKDROP_GITHUB_TOKEN`/`GITHUB_TOKEN` server-side para buscar o asset privado `QuickDrop_*_x64-setup.exe` do último GitHub Release, repassa o binário ao Windows, roda o NSIS em modo silencioso para o usuário atual, espera apenas o instalador terminar e então abre o `QuickDrop.exe` instalado sem `--tray-start` para mostrar a janela no canto direito.

Instalação Linux via Bash (Hyprland + OmarchyBar ou Waybar):

```bash
curl -fsSL https://quickdrop.eaedave.xyz/install.sh | bash
```

O endpoint `GET /install.sh` serve `scripts/install-linux.sh`. O script detecta Linux x86_64 e a barra realmente ativa: consulta o plugin `omarchy.bar` pelo IPC do `omarchy-shell` antes de procurar um processo Waybar, evitando escolher uma instalação Waybar obsoleta. O override `QUICKDROP_BAR` aceita `auto`, `omarchy`, `waybar`, `both` ou `none`. O binário vem de `GET /linux/latest`; o launcher genérico vem de `GET /linux/quickdrop-launcher` e lê o backend persistido em `~/.config/quickdrop/config.env`. O adapter Omarchy instala e habilita `quickdrop.bar` em `~/.config/omarchy/plugins/`; o adapter Waybar aplica `custom/quickdrop` de forma idempotente e cria backup do JSONC. Variáveis úteis: `QUICKDROP_API_BASE_URL`, `QUICKDROP_BAR`, `QUICKDROP_BIN_DIR`, `QUICKDROP_WAYBAR_CONFIG` e `QUICKDROP_BAR_NO_RESTART`. O endpoint e executável `quickdrop-waybar` continuam disponíveis por compatibilidade.

Para gerar e publicar o binário Linux da release:

```bash
bun run desktop:package:linux
gh release upload <tag> src-tauri/target/release/quickdrop_<versão>_x86_64-linux --clobber
```

Build Windows (em Windows local/CI; o CI do GitHub Actions pode ser religado depois quando houver cota):

```bash
bun run desktop:build:windows
```

No Windows, o app cria um ícone na system tray. Clique esquerdo abre/foca a janela QuickDrop posicionada acima da tray; a barra superior customizada permite arrastar a janela; botão fechar/Esc apenas ocultam a janela; no primeiro start o autostart é ativado automaticamente; o menu da tray tem `Abrir QuickDrop`, `Iniciar com Windows` e `Sair`.

O executável Windows gerado aponta para produção por padrão: se `QUICKDROP_API_BASE_URL` não estiver definido no ambiente do usuário, o app usa `https://quickdrop.eaedave.xyz`. Defina `QUICKDROP_API_BASE_URL` apenas para testar outro backend.

Instalar o binário e integrar automaticamente com a barra ativa usando o backend remoto persistente:

```bash
bun run quickdrop:install
test -x "$HOME/.local/bin/quickdrop"
test -x "$HOME/.local/bin/quickdrop-launcher"
```

`quickdrop:install` instala dependências, compila o desktop, copia o binário e instala o adapter escolhido. O launcher usa o tamanho compacto padrão de cerca de `432x272`; `QUICKDROP_WINDOW_WIDTH` e `QUICKDROP_WINDOW_HEIGHT` permitem testar outro tamanho. Para reaplicar apenas uma integração:

```bash
bun run bar:install                 # detecção automática
bun run omarchy-bar:install         # força OmarchyBar
bun run waybar:install              # força Waybar
```

O adapter Omarchy usa o contrato oficial de plugin `bar-widget`, valida o manifesto, solicita rescan e habilita o widget na seção direita. O adapter Waybar mantém o snippet `custom/quickdrop`; seu `on-click` chama somente `~/.local/bin/quickdrop-launcher`, pois o backend agora é configuração compartilhada e não pertence à barra. Instalações antigas continuam funcionando por meio de `~/.local/bin/quickdrop-waybar` e `GET /linux/quickdrop-waybar`.

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
