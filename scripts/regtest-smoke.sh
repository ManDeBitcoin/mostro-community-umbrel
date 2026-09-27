#!/usr/bin/env bash
set -euo pipefail

# Scripts to test and validate isolated regtest environment for Mostro Community Manager.
COMPOSE_FILE="docker/docker-compose.regtest.yml"

echo "=== Mostro Community Regtest Smoke Test ==="

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is required but not installed." >&2
  exit 1
fi

echo "[1/4] Validating Docker Compose Regtest definition..."
docker compose -f "${COMPOSE_FILE}" config >/dev/null
echo "✓ Docker Compose regtest config is valid."

echo "[2/4] Testing simulation scenarios via API CLI..."
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target}"
CONFIG_DIR="${CONFIG_DIR:-/home/umbrel/umbrel/app-data/mandebitcoin-mostro-manager/data/config}"

export CONFIG_DIR
cargo run --bin mostro-community-api -- simulate-trade happy-path 50000 >/dev/null
echo "✓ CLI HappyPath simulation succeeded."

cargo run --bin mostro-community-api -- simulate-trade dispute-buyer 20000 >/dev/null
echo "✓ CLI DisputeSettledForBuyer simulation succeeded."

cargo run --bin mostro-community-api -- simulate-trade dispute-seller 20000 >/dev/null
echo "✓ CLI DisputeRefundedToSeller simulation succeeded."

cargo run --bin mostro-community-api -- simulate-trade cancel 30000 >/dev/null
echo "✓ CLI SellerCancellation simulation succeeded."

echo "[3/4] Running Rust simulation tests..."
cargo test --test simulation --locked
echo "✓ All 4 integration test suites passed."

echo "[4/4] Verifying web production build with simulator..."
cd web && npm run build
echo "✓ Web build with simulator UI succeeded."

echo ""
echo "=== All Módulo 2 Regtest & Simulation quality checks passed! ==="
