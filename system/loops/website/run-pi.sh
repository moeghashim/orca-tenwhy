#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
: "${PROVIDER:?PROVIDER is required}"
: "${MODEL:?MODEL is required}"
: "${SESSION_DIR:?SESSION_DIR is required}"
: "${SESSION_ID:?SESSION_ID is required}"
PROMPT="${1:-${PROMPT:?PROMPT is required}}"
mkdir -p "$SESSION_DIR"
cd "$ROOT"
exec pi -p --offline --mode json --provider "$PROVIDER" --model "$MODEL" --thinking high \
   --no-builtin-tools --no-extensions --no-skills --no-prompt-templates --no-context-files \
   --session-dir "$SESSION_DIR" --session-id "$SESSION_ID" "$PROMPT"
