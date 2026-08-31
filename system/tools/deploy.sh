#!/usr/bin/env bash
# Publish website/dist via wrangler. Refuses (exit 5) unless approvals.approve
# exists for this engagement and status is awaiting_approval. Never writes events.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: deploy.sh <engagement-id> <approval-id>" >&2
  exit 2
fi

ENGAGEMENT_ID="$1"
APPROVAL_ID="$2"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="${TENWHY_DB:-$ROOT/state/orchestrator.db}"

refuse() {
  local reason="$1"
  printf '%s\n' "{\"refused\": true, \"reason\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$reason")}"
  exit 5
}

if [[ ! -f "$DB" ]]; then
  refuse "database not found"
fi

ROW="$(sqlite3 -readonly "$DB" "SELECT a.action || '|' || IFNULL(e.status,'') FROM approvals a LEFT JOIN engagements e ON e.id = a.engagement_id WHERE a.id = '$(printf '%s' "$APPROVAL_ID" | sed "s/'/''/g")' AND a.engagement_id = '$(printf '%s' "$ENGAGEMENT_ID" | sed "s/'/''/g")';")" || true
if [[ -z "$ROW" ]]; then
  refuse "no matching approvals.approve row"
fi
ACTION="${ROW%%|*}"
STATUS="${ROW#*|}"
if [[ "$ACTION" != "approve" ]]; then
  refuse "approvals row is not action=approve"
fi
if [[ "$STATUS" != "awaiting_approval" ]]; then
  refuse "engagement is not awaiting_approval"
fi

SLUG="${TENWHY_SLUG:-}"
if [[ -z "$SLUG" ]]; then
  SLUG="$(sqlite3 -readonly "$DB" "SELECT json_extract(payload,'$.slug') FROM events WHERE engagement_id = '$(printf '%s' "$ENGAGEMENT_ID" | sed "s/'/''/g")' AND kind = 'engagement.created' ORDER BY id LIMIT 1;")" || true
fi
if [[ -z "$SLUG" ]]; then
  echo "deploy.sh: missing slug" >&2
  exit 1
fi

REPO="${TENWHY_REPO_DIR:-$ROOT/state/customers/$SLUG}"
WEBSITE="$REPO/website"
DIST="$WEBSITE/dist"
if [[ ! -d "$DIST" ]]; then
  echo "deploy.sh: missing $DIST" >&2
  exit 1
fi

NAME="tenwhy-${SLUG}"
COMPAT="$(date -u +%Y-%m-%d)"
cat >"$WEBSITE/wrangler.toml" <<EOF
name = "${NAME}"
compatibility_date = "${COMPAT}"

[assets]
directory = "dist"
EOF

set +e
WLOG="$(mktemp)"
wrangler deploy --cwd "$WEBSITE" >"$WLOG" 2>&1
WEXIT=$?
set -e
WTAIL="$(tail -n 40 "$WLOG")"
if [[ "$WEXIT" -ne 0 ]]; then
  echo "deploy.sh: wrangler deploy failed:" >&2
  printf '%s\n' "$WTAIL" >&2
  rm -f "$WLOG"
  exit "$WEXIT"
fi

LIVE_URL="$(python3 - "$WLOG" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
urls = re.findall(r"https://[^\s\"']+", text)
print(urls[-1].rstrip(").,]>") if urls else "")
PY
)"
rm -f "$WLOG"
if [[ -z "$LIVE_URL" && -n "${SITE_WORKERS_DEV_SUBDOMAIN:-}" ]]; then
  LIVE_URL="https://${NAME}.${SITE_WORKERS_DEV_SUBDOMAIN}"
fi
if [[ -z "$LIVE_URL" ]]; then
  echo "deploy.sh: could not parse deployed URL" >&2
  exit 1
fi

CODE=""
for _i in $(seq 1 10); do
  CODE="$(curl -s -o /dev/null -w "%{http_code}" "$LIVE_URL" || true)"
  if [[ "$CODE" == "200" ]]; then
    break
  fi
  sleep 6
done
if [[ "$CODE" != "200" ]]; then
  echo "deploy.sh: live URL did not return 200 (last ${CODE})" >&2
  exit 1
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  echo "# Deploy"
  echo
  echo "- url: ${LIVE_URL}"
  echo "- deployed_at: ${NOW}"
  echo
  echo "\`\`\`"
  printf '%s\n' "$WTAIL"
  echo "\`\`\`"
} >"$WEBSITE/DEPLOY.md"

if [[ -d "$REPO/.git" ]]; then
  git -C "$REPO" add website/DEPLOY.md website/wrangler.toml
  git -C "$REPO" diff --cached --quiet || git -C "$REPO" commit -m "deploy ${LIVE_URL}" >/dev/null
  if git -C "$REPO" remote get-url origin >/dev/null 2>&1; then
    git -C "$REPO" push origin HEAD >/dev/null
  fi
fi

python3 -c 'import json,sys; print(json.dumps({"live_url": sys.argv[1]}))' "$LIVE_URL"
