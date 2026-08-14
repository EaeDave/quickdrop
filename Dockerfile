# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-debian AS build-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM build-deps AS build-web
WORKDIR /app
COPY . .
RUN bun run desktop:build:web

FROM oven/bun:1.3.14-debian AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    RUN_MIGRATIONS_ON_START=true

RUN groupadd --system quickdrop \
  && useradd --system --gid quickdrop --home-dir /app --shell /usr/sbin/nologin quickdrop

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build-web /app/dist ./dist
COPY package.json bun.lock ./
COPY migrations ./migrations
COPY src/server ./src/server
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY scripts/install-windows.ps1 ./scripts/install-windows.ps1
COPY scripts/install-linux.sh ./scripts/install-linux.sh
COPY scripts/install-macos.sh ./scripts/install-macos.sh
COPY scripts/quickdrop-launcher ./scripts/quickdrop-launcher
COPY scripts/install-bar-integration.sh ./scripts/install-bar-integration.sh
COPY scripts/install-waybar-module.py ./scripts/install-waybar-module.py
COPY scripts/omarchy-quickdrop ./scripts/omarchy-quickdrop

RUN chmod 755 ./scripts/docker-entrypoint.sh

USER quickdrop
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const port = process.env.PORT ?? '3000'; const response = await fetch('http://127.0.0.1:' + port + '/api/health'); process.exit(response.ok ? 0 : 1);"

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["bun", "run", "server:start"]
