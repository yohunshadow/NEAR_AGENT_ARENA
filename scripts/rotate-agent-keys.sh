#!/usr/bin/env bash
# Rebuild ~/.near-credentials/near-agent-arena-keys.json from the function-call
# keys of an arena that is already deployed.
#
# near-cli does not overwrite <account>.json, so that file stays the full-access
# key from create-account. This script reads
# ~/.near-credentials/<network>/<agent>/ed25519_*.json and skips any key whose
# public_key matches <agent>.json.
#
# Required env:
#   ARENA_ACCOUNT
#
# Optional env:
#   NETWORK            default testnet
#   KEYS_OUT           default ~/.near-credentials/near-agent-arena-keys.json
#   DELETE_FULL_ACCESS set to 1 to delete each agent's full-access key on chain
#                      and rename <agent>.json aside. Default is off.
#
# Deletion is signed with the full-access file itself (a function-call key
# cannot delete keys). Private keys are never printed.

set -euo pipefail

: "${ARENA_ACCOUNT:?Set ARENA_ACCOUNT to the deployed arena account}"
NETWORK="${NETWORK:-testnet}"
DELETE_FULL_ACCESS="${DELETE_FULL_ACCESS:-0}"
KEYS_OUT="${KEYS_OUT:-${HOME}/.near-credentials/near-agent-arena-keys.json}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CREDS="${HOME}/.near-credentials/${NETWORK}"
AGENTS=(
  "momentum.${ARENA_ACCOUNT}"
  "mean-reversion.${ARENA_ACCOUNT}"
  "breakout.${ARENA_ACCOUNT}"
)

python3 "$SCRIPT_DIR/agent_keys.py" \
  --network "$NETWORK" \
  --credentials "$CREDS" \
  --arena "$ARENA_ACCOUNT" \
  --agent "${AGENTS[0]}" \
  --agent "${AGENTS[1]}" \
  --agent "${AGENTS[2]}" \
  --out "$KEYS_OUT"

if [[ "$DELETE_FULL_ACCESS" != "1" ]]; then
  echo "Left each agent's full-access key in place. Re-run with DELETE_FULL_ACCESS=1 to remove them."
  exit 0
fi

if ! command -v near >/dev/null 2>&1; then
  echo "near-cli-rs is required to delete full-access keys." >&2
  exit 1
fi

for agent in "${AGENTS[@]}"; do
  cred="${CREDS}/${agent}.json"
  if [[ ! -f "$cred" ]]; then
    echo "No ${cred} to delete; skipping ${agent}."
    continue
  fi
  public="$(python3 - "$cred" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
public = data.get("public_key")
if not public:
    raise SystemExit("missing public_key")
print(public)
PY
)"
  echo "Deleting full-access key ${public} from ${agent}"
  near account delete-keys "$agent" \
    public-keys "$public" \
    network-config "$NETWORK" \
    sign-with-access-key-file "$cred" \
    send
  mv "$cred" "${cred}.deleted-full-access"
  chmod 600 "${cred}.deleted-full-access"
done

echo "Full-access keys removed. Function-call keys were not touched."
