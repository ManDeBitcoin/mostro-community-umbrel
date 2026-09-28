#!/usr/bin/env bash
set -euo pipefail

# Synthetic simulation smoke test for Mostro Community Manager.
# Operates entirely in memory and against an isolated temporary directory.
# Does NOT execute live regtest containers nor alter production/var config.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

echo "=== Mostro Community Manager: Synthetic Simulation Smoke Test ==="

# -----------------------------------------------------------------------------
# [Validación opcional previa] Fixture Regtest futuro (separada del smoke sintético)
# -----------------------------------------------------------------------------
echo "[Paso previo] Verificando fixture Compose para Regtest futuro..."
COMPOSE_FILE="docker/docker-compose.regtest.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "⊘ 'docker' no disponible en el sistema; omitiendo validación sintáctica de fixture."
elif ! docker compose version >/dev/null 2>&1; then
  echo "⊘ 'docker compose' plugin no disponible; omitiendo validación sintáctica de fixture."
else
  # Validación estricta de sintaxis YAML: falla con error si el fichero es inválido
  if ! docker compose -f "${COMPOSE_FILE}" config --quiet; then
    echo "Error: Validación de sintaxis de ${COMPOSE_FILE} falló!" >&2
    exit 1
  fi
  echo "✓ Sintaxis de ${COMPOSE_FILE} validada (fixture preservado; ciclo regtest en vivo pendiente)."
fi

# -----------------------------------------------------------------------------
# [Smoke Sintético] Entorno aislado temporal con permisos estrictos
# -----------------------------------------------------------------------------
TEMP_CONFIG_DIR="$(mktemp -d -t mostro-sim-smoke-XXXXXX)"
trap 'rm -rf "${TEMP_CONFIG_DIR}"' EXIT
chmod 700 "${TEMP_CONFIG_DIR}"

cat > "${TEMP_CONFIG_DIR}/community.json" << 'EOF'
{
  "revision": 1,
  "config": {
    "community": {
      "name": "Comunidad Sintética de Prueba",
      "about": "Entorno aislado para smoke test sintético",
      "website": "",
      "contact": "",
      "language": "es"
    },
    "market": {
      "fiat_currencies": ["EUR", "USD"],
      "min_trade_sats": 1000,
      "max_trade_sats": 1000000,
      "fee_bps": 60,
      "dev_fee_bps": 0,
      "max_routing_fee_bps": 10
    },
    "safety": {
      "bond_enabled": true,
      "bond_bps": 300,
      "base_bond_sats": 1000,
      "bond_apply_to": "both",
      "automatic_timeout_slash": true,
      "pow": 0,
      "pow_first_contact": 0
    },
    "nostr": {
      "relays": ["wss://relay.example.com"]
    },
    "payment_methods": [
      {
        "id": "synthetic_bank",
        "label": "Transferencia Sintética",
        "category": "bank",
        "active": true
      }
    ]
  }
}
EOF
chmod 600 "${TEMP_CONFIG_DIR}/community.json"

export CONFIG_DIR="${TEMP_CONFIG_DIR}"

echo "[1/3] Ejecutando simulación sintética y validaciones estrictas por CLI..."
cargo run --locked --bin mostro-community-api -- simulate-trade happy-path 50000 >/dev/null
echo "✓ CLI HappyPath ejecutado correctamente."

cargo run --locked --bin mostro-community-api -- simulate-trade dispute-buyer 20000 >/dev/null
echo "✓ CLI DisputeSettledForBuyer ejecutado correctamente."

cargo run --locked --bin mostro-community-api -- simulate-trade dispute-seller 20000 >/dev/null
echo "✓ CLI DisputeRefundedToSeller ejecutado correctamente."

cargo run --locked --bin mostro-community-api -- simulate-trade cancel 30000 >/dev/null
echo "✓ CLI SellerCancellation ejecutado correctamente."

# Validaciones estrictas de error ante entradas inválidas o ambiguas
if cargo run --locked --bin mostro-community-api -- simulate-trade invalid_scenario >/dev/null 2>&1; then
  echo "Error: CLI debió rechazar escenario no soportado!" >&2
  exit 1
fi
echo "✓ CLI rechaza estrictamente escenarios inválidos."

if cargo run --locked --bin mostro-community-api -- simulate-trade happy-path -500 >/dev/null 2>&1; then
  echo "Error: CLI debió rechazar montos negativos!" >&2
  exit 1
fi
echo "✓ CLI rechaza estrictamente montos negativos."

if cargo run --locked --bin mostro-community-api -- simulate-trade happy-path 0 >/dev/null 2>&1; then
  echo "Error: CLI debió rechazar montos en cero!" >&2
  exit 1
fi
echo "✓ CLI rechaza estrictamente montos iguales a cero."

if cargo run --locked --bin mostro-community-api -- simulate-trade happy-path 50000 extra_arg >/dev/null 2>&1; then
  echo "Error: CLI debió rechazar argumentos sobrantes!" >&2
  exit 1
fi
echo "✓ CLI rechaza estrictamente argumentos sobrantes."

echo "[2/3] Ejecutando tests de simulación y contratos HTTP en Rust..."
cargo test --locked --test simulation --test http
echo "✓ Tests de simulación y contratos HTTP aprobados."

echo "[3/3] Verificando compilación de producción web..."
(cd web && npm run build >/dev/null)
echo "✓ Compilación de web exitosa."

echo ""
echo "=== Smoke test sintético completado exitosamente! ==="
