#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible wrapper for regtest-smoke.sh.
# Nota: La ejecución en vivo contra contenedores regtest interactivos está pendiente.
# Se delega la verificación al smoke test sintético aislado (simulation-smoke.sh).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Aviso: Ejecutando verificación sintética de simulación (ciclo regtest en vivo pendiente)..."
exec "${SCRIPT_DIR}/simulation-smoke.sh" "$@"
