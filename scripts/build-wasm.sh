#!/usr/bin/env bash
# Build the on-chain wasm. `--cfg near` selects NEAR host functions.
# A plain `cargo build --target wasm32-unknown-unknown` without that cfg
# compiles pure-Rust fallbacks that are not valid on chain.
#
# Panic locations keep source paths. Those paths differ between a laptop
# (`/usr/local/cargo/...`) and GitHub Actions (`/home/runner/.cargo/...`),
# so the script remaps the Cargo registry, the workspace, and the sysroot
# onto fixed prefixes before rustc runs. CI byte-compares the result.
set -euo pipefail
cd "$(dirname "$0")/.."

flags=(--cfg near)
# rustc keeps the last matching --remap-path-prefix, so broader prefixes
# come first and the crates.io checkout (which includes a machine-independent
# but still unstable index hash) comes last.
sysroot="$(rustc --print sysroot)"
if [[ -n "$sysroot" ]]; then
  flags+=(--remap-path-prefix "${sysroot}=/rust-sysroot")
fi
flags+=(--remap-path-prefix "$(pwd)=/workspace")
cargo_home="${CARGO_HOME:-${HOME}/.cargo}"
if [[ -d "$cargo_home" ]]; then
  flags+=(--remap-path-prefix "${cargo_home}=/cargo")
fi
if [[ -d "${cargo_home}/registry/src" ]]; then
  shopt -s nullglob
  for root in "${cargo_home}/registry/src"/*; do
    flags+=(--remap-path-prefix "${root}=/cargo/registry")
  done
  shopt -u nullglob
fi

export CARGO_INCREMENTAL=0
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
export RUSTFLAGS="${flags[*]}"

cargo build -p near-agent-arena --target wasm32-unknown-unknown --release --locked
wasm="target/wasm32-unknown-unknown/release/near_agent_arena.wasm"
bytes=$(wc -c < "$wasm" | tr -d ' ')
echo "wasm: $wasm ($bytes bytes)"
