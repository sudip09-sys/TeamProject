#!/bin/sh
set -eu
# A mounted persistent volume starts root-owned. Prepare its directory, then
# drop privileges before the web server starts.
if [ "$(id -u)" = '0' ]; then
  database_dir=$(dirname "${DATABASE_PATH:-/app/data/nextstep.sqlite}")
  mkdir -p "$database_dir"
  chown node:node "$database_dir"
  exec gosu node "$@"
fi
exec "$@"
