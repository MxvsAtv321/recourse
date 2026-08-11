#!/usr/bin/env bash
# Deploy to Base Sepolia (84532).
#
# The key is read from .env, exported only into this process, and never echoed.
# Nothing here writes a key to disk or into the deployment record.
#
# Only RecourseEscrow is deployed. PredicateEvaluator and MerkleBreachVerifier
# expose no public or external functions, so solc inlines them into the escrow
# rather than linking them: RecourseEscrow has no link references and never
# delegatecalls them. Deploying them would create addresses nothing can call.
# See the Deployed section of README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

CHAIN_ID=84532
EXPLORER="https://sepolia.basescan.org"
OUT="deployments/base-sepolia.json"
POLL_TRIES=90
POLL_INTERVAL=2

[[ -f .env ]] || {
  echo "no .env. copy .env.example to .env, set DEPLOYER_PRIVATE_KEY, and fund the address." >&2
  exit 1
}
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is empty in .env}"
RPC="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"

actual=$(cast chain-id --rpc-url "$RPC")
[[ "$actual" == "$CHAIN_ID" ]] || {
  echo "refusing to deploy: RPC reports chain $actual, expected $CHAIN_ID" >&2
  exit 1
}

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
BAL_WEI=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
echo "chain     $CHAIN_ID"
echo "deployer  $DEPLOYER"
echo "balance   $(cast from-wei "$BAL_WEI") ETH"
[[ "$BAL_WEI" != "0" ]] || {
  echo "deployer holds no ETH. fund it from a Base Sepolia faucet and re-run." >&2
  exit 1
}

echo "building"
forge build --silent

# Poll until the address actually holds code. forge create's own confirmation
# polling can race against a load balanced public RPC and report failure for a
# deploy that landed, so the chain is the authority here, not forge's exit code.
wait_for_code() {
  local addr="$1" i code
  for ((i = 1; i <= POLL_TRIES; i++)); do
    code=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null || true)
    if [[ -n "$code" && "$code" != "0x" ]]; then
      echo "  mined after ~$((i * POLL_INTERVAL))s, $(((${#code} - 2) / 2)) bytes of runtime code"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  echo "  ERROR: no code at $addr after $((POLL_TRIES * POLL_INTERVAL))s" >&2
  return 1
}

# Deploys one contract and echoes "<address> <txHash>". Every failure path exits
# non-zero: the previous version let a failed parse fall through, which left the
# caller's address variable holding the PREVIOUS iteration's value and recorded
# the wrong contract against the wrong name.
deploy_one() {
  local name="$1" path="$2" raw rc addr tx
  set +e
  raw=$(forge create "${path}:${name}" \
    --rpc-url "$RPC" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --broadcast --json --confirmations 1 2>/tmp/recourse-forge-err)
  rc=$?
  set -e

  addr=$(printf '%s' "$raw" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.parse(s.trim()).deployedTo ?? ""); } catch { process.stdout.write(""); }
    });
  ' 2>/dev/null || true)
  tx=$(printf '%s' "$raw" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.parse(s.trim()).transactionHash ?? ""); } catch { process.stdout.write(""); }
    });
  ' 2>/dev/null || true)

  if [[ -z "$addr" ]]; then
    {
      echo "ERROR: could not determine a deployed address for $name (forge exit $rc)."
      echo "--- forge stdout ---"
      printf '%s\n' "$raw"
      echo "--- forge stderr ---"
      cat /tmp/recourse-forge-err 2>/dev/null || true
    } >&2
    return 1
  fi

  if [[ "$rc" -ne 0 ]]; then
    echo "  note: forge exited $rc but reported $addr; the chain decides below" >&2
  fi

  printf '%s %s' "$addr" "$tx"
}

mkdir -p deployments
NAMES=(RecourseEscrow)
PATHS=(contracts/src/RecourseEscrow.sol)

declare -a OUT_NAME OUT_ADDR OUT_TX

for i in "${!NAMES[@]}"; do
  n="${NAMES[$i]}"
  p="${PATHS[$i]}"
  echo "deploying $n"

  # Never reuse a stale value: clear, then require both fields.
  addr=""
  tx=""
  read -r addr tx < <(deploy_one "$n" "$p")
  [[ -n "$addr" ]] || {
    echo "ERROR: empty address for $n" >&2
    exit 1
  }
  echo "  address $addr"

  # Mined before anything else is sent, so nonces cannot race.
  wait_for_code "$addr"

  # The chain must hold the bytecode this artifact compiles to. Without this a
  # deploy of the wrong contract still passes every other check.
  node scripts/assert-runtime-bytecode.mjs "$addr" "out/$(basename "$p")/${n}.json" "$RPC"

  OUT_NAME+=("$n")
  OUT_ADDR+=("$addr")
  OUT_TX+=("$tx")
done

VERIFIED="{}"
if [[ -n "${BASESCAN_API_KEY:-}" ]]; then
  for i in "${!OUT_NAME[@]}"; do
    n="${OUT_NAME[$i]}"
    echo "verifying $n"
    if forge verify-contract "${OUT_ADDR[$i]}" "${PATHS[$i]}:${n}" \
      --chain "$CHAIN_ID" --etherscan-api-key "$BASESCAN_API_KEY" --watch >/dev/null 2>&1; then
      echo "  verified"
      VERIFIED=$(node -e 'const v=JSON.parse(process.argv[1]);v[process.argv[2]]=true;process.stdout.write(JSON.stringify(v))' "$VERIFIED" "$n")
    else
      echo "  verification failed, skipping as instructed"
      VERIFIED=$(node -e 'const v=JSON.parse(process.argv[1]);v[process.argv[2]]=false;process.stdout.write(JSON.stringify(v))' "$VERIFIED" "$n")
    fi
  done
else
  echo "no BASESCAN_API_KEY, skipping source verification"
fi

args=()
for i in "${!OUT_NAME[@]}"; do
  args+=("${OUT_NAME[$i]}" "${OUT_ADDR[$i]}" "${OUT_TX[$i]}")
done

node -e '
  const [, , chainId, explorer, deployer, verified, ...rest] = process.argv;
  const entries = [];
  for (let i = 0; i < rest.length; i += 3) {
    entries.push({ name: rest[i], address: rest[i + 1], txHash: rest[i + 2] });
  }
  const v = JSON.parse(verified);
  process.stdout.write(
    JSON.stringify(
      {
        chainId: Number(chainId),
        network: "base-sepolia",
        explorer,
        deployer,
        deployedAt: new Date().toISOString(),
        contracts: entries.map((e) => ({ ...e, verified: v[e.name] ?? false })),
      },
      null,
      2,
    ) + "\n",
  );
' "$CHAIN_ID" "$EXPLORER" "$DEPLOYER" "$VERIFIED" "${args[@]}" > "$OUT"

echo
echo "wrote $OUT"
echo "README.md is maintained by hand; update its Deployed section from $OUT"
