#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
python3 -m unittest discover -s scripts/tests
npm --prefix web run build
docker compose config --quiet
sh scripts/mostro-entrypoint-smoke.sh
