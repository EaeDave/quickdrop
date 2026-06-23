# QuickDrop - MVP Specification

## Overview

QuickDrop é uma aplicação desktop para Linux que permite compartilhar arquivos rapidamente através de drag-and-drop.

Objetivo principal:

1. Abrir uma pequena janela através da Waybar.
2. Arrastar um arquivo para a janela.
3. Upload automático para Cloudflare R2.
4. Gerar um link público.
5. Copiar o link automaticamente para o clipboard.
6. Exibir notificação de sucesso.
7. Arquivo expira automaticamente após um período configurado.

O foco do MVP é velocidade e simplicidade.

---

# Stack

## Desktop

- Tauri v2
- React
- TypeScript
- TailwindCSS

## Backend

- Bun
- Fastify
- TypeScript

## Database

- PostgreSQL

## Storage

- Cloudflare R2

## Linux Integration

- Waybar
- wl-copy
- notify-send

---

# User Flow

## Upload

Usuário clica no ícone da Waybar.

Aplicação QuickDrop abre uma pequena janela flutuante.

Usuário arrasta um arquivo para a área de drop.

Sistema:

1. Detecta o arquivo.
2. Faz upload para backend.
3. Backend envia arquivo para R2.
4. Backend cria registro no banco.
5. Backend retorna URL pública.
6. Cliente copia URL para clipboard.
7. Cliente exibe notificação.

Exemplo:

"Upload concluído. Link copiado para a área de transferência."

---

# Functional Requirements

## FR-001

Usuário deve conseguir arrastar um único arquivo para a janela.

## FR-002

Sistema deve iniciar upload automaticamente após o drop.

## FR-003

Sistema deve exibir progresso do upload.

## FR-004

Sistema deve copiar automaticamente o link gerado.

## FR-005

Sistema deve exibir notificação de sucesso.

## FR-006

Sistema deve exibir erro em caso de falha.

## FR-007

Sistema deve permitir fechar a janela a qualquer momento.

## FR-008

Links devem ser acessíveis publicamente.

## FR-009

Arquivos devem possuir expiração automática.

---

# Non Functional Requirements

## NFR-001

Tempo para abrir a janela:

< 500ms

## NFR-002

Upload deve iniciar imediatamente após o drop.

## NFR-003

Interface deve funcionar em Wayland.

## NFR-004

Aplicação deve consumir pouca memória.

Meta:

< 150 MB RAM

---

# Upload Rules

## Supported Files

MVP:

Aceitar qualquer arquivo.

## Max File Size

500 MB

Variável de configuração:

MAX_FILE_SIZE_MB

## Files Per Upload

MVP:

1 arquivo por vez.

---

# Expiration Rules

Valor padrão:

24 horas

Configuração:

FILE_EXPIRATION_HOURS

Após expiração:

1. Arquivo removido do R2.
2. Registro marcado como expirado.

---

# Database Schema

## uploads

```sql
create table uploads (
    id uuid primary key,
    short_id varchar(32) unique not null,

    original_name text not null,
    mime_type text,
    size_bytes bigint not null,

    r2_key text not null,

    download_count integer default 0,

    created_at timestamptz not null,
    expires_at timestamptz not null,

    deleted_at timestamptz
);
```

# R2 Object Structure

Bucket:

```text
quickdrop
```

Keys:

```text
uploads/2026/06/{uuid}-{filename}
```

Exemplo:

```text
uploads/2026/06/6e4d7f1a-relatorio.pdf
```

# API

## POST /api/upload

Multipart upload.

Response:

```json
{
  "id": "uuid",
  "url": "https://files.example.com/f/abc123",
  "expiresAt": "2026-06-23T12:00:00Z"
}
```

## GET /f/:shortId

Realiza:

1. Busca registro.
2. Verifica expiração.
3. Incrementa download_count.
4. Redireciona para URL assinada do R2.

## GET /api/health

Health check.

Response:

```json
{
  "status": "ok"
}
```

# Security

## Public Upload

MVP:

Sem autenticação.

## Rate Limit

IP:

20 uploads por hora.

## Allowed Size

Validar no backend.

## Validation

Verificar:

- tamanho
- arquivo vazio
- multipart inválido

# Cleanup Job

Executar a cada hora.

Processo:

1. Buscar uploads expirados.
2. Remover objeto do R2.
3. Atualizar registro.

Pseudo:

```ts
for (upload of expiredUploads) {
  deleteFromR2(upload.r2_key)
  markAsDeleted(upload.id)
}
```

# UI

## Window

Tamanho:

```text
500x300
```

Conteúdo:

```text
+-------------------------+
|      QuickDrop          |
|                         |
|  Arraste um arquivo     |
|      para enviar        |
|                         |
+-------------------------+
```

## Upload State

```text
Uploading...
78%
```

## Success State

```text
Upload concluído
Link copiado
```

## Error State

```text
Falha no upload
Tentar novamente
```

# Waybar Integration

Módulo customizado.

Clique:

```bash
quickdrop
```

Exemplo:

```json
"custom/quickdrop": {
  "format": "󰇚",
  "tooltip": "QuickDrop",
  "on-click": "quickdrop"
}
```

# Environment Variables

```env
PORT=3000

DATABASE_URL=

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=quickdrop

PUBLIC_BASE_URL=https://files.example.com

FILE_EXPIRATION_HOURS=24

MAX_FILE_SIZE_MB=500
```

# Future Features (Not MVP)

- Múltiplos arquivos
- Upload de screenshots
- Histórico de uploads
- Senha por arquivo
- Links de uso único
- Auto-delete após download
- Compressão automática
- Drag and drop diretamente da Waybar
- Cliente Windows
- Cliente macOS
- Upload de diretórios
- Compartilhamento anônimo via QR Code
