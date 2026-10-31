#!/usr/bin/env python3
"""Build the worker keys file from legacy near-cli credentials.

near-cli writes the first key for an account (the full-access key created
with the sub-account) to ``~/.near-credentials/<network>/<account>.json`` and
does not overwrite that file. Later keys, including the commit/reveal
function-call key, are stored only as

``~/.near-credentials/<network>/<account>/ed25519_<public-key>.json``

with the colon in ``ed25519:`` replaced by ``_``.

The worker must sign ``commit`` and ``reveal`` with the function-call key.
The settler keeps the arena account's full-access key, because settlement is
permissionless and those methods are not on the function-call allowance.
Seed phrases are not copied. Private keys are written to the output file and
are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys


def load_key(path: str) -> tuple[str, str]:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    private = data.get("private_key") or data.get("secret_key")
    public = data.get("public_key")
    if not isinstance(public, str) or not isinstance(private, str) or not public or not private:
        raise SystemExit(f"{path} is missing public_key/private_key")
    return public, private


def function_call_key(cred_dir: str, account: str) -> tuple[str, str, str]:
    """Return ``(public_key, private_key, path)`` for the newest non-account key."""
    account_path = os.path.join(cred_dir, f"{account}.json")
    full_public = None
    if os.path.isfile(account_path):
        full_public, _private = load_key(account_path)
    directory = os.path.join(cred_dir, account)
    candidates: list[tuple[float, str, str, str]] = []
    if os.path.isdir(directory):
        for name in os.listdir(directory):
            if not (name.startswith("ed25519_") and name.endswith(".json")):
                continue
            path = os.path.join(directory, name)
            public, private = load_key(path)
            if full_public is not None and public == full_public:
                continue
            candidates.append((os.path.getmtime(path), public, private, path))
    if not candidates:
        raise SystemExit(
            f"no function-call key for {account} under {directory}. "
            f"Expected ed25519_*.json whose public_key differs from {account_path}."
        )
    candidates.sort()
    _mtime, public, private, path = candidates[-1]
    return public, private, path


def build_keys(cred_dir: str, network: str, arena: str, agents: list[str]) -> tuple[dict, list[tuple[str, str]]]:
    settler_path = os.path.join(cred_dir, f"{arena}.json")
    if not os.path.isfile(settler_path):
        raise SystemExit(f"missing settler credential {settler_path}")
    settler_public, settler_private = load_key(settler_path)
    agent_entries = []
    printed: list[tuple[str, str]] = [("settler", settler_public)]
    for account in agents:
        public, private, _path = function_call_key(cred_dir, account)
        agent_entries.append({"accountId": account, "privateKey": private})
        printed.append((account, public))
    payload = {
        "contractId": arena,
        "rpcUrl": "https://rpc.testnet.near.org",
        "networkId": network,
        "settler": {"accountId": arena, "privateKey": settler_private},
        "agents": agent_entries,
    }
    return payload, printed


def write_keys(path: str, payload: dict) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    descriptor = os.open(path, flags, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", default=os.environ.get("NETWORK", "testnet"))
    parser.add_argument("--credentials", default="")
    parser.add_argument("--arena", required=True)
    parser.add_argument("--agent", action="append", required=True, dest="agents")
    parser.add_argument(
        "--out",
        default=os.path.expanduser("~/.near-credentials/near-agent-arena-keys.json"),
    )
    args = parser.parse_args(argv)
    if len(args.agents) != 3:
        raise SystemExit("expected exactly 3 --agent values")
    cred_dir = args.credentials or os.path.expanduser(f"~/.near-credentials/{args.network}")
    payload, printed = build_keys(cred_dir, args.network, args.arena, args.agents)
    write_keys(args.out, payload)
    print("Public keys written into the worker file (secrets were not printed):")
    for account, public in printed:
        print(f"  {account} {public}")
    print(f"Worker secret file, mode 600: {args.out}")
    print("Copy that file into NEAR_AGENT_KEYS_JSON or point NEAR_AGENT_KEYS_FILE at it. Do not commit it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
