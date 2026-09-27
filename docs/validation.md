# Validación de esta entrega

Comprobaciones ejecutadas el 2026-09-27:

- `cargo test --workspace --locked`: 8 tests pasan. Incluyen configuración inválida, campos desconocidos/secretos, unidades y escape TOML, persistencia y copia previa, archivo corrupto, CSRF, conflicto de revisiones y estados de infraestructura sin configurar.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: sin advertencias.
- `cargo fmt --all -- --check`: correcto.
- `npm --prefix web run build`: TypeScript y Vite compilan.
- `docker compose config --quiet`: composición de desarrollo válida.
- Chromium headless sobre Vite + API reales, con `CONFIG_DIR` aislado en `/tmp`: carga dashboard, crea comunidad EUR y método de pago, guarda y verifica 0.6% → 60 bps y 30% → 3000 bps, recarga, comprueba persistencia, indicador de cambios y cancelación del descarte, y verifica anchura móvil de 390px sin desbordamiento. Sin errores JavaScript.

El test de navegador detectó y permitió corregir una incompatibilidad de Origin/Host del proxy de Vite. Se conserva Host con `changeOrigin: false`; la API sigue rechazando orígenes ajenos. La captura `screenshots/dashboard.png` muestra el estado inicial sin servicios conectados.

No ejecutado: build de imágenes Docker, instalación Umbrel, llamadas a LND/Mostro reales, regtest de trades/bonds, Mostro App, backup/restauración o upgrades. Esas integraciones siguen pendientes; no se ha tocado ningún nodo existente.
