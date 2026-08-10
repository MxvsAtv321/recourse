#!/usr/bin/env bash
# Recourse end to end demo. Four scenarios against a local anvil at 127.0.0.1:8545.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.foundry/bin:$PATH"
RPC="http://127.0.0.1:8545"
ANVIL_PID=""

cleanup() {
  if [[ -n "$ANVIL_PID" ]]; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

alive() {
  curl -s -m 1 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1
}

if alive; then
  echo "using the anvil already listening on 127.0.0.1:8545"
else
  echo "starting anvil on 127.0.0.1:8545"
  anvil --host 127.0.0.1 --port 8545 --silent >/tmp/recourse-anvil.log 2>&1 &
  ANVIL_PID=$!
  for _ in $(seq 1 50); do
    alive && break
    sleep 0.2
  done
  alive || { echo "anvil did not come up"; cat /tmp/recourse-anvil.log; exit 1; }
fi

echo "building contracts"
forge build --silent

if [[ ! -d agent/node_modules ]]; then
  echo "installing agent dependencies"
  (cd agent && npm install --silent)
fi

# Not exec: that would replace this shell and skip the EXIT trap, orphaning anvil.
agent/node_modules/.bin/tsx agent/src/demo/run.ts
status=$?
exit "$status"
