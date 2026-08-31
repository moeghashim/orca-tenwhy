#!/usr/bin/env bash
# Stripe Projects provision for an engagement. Writes names-only record to
# state/provision/<engagement-id>.json. Never prints or records secret values.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: provision.sh <engagement-id> <slug>" >&2
  exit 2
fi

ENGAGEMENT_ID="$1"
SLUG="$2"
if [[ -z "$ENGAGEMENT_ID" || -z "$SLUG" ]]; then
  echo "usage: provision.sh <engagement-id> <slug>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${TENWHY_PROVISION_DIR:-$ROOT/state/provision/$ENGAGEMENT_ID}"
RECORD="$ROOT/state/provision/${ENGAGEMENT_ID}.json"
PROJECT_NAME="tenwhy-${SLUG}"
mkdir -p "$WS" "$(dirname "$RECORD")"

stripe_json() {
  # Run stripe in the engagement workspace. All extra args are passed through.
  stripe "$@" --json --yes --non-interactive
}

cd "$WS"

STATUS_JSON="$(stripe projects status --json 2>/dev/null || true)"
INITIALIZED="$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys
raw=sys.stdin.read()
try:
    j=json.loads(raw)
except Exception:
    print("0"); raise SystemExit
print("1" if j.get("meta",{}).get("project_initialized") else "0")')"

if [[ "$INITIALIZED" != "1" ]]; then
  # Flags from `stripe projects init --help`: --json --yes --accept-tos
  # --skip-skills --mode manual; --non-interactive from --interactive help.
  stripe_json projects init "$PROJECT_NAME" --accept-tos --skip-skills --mode manual >/dev/null
fi

# Account may already have Cloudflare linked; `link` returns already_linked
# without a browser (`stripe projects link --help`).
stripe_json projects link cloudflare --accept-tos >/dev/null

# CLI add preflight remedy: provision workers:free before cloudflare/workers.
HAS_PLAN="$(stripe projects status --json | python3 -c 'import json,sys
j=json.load(sys.stdin)
plans=j.get("data",{}).get("plans") or []
print("1" if any(p.get("service_id")=="workers:free" for p in plans) else "0")')"
if [[ "$HAS_PLAN" != "1" ]]; then
  stripe_json projects add cloudflare/workers:free --accept-tos >/dev/null
fi

HAS_SITE="$(stripe projects status --json | python3 -c 'import json,sys
j=json.load(sys.stdin)
svcs=j.get("data",{}).get("services") or []
print("1" if any(p.get("service_id")=="workers" for p in svcs) else "0")')"
if [[ "$HAS_SITE" != "1" ]]; then
  # Brief + `stripe projects add --help`: --json --non-interactive --accept-tos --name site
  stripe_json projects add cloudflare/workers --accept-tos --name site >/dev/null
fi

stripe_json projects env show >"$WS/.env-show.json"
stripe_json projects env --pull >/dev/null
stripe projects env --json >"$WS/.env-list.json"
stripe projects status --json >"$WS/.status.json"

python3 - "$RECORD" "$ENGAGEMENT_ID" "$SLUG" "$PROJECT_NAME" "$WS" <<'PY'
import json, os, sys
from datetime import datetime, timezone

record_path, engagement_id, slug, project_name, ws = sys.argv[1:6]
with open(os.path.join(ws, ".env-show.json"), encoding="utf-8") as f:
    env_show = json.load(f)
with open(os.path.join(ws, ".env-list.json"), encoding="utf-8") as f:
    env_list = json.load(f)
with open(os.path.join(ws, ".status.json"), encoding="utf-8") as f:
    status = json.load(f)

def names_only(blob):
    keys = []
    data = blob.get("data") or {}
    for rac in data.get("resource_access_configurations") or []:
        for k in rac.get("access_configuration_keys") or []:
            if k not in keys:
                keys.append(k)
    return keys

project = (status.get("data") or {}).get("project") or {}
services = []
for row in (status.get("data") or {}).get("plans") or []:
    services.append({
        "name": row.get("name"),
        "service_id": row.get("service_id"),
        "kind": "plan",
        "id": row.get("id"),
    })
for row in (status.get("data") or {}).get("services") or []:
    services.append({
        "name": row.get("name"),
        "service_id": row.get("service_id"),
        "kind": "service",
        "id": row.get("id"),
    })

env_file = None
show_data = env_show.get("data") or {}
if isinstance(show_data, dict) and show_data.get("output"):
    env_file = os.path.abspath(os.path.join(ws, show_data["output"]))
if not env_file:
    env_file = os.path.abspath(os.path.join(ws, ".env"))

record = {
    "engagement_id": engagement_id,
    "slug": slug,
    "project_name": project_name,
    "project_id": project.get("id"),
    "provider": "Cloudflare",
    "resources": services,
    "env_var_names": names_only(env_list),
    "env_file": env_file,
    "workspace": os.path.abspath(ws),
    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
os.makedirs(os.path.dirname(record_path), exist_ok=True)
with open(record_path, "w", encoding="utf-8") as f:
    json.dump(record, f, indent=2)
    f.write("\n")
print(record_path)
PY
