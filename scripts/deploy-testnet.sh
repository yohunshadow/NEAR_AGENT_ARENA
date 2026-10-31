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
# 0.05 NEAR upkeep, 0.2 NEAR minimum to be alive. Init attaches 4 NEAR:
# 1 NEAR stays as the contract state buffer and the other 3 are split across agents.
UPKEEP="50000000000000000000000"
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
    save-to-keychain \
    sign-as "$ARENA_ACCOUNT" \
    network-config "$NETWORK" \
    sign-with-keychain \
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
  sign-with-keychain \
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
  sign-with-keychain \
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
    save-to-keychain \
    network-config "$NETWORK" \
    sign-with-keychain \
    send
done

python3 - "$NETWORK" "$ARENA_ACCOUNT" "${AGENTS[0]}" "${AGENTS[1]}" "${AGENTS[2]}" <<'PY'
import json, os, stat, sys
network, arena, a0, a1, a2 = sys.argv[1:]
home = os.path.expanduser(f"~/.near-credentials/{network}")

def load(account):
    path = os.path.join(home, f"{account}.json")
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    private = data.get("private_key") or data.get("secret_key")
    public = data.get("public_key")
    account_id = data.get("account_id", account)
    if not private or not public:
        raise SystemExit(f"{path} is missing public_key/private_key")
    return account_id, public, private

settler_id, settler_pub, settler_priv = load(arena)
agents = []
publics = []
for account in (a0, a1, a2):
    account_id, public, private = load(account)
    agents.append({"accountId": account_id, "privateKey": private})
    publics.append((account_id, public))

out = {
    "contractId": arena,
    "rpcUrl": "https://rpc.testnet.near.org",
    "networkId": network,
    "settler": {"accountId": settler_id, "privateKey": settler_priv},
    "agents": agents,
}
dest = os.path.expanduser("~/.near-credentials/near-agent-arena-keys.json")
with open(dest, "w", encoding="utf-8") as handle:
    json.dump(out, handle, indent=2)
    handle.write("\n")
os.chmod(dest, stat.S_IRUSR | stat.S_IWUSR)

print("Function-call public keys (secrets were not printed):")
print(f"  settler {settler_id} {settler_pub}")
for account_id, public in publics:
    print(f"  agent   {account_id} {public}")
print(f"Worker secret file, mode 600: {dest}")
print("Copy that file into the GitHub secret NEAR_AGENT_KEYS_JSON. Do not commit it.")
print("Full-access backups, if create-account saved one: ~/.near-credentials/" + network + "/<agent>.json.full-access")
PY
