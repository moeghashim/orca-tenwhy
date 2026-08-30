#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: migrate.sh <db-path>" >&2
  exit 1
fi

DB_PATH="$1"
SCHEMA="$(cd "$(dirname "$0")" && pwd)/schema.sql"

sqlite3 "$DB_PATH" < "$SCHEMA"
sqlite3 "$DB_PATH" ".tables"
