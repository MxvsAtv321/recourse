#!/usr/bin/env bash
# Build the way the deploy builds it.
#
# Vercel's root directory is ui/, so only ui's dependencies are installed and
# agent/node_modules does not exist. A bare specifier in agent/src resolves on a
# developer machine purely because npm install was run in agent/, which makes a
# local green build meaningless for the deploy. This hides agent/node_modules
# for the duration of one build and puts it back afterwards.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HIDDEN="$ROOT/.agent-node-modules-hidden"

restore() {
  if [ -d "$HIDDEN" ]; then
    mv "$HIDDEN" "$ROOT/agent/node_modules"
    echo "agent/node_modules restored"
  fi
}
trap restore EXIT INT TERM

if [ ! -d "$ROOT/agent/node_modules" ]; then
  echo "agent/node_modules is already absent; building as is"
else
  mv "$ROOT/agent/node_modules" "$HIDDEN"
  echo "agent/node_modules hidden: this is the deploy's state"
fi

cd "$ROOT/ui" && ./node_modules/.bin/next build
status=$?
exit "$status"
