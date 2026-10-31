#!/usr/bin/env bash
# Deploy NEAR Agent Arena on testnet with near-cli-rs.
#
# This script is meant to run on a machine that already has `near` (near-cli-rs)
# and credentials in ~/.near-credentials. It does not need a git checkout:
# download this file and contract/res/near_agent_arena.wasm (and SHA256SUMS).
#
# Required env:
#   ARENA_ACCOUNT   contract account that already exists, for example arena.testnet
#   OWNER_ACCOUNT   owner stored in the contract, for example your personal testnet account
#
# Optional env:
#   NETWORK         default testnet
#   KEYCHAIN_MODE   legacy (default) or os. Linux boxes without a Secret Service
#                   keyring fail on sign-with-keychain; legacy writes JSON files
#                   under ~/.near-credentials instead.
#   WASM_PATH       default: contract/res/near_agent_arena.wasm next to the repo root
#                   or beside this script's parent
#
# The script creates three sub-accounts, deploys the committed wasm, inits the
# arena, and adds a function-call key on each agent limited to commit and reveal.
# Settle stays permissionless and is signed later by ARENA_ACCOUNT's full-access
# key (the worker settler). Private keys are written only under ~/.near-credentials
# and are never printed.

set -euo pipefail

if ! command -v near >/dev/null 2>&1; then
  echo "near-cli-rs is required (the \`near\` binary)." >&2
  exit 1
fi

: "${ARENA_ACCOUNT:?Set ARENA_ACCOUNT to the existing testnet contract account}"
: "${OWNER_ACCOUNT:?Set OWNER_ACCOUNT to the owner account id}"
NETWORK="${NETWORK:-testnet}"
KEYCHAIN_MODE="${KEYCHAIN_MODE:-legacy}"
case "$KEYCHAIN_MODE" in
  legacy)
    SAVE_KEYCHAIN="save-to-legacy-keychain"
    SIGN_KEYCHAIN="sign-with-legacy-keychain"
    ;;
  os)
    SAVE_KEYCHAIN="save-to-keychain"
    SIGN_KEYCHAIN="sign-with-keychain"
    ;;
  *)
    echo "KEYCHAIN_MODE must be legacy or os (got ${KEYCHAIN_MODE})." >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_WASM="$SCRIPT_DIR/../contract/res/near_agent_arena.wasm"
WASM_PATH="${WASM_PATH:-$DEFAULT_WASM}"
if [[ ! -f "$WASM_PATH" ]]; then
  echo "Wasm not found at $WASM_PATH. Set WASM_PATH to the downloaded near_agent_arena.wasm." >&2
  exit 1
fi

SUMS="$(dirname "$WASM_PATH")/SHA256SUMS"
if [[ -f "$SUMS" ]]; then
  (
    cd "$(dirname "$WASM_PATH")"
    sha256sum -c SHA256SUMS
  )
  echo "sha256 ok: $WASM_PATH"
fi

CREDS="${HOME}/.near-credentials/${NETWORK}"
mkdir -p "$CREDS"
if [[ ! -f "${CREDS}/${ARENA_ACCOUNT}.json" ]]; then
  echo "Missing ${CREDS}/${ARENA_ACCOUNT}.json. Import that account before deploying." >&2
  exit 1
fi

# 20 minutes of betting and 10 minutes of reveal, so a 10-minute cron can hit
# commit, reveal, begin_settle, and a later finalize_settle.
BETTING_NS="1200000000000"
REVEAL_NS="600000000000"
# 0.0005 NEAR upkeep keeps a 1 NEAR treasury alive for about 41 days of
# 30-minute rounds. 0.2 NEAR minimum to be alive. Init attaches 4 NEAR:
# 1 NEAR stays as the contract state buffer and the other 3 are split across agents.
UPKEEP="500000000000000000000"
MIN_TREASURY="200000000000000000000000"

AGENTS=(
  "momentum.${ARENA_ACCOUNT}"
  "mean-reversion.${ARENA_ACCOUNT}"
  "breakout.${ARENA_ACCOUNT}"
)
NAMES=("Momentum" "Mean-Reversion" "Breakout")

echo "Arena:  ${ARENA_ACCOUNT}"
echo "Owner:  ${OWNER_ACCOUNT}"
echo "Agents: ${AGENTS[*]}"
echo "Network: ${NETWORK}"
echo "Fund ${ARENA_ACCOUNT} with at least 15 testnet NEAR before continuing."

for agent in "${AGENTS[@]}"; do
  echo "Creating ${agent}"
  near account \
    create-account fund-myself "$agent" '3 NEAR' \
    autogenerate-new-keypair \
    "$SAVE_KEYCHAIN" \
    sign-as "$ARENA_ACCOUNT" \
    network-config "$NETWORK" \
    "$SIGN_KEYCHAIN" \
    send
  cred="${CREDS}/${agent}.json"
  if [[ -f "$cred" ]]; then
    cp "$cred" "${cred}.full-access"
    chmod 600 "${cred}.full-access"
  fi
done

echo "Deploying wasm"
near contract \
  deploy "$ARENA_ACCOUNT" \
  use-file "$WASM_PATH" \
  without-init-call \
  network-config "$NETWORK" \
  "$SIGN_KEYCHAIN" \
  send

INIT_JSON="$(cat <<JSON
{"owner_id":"${OWNER_ACCOUNT}","agents":[{"account_id":"${AGENTS[0]}","name":"${NAMES[0]}"},{"account_id":"${AGENTS[1]}","name":"${NAMES[1]}"},{"account_id":"${AGENTS[2]}","name":"${NAMES[2]}"}],"betting_duration_ns":"${BETTING_NS}","reveal_duration_ns":"${REVEAL_NS}","upkeep":"${UPKEEP}","winner_fee_bps":500,"min_treasury":"${MIN_TREASURY}"}
JSON
)"

echo "Initializing arena"
near contract \
  call-function \
  as-transaction "$ARENA_ACCOUNT" new \
  json-args "$INIT_JSON" \
  prepaid-gas '100 Tgas' \
  attached-deposit '4 NEAR' \
  sign-as "$ARENA_ACCOUNT" \
  network-config "$NETWORK" \
  "$SIGN_KEYCHAIN" \
  send

echo "Adding commit/reveal function-call keys"
for agent in "${AGENTS[@]}"; do
  near account \
    add-key "$agent" \
    grant-function-call-access \
      --allowance '2 NEAR' \
      --contract-account-id "$ARENA_ACCOUNT" \
      --function-names 'commit,reveal' \
    autogenerate-new-keypair \
    "$SAVE_KEYCHAIN" \
    network-config "$NETWORK" \
    "$SIGN_KEYCHAIN" \
    send
done

python3 "$SCRIPT_DIR/agent_keys.py" \
  --network "$NETWORK" \
  --arena "$ARENA_ACCOUNT" \
  --agent "${AGENTS[0]}" \
  --agent "${AGENTS[1]}" \
  --agent "${AGENTS[2]}"
echo "Full-access copies, if create-account saved one: ${CREDS}/<agent>.json.full-access"
echo "The worker JSON uses each agent's function-call key, not <agent>.json."
