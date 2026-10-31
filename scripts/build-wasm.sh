#!/usr/bin/env bash
# Build the on-chain wasm. `--cfg near` selects NEAR host functions.
# A plain `cargo build --target wasm32-unknown-unknown` without that cfg
# compiles pure-Rust fallbacks that are not valid on chain.
set -euo pipefail
cd "$(dirname "$0")/.."
RUSTFLAGS="--cfg near" cargo build -p near-agent-arena --target wasm32-unknown-unknown --release
wasm="target/wasm32-unknown-unknown/release/near_agent_arena.wasm"
bytes=$(wc -c < "$wasm" | tr -d ' ')
echo "wasm: $wasm ($bytes bytes)"
