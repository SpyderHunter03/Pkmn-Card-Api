#!/usr/bin/env bash
# Runs ON a node, piped in over SSH by .github/workflows/deploy.yml:
#   TARGET_SHA=<commit> bash -s < deploy/deploy-node.sh
#
# The contract with the workflow: exit 0 means this node is verified serving
# TARGET_SHA's version; any other exit means the node was rolled back to the
# commit it was on and the caller must halt the rollout. Either way the box
# is left on exactly one working version — never half-updated.
#
# The token ledger is never in danger here: it lives in DATA_DIR
# (/var/lib/card-api), outside the repo, and `git reset --hard` touches only
# /opt/card-api. Counts survive updates AND rollbacks.
set -euo pipefail

: "${TARGET_SHA:?TARGET_SHA must be set to the commit to deploy}"

cd /opt/card-api

OLD_SHA=$(git rev-parse HEAD)
if [ "$OLD_SHA" = "$TARGET_SHA" ]; then
  echo "already on $TARGET_SHA"
fi

git fetch origin
# reset --hard, not pull: a box is never a place where the tree drifted, and
# if it somehow did, the deploy wins — the repo copy on a node is disposable.
git reset --hard "$TARGET_SHA"

WANT=$(node -p "require('./package.json').version")

verify() {
  # The node must come back up AND say it is running the wanted version —
  # "the process restarted" is not "the new code is serving".
  local want="$1" body
  for _ in $(seq 1 30); do
    sleep 1
    body=$(curl -s --max-time 2 http://localhost:3400/v1/health || true)
    if [ "${body#*\"ok\":true}" != "$body" ] && [ "${body#*\"service\":\"$want\"}" != "$body" ]; then
      return 0
    fi
  done
  return 1
}

systemctl restart card-api

if verify "$WANT"; then
  echo "$(hostname): healthy on service $WANT ($TARGET_SHA)"
  exit 0
fi

echo "$(hostname): FAILED to verify $WANT — rolling back to $OLD_SHA" >&2
git reset --hard "$OLD_SHA"
OLD_WANT=$(node -p "require('./package.json').version")
systemctl restart card-api
if verify "$OLD_WANT"; then
  echo "$(hostname): rolled back, healthy again on $OLD_WANT" >&2
else
  echo "$(hostname): rollback restart did NOT verify — check 'journalctl -u card-api' on this box NOW" >&2
fi
exit 1
