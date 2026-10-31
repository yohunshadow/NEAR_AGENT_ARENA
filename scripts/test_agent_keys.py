#!/usr/bin/env python3
"""The worker keys file must use function-call keys, not the account's first key."""

import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "agent_keys.py"


def write_cred(path: Path, public: str, private: str, extra: dict | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"public_key": public, "private_key": private}
    if extra:
        body.update(extra)
    path.write_text(json.dumps(body), encoding="utf-8")


def test_selects_function_call_key() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cred = Path(tmp) / "testnet"
        arena = "near-agent-arena-97b380.testnet"
        agents = [
            f"momentum.{arena}",
            f"mean-reversion.{arena}",
            f"breakout.{arena}",
        ]
        write_cred(cred / f"{arena}.json", "ed25519:SETTLER", "ed25519:settler-secret")
        for index, account in enumerate(agents):
            write_cred(
                cred / f"{account}.json",
                f"ed25519:FULL{index}",
                f"ed25519:full-secret-{index}",
                {"seed_phrase": "must not be copied"},
            )
            time.sleep(0.01)
            write_cred(
                cred / account / f"ed25519_FULL{index}.json",
                f"ed25519:FULL{index}",
                f"ed25519:full-secret-{index}",
            )
            time.sleep(0.01)
            write_cred(
                cred / account / f"ed25519_FC{index}.json",
                f"ed25519:FC{index}",
                f"ed25519:fc-secret-{index}",
                {"seed_phrase": "also not copied"},
            )
        out = Path(tmp) / "keys.json"
        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--network",
                "testnet",
                "--credentials",
                str(cred),
                "--arena",
                arena,
                "--agent",
                agents[0],
                "--agent",
                agents[1],
                "--agent",
                agents[2],
                "--out",
                str(out),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        assert "fc-secret" not in proc.stdout
        assert "full-secret" not in proc.stdout
        assert "settler-secret" not in proc.stdout
        assert "ed25519:FC1" in proc.stdout
        assert "ed25519:FULL" not in proc.stdout
        payload = json.loads(out.read_text(encoding="utf-8"))
        assert payload["contractId"] == arena
        assert payload["settler"]["privateKey"] == "ed25519:settler-secret"
        assert [row["privateKey"] for row in payload["agents"]] == [
            "ed25519:fc-secret-0",
            "ed25519:fc-secret-1",
            "ed25519:fc-secret-2",
        ]
        blob = out.read_text(encoding="utf-8")
        assert "seed_phrase" not in blob
        assert "must not be copied" not in blob
        mode = stat.S_IMODE(os.stat(out).st_mode)
        assert mode == 0o600, mode


if __name__ == "__main__":
    test_selects_function_call_key()
    print("agent key selection ok")
