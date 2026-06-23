#!/usr/bin/env sh
set -eu

if [ "${RUN_MIGRATIONS_ON_START:-true}" != "false" ]; then
  bun run db:migrate
fi

exec "$@"
