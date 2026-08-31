#!/usr/bin/env bash
# SOP §0.6: every commit (author AND committer) must be Moe Ghashim <mohanadgh@gmail.com>.
set -euo pipefail
EXPECTED="Moe Ghashim <mohanadgh@gmail.com>"
bad=$(git log --format='%h %an <%ae> | %cn <%ce>' | grep -v "$EXPECTED | $EXPECTED" || true)
if [ -n "$bad" ]; then
  echo "commit identity violations (expected $EXPECTED as author and committer):" >&2
  echo "$bad" >&2
  exit 1
fi
cfg="$(git config user.name) <$(git config user.email)>"
if [ "$cfg" != "$EXPECTED" ]; then
  echo "repo git identity is '$cfg', expected '$EXPECTED'" >&2
  exit 1
fi
echo "commit identity ok ($(git rev-list --count HEAD) commits, config $cfg)"
