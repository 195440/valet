#!/usr/bin/env bash
# Rebuild both contracts with cargo-near and refresh the committed artifacts in contracts/*/res.
# Needs Rust (stable, wasm32-unknown-unknown target) and cargo-near:
#   https://github.com/near/cargo-near#installation
# Node-only users do not need this: the prebuilt wasm files are committed under contracts/*/res.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

if ! cargo near --version >/dev/null 2>&1; then
  echo "cargo-near not found. Install it first: https://github.com/near/cargo-near#installation" >&2
  exit 1
fi

for name in guard registry; do
  dir="$root/contracts/$name"
  crate="valet_$name"
  (cd "$dir" && cargo near build non-reproducible-wasm)
  mkdir -p "$dir/res"
  cp "$dir/target/near/$crate.wasm" "$dir/res/$crate.wasm"
  (cd "$dir/res" && shasum -a 256 "$crate.wasm" | tee "$crate.wasm.sha256")
done
