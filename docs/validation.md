# Validación de esta entrega

Comprobaciones ejecutadas el 2026-09-27:

- `cargo test --workspace --locked`: 8 tests pasan. Incluyen configuración inválida, campos desconocidos/secretos, unidades y escape TOML, persistencia y copia previa, archivo corrupto, CSRF, conflicto de revisiones y estados de infraestructura sin configurar.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: sin advertencias.
- `cargo fmt --all -- --check`: correcto.
- `npm --prefix web run build`: TypeScript y Vite compilan.
- `docker compose config --quiet`: composición de desarrollo válida.
- Chromium headless sobre Vite + API reales, con `CONFIG_DIR` aislado en `/tmp`: carga dashboard, crea comunidad EUR y método de pago, guarda y verifica 0.6% → 60 bps y 30% → 3000 bps, recarga, comprueba persistencia, indicador de cambios y cancelación del descarte, y verifica anchura móvil de 390px sin desbordamiento. Sin errores JavaScript.

El test de navegador detectó y permitió corregir una incompatibilidad de Origin/Host del proxy de Vite. Se conserva Host con `changeOrigin: false`; la API sigue rechazando orígenes ajenos. La captura `screenshots/dashboard.png` muestra el estado inicial sin servicios conectados.

Pendiente: instalación final desde la UI de Umbrel, llamadas a LND/Mostro reales, regtest de trades/bonds, Mostro App, backup/restauración o upgrades. Esas integraciones siguen pendientes; no se ha tocado ningún nodo existente.

## Publicación del paquete Umbrel

La primera compilación de `v0.1.0-preview.1` se detuvo porque la imagen oficial de Rust no incluye rustfmt. La corrección instala explícitamente rustfmt y Clippy antes de ejecutar los checks. La publicación ahora exige verificar anónimamente el manifiesto multi-arquitectura, los manifiestos amd64/arm64, las configuraciones y el acceso HEAD a todas las capas. Una imagen privada o inexistente impide anunciar la release.

### Resultado de publicación — 0.1.0-preview.4

- [Workflow completo aprobado](https://github.com/ManDeBitcoin/mostro-community-umbrel/actions/runs/36302699252): builds nativas Linux amd64 y arm64, ocho tests Rust por arquitectura, formato, Clippy, build web y smoke test de contenedor.
- El smoke test verifica archivos estáticos, CSP, guardado por mismo origen, estado aislado y persistencia tras reiniciar Docker. Incluye inicialización del directorio raíz de datos y consulta del nuevo puerto temporal tras el reinicio.
- Chromium sobre la distribución estática real: guardado/recarga, fees, catálogo, cambios sin guardar y vista móvil sin errores.
- Verificación anónima repetida desde el servidor: HTTP HEAD/GET del índice, ambos manifiestos, configs y todas las capas. No requiere credenciales GHCR.
- Digest multi-arquitectura: `sha256:bbf12029ceb7f3e6f41ab26a676d1579609dd98176d1db99526b834aaf176a20`. Ambos servicios del paquete utilizan ese mismo digest.

## Conexión de lectura LND — preview.6

- Pruebas Rust: 16 pasan (siete unitarias, cuatro de configuración y cinco HTTP). Incluyen validación de URL TLS, preservación de satoshis como cadenas, ausencia de datos ficticios y transmisión bidireccional del puente TCP.
- Prueba HTTPS sintética: nueve escenarios, incluidos certificado no confiable, nombre TLS incorrecto, macaroon en cabecera, error de permiso, redirección, respuesta excesiva, saldo no disponible y resolución privada del puente.
- Compilación web y Clippy: correctos.
- Comprobación contra el LND real del operador: `online`, mainnet, cadena y grafo sincronizados y saldo de canales disponible. Se consultó con el macaroon readonly y TLS; no se mostraron ni guardaron credenciales o saldos en el registro de prueba.
- Puente TCP conectado al LND real desde un puerto local de prueba: mismo resultado `online`. El proceso de prueba se detuvo tras la comprobación.
- El workflow de publicación ejecuta la prueba HTTPS sintética dentro de cada imagen nativa, además del smoke test de persistencia y la verificación de descarga anónima.

## Preflight Mostro — preview.7

- 18 pruebas Rust pasan. El preflight lee el borrador y deriva únicamente el npub de la identidad importada; la prueba confirma que nunca incluye el nsec en la respuesta. No cambia datos.
- Clippy, formato Rust y compilación web: correctos.
- El binario oficial Mostro v0.18.8 para x86_64 coincidió con el SHA-256 fijado (`9fa0516a79270dec2dbe074f14cf988c0311a9d56c80f0a00a98e8d579b3cf53`) y respondió `mostro p2p 0.18.8` al ejecutar `--version` con `TERM=xterm`.
- Preflight local de la instalación real: borrador válido en revisión 4, identidad pública coincidente con el npub que proporcionó el operador, LND mainnet sincronizado y **cero canales activos**. El comando no imprimió secretos ni montó credenciales financieras.
- El workflow de publicación verifica el binario upstream en cada arquitectura. No ejecuta Mostro conectado a LND ni realiza pagos.

## Candidato TOML sin secretos — desarrollo posterior a preview.7

- El renderer fija `nsec_privkey` a una cadena vacía, deja RPC deshabilitado y no agrega un token RPC. Solo acepta un origen LND HTTPS sin credenciales y rutas absolutas para certificado y macaroon.
- Las pruebas comprueban el escape de texto, los porcentajes y que sobrevivan los límites upstream `allow_node_change=false`, `escrow_deadline_margin_blocks=24` y transporte `nip44`.
- `./scripts/check.sh` pasó: 18 pruebas Rust, Clippy sin advertencias, formato, build web y validación de Compose. La consulta al LND real y el arranque de Mostro quedan fuera de esta prueba.

## Lanzador privado de la imagen opcional — desarrollo posterior a preview.7

- `scripts/mostro-entrypoint-smoke.sh` pasa con un binario sintético: acepta identidad privada y settings presentes; rechaza permisos amplios, enlaces simbólicos, settings ausentes y el secreto pasado en el entorno de Docker.
- La CI ahora compila la imagen final de Mostro, comprueba `--version` y exige que rechace un arranque sin archivos. La imagen no se publica ni se incorpora a la aplicación Umbrel. La construcción Docker local no se pudo ejecutar desde este entorno sin la contraseña de `sudo`; la prueba de imagen real se comprobará en CI cuando se publique un tag.
- `scripts/verify-mostro-image.sh` permite al operador ejecutar esa misma prueba con `sudo` en el host. Se comprobó su sintaxis, el smoke del lanzador y el flujo del script con un Docker simulado; la construcción real queda pendiente de la ejecución con Docker privilegiado.

El operador ejecutó el script con `sudo` y obtuvo: `Verificación aprobada: imagen oficial v0.18.8 y arranque protegido.` La imagen de prueba se eliminó al finalizar; no se arrancó un servicio Mostro.

## Backup cifrado previo al mercado — desarrollo posterior a preview.7

- La API local puede exportar la identidad y el borrador en un archivo `age` con frase interactiva y permisos privados, y verifica el descifrado antes de publicar el archivo. `verify-backup` valida versión, `npub` derivado del `nsec` y configuración sin restaurar archivos.
- La prueba usa una identidad sintética, comprueba el viaje cifrado y descifrado, permisos de archivo/directorio y rechazo de una frase incorrecta. El mercado y LND no intervienen. La restauración de la configuración y el respaldo de la futura base de datos siguen pendientes.

## Publicación de preview.8

- [GitHub Actions aprobó](https://github.com/ManDeBitcoin/mostro-community-umbrel/actions/runs/36331949528) las imágenes nativas amd64 y arm64, las pruebas Rust, smoke de persistencia, conexión LND sintética y arranque protegido de la imagen opcional de Mostro.
- El manifiesto multi-arquitectura de Manager tiene digest `sha256:09834e540a209147e23040acdcbf1752f74b690cbce7420e004095813bab6aca`; la CI verificó acceso anónimo a los manifiestos y capas antes de crear la release.

## Restauración aislada — desarrollo posterior a preview.8

- La prueba con identidad sintética exporta el backup, lo restaura en un directorio nuevo, comprueba `npub`, revisión original y permisos 0700, y confirma que un destino existente permanece intacto.
- `./scripts/check.sh` pasa con 19 pruebas Rust, Clippy, build web, validación Compose y smoke del lanzador. No se restauró el backup real ni se cambió la instalación Umbrel.

## Preparación aislada de configuración Mostro — desarrollo posterior a preview.8

- `mostro-community-api stage-mostro-settings <origen>` genera un `settings.toml` inerte por revisión en `CONFIG_DIR/staging/revision-N/` con permisos `0700` de directorio y `0600` de archivo.
- Valida que el origen gRPC use HTTPS y puerto explícito, y rechaza rutas inseguras o preparar dos veces la misma revisión.
- No monta el macaroon financiero ni lee la identidad ni toca el daemon Mostro.
- `./scripts/check.sh` pasa con 21 pruebas Rust (incluyendo 2 de staging), Clippy sin advertencias, build web, validación Compose y smoke del lanzador.

## Publicación de preview.9

- [GitHub Actions aprobó](https://github.com/ManDeBitcoin/mostro-community-umbrel/actions/runs/36340721380) las imágenes nativas amd64 y arm64, 23 pruebas Rust por arquitectura, Clippy, build web, smoke de contenedor/persistencia, conexión LND sintética y arranque protegido de la imagen de Mostro.
- El manifiesto multi-arquitectura tiene digest `sha256:c0c14d416ecea7940f1ac11e5bdcc8bf6b2111bef87c6e5eb01b69f96107f2d0`; la CI y el host verificaron acceso anónimo a los manifiestos y capas antes de fijarlo en Umbrel.
- La versión incluye endpoint `GET /api/connection`, CLI `connection-info`, tarjeta web con QR en SVG, `nprofile` y `nostr:` URI para conexión directa con Mostro App.

## Orquestación del Demonio Mostro (Módulo 1) — preview.10

- 27 pruebas Rust pasan (`cargo test --workspace --locked`). Se agregaron pruebas para la máquina de estados de `daemon.rs` (`unconfigured`, `configured_standby`, `active_ready`, `active_running`), ciclo de vida completo de activación y desactivación atómica, y endpoints HTTP `/api/daemon/*` con protección contra CSRF.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: 0 advertencias.
- `cargo fmt --all -- --check`: correcto.
- `npm --prefix web run build`: TypeScript y Vite compilan correctamente con los nuevos tipos y tarjeta de control de orquestación.
- `scripts/mostro-entrypoint-smoke.sh`: pasa exitosamente validando el modo de espera `STANDBY_IF_UNCONFIGURED=true`, el rechazo de enlaces simbólicos, permisos laxos y variables de entorno con secretos.
- `Dockerfile.umbrel` unificado: integra la descarga y comprobación de checksums SHA-256 oficiales del binario `mostrod` v0.18.8 para amd64 y arm64 (`9fa0516a...` y `034af649...`), instalando tanto el daemon Mostro como la API y la UI en la misma imagen para evitar duplicidad de repositorios en GHCR.
- Tarjeta de control web: muestra estado en vivo, revisión activa, advertencia de falta de canales LND y acciones de activación/desactivación sin comprometer la seguridad ni revelar el `nsec`.

## Simulación de Ciclo Completo P2P y Fixture Regtest (Módulo 2) — preview.11

- 31 pruebas Rust pasan (`cargo test --workspace --locked`): 10 unitarias en lib, 4 de configuración, 2 de conexión, 3 de daemon/orquestación, 6 de HTTP, 2 de staging y 4 nuevas pruebas de integración de simulación (`api/tests/simulation.rs`).
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: 0 advertencias.
- `cargo fmt --all -- --check`: correcto.
- `npm --prefix web run build`: TypeScript y Vite compilan correctamente con la interfaz del Simulador P2P, desglose financiero satoshi/fiat, actor badges y trazabilidad cronológica.
- Motor de simulación (`api/src/simulation.rs`): soporta 4 escenarios clave (`HappyPath`, `DisputeSettledForBuyer`, `DisputeRefundedToSeller`, `SellerCancellation`), cálculo matemático exacto de fees (`fee_bps`) y bonds (`bond_bps` + `base_bond_sats`, según `BondApply`), eventos Nostr cifrados (Kind 4 / Kind 38383) y ciclo de facturas Lightning Hold Invoices (`OPEN` -> `ACCEPTED` -> `SETTLED` / `CANCELED`).
- Endpoints HTTP seguros: `GET /api/simulation/scenarios` y `POST /api/simulation/run` protegidos con validación de cabecera `X-Requested-With: mostro-community`.
- CLI `simulate-trade`: permite ejecutar simulaciones locales parametrizadas desde terminal (`happy-path`, `dispute-buyer`, `dispute-seller`, `cancel`) con desglose satoshi completo.
- Fixture Docker Regtest (`docker/docker-compose.regtest.yml`): composición aislada para pruebas locales que integra Bitcoin Core 26 (regtest), Nostr RS Relay (puerto 7777), LND Alice (Mostro) y LND Bob (contraparte) en red bridge privada sin colisionar con Umbrel.
- Smoke test automatizado (`scripts/regtest-smoke.sh`): ejecuta validación de Compose, las 4 simulaciones CLI, las 4 suites de tests Rust y el build de frontend en un único script reproducible.

## Monitor de Órdenes Nostr de Solo Lectura y Auditoría de Comisiones (Módulo 3A) — Desarrollo Actual

- **49 pruebas Rust automáticas aprobadas** (`cargo test --workspace --locked`):
  - 11 unitarias en `src/lib.rs` (permisos y rechazo de symlinks en `mostro.pub`, validación de pares de claves, balances LND sin inventar ceros, túnel TCP bidireccional y backups cifrados).
  - 4 de configuración (`tests/configuration.rs`).
  - 2 de conexión e identidad (`tests/connection.rs`).
  - 3 de orquestación del daemon (`tests/daemon.rs`).
  - 13 de contratos HTTP (`tests/http.rs`), incluyendo no fuga de secretos en `GET /api/orders` y headers de protección.
  - 7 de integración real WebSocket del monitor (`tests/orders.rs`) con relay local `tokio-tungstenite`: suscripción con autor HEX, filtros EOSE, pre-EOSE stale, desempate y reemplazo de eventos, tombstones de órdenes cerradas para evitar replay de eventos pendientes viejos, preservación de snapshot tras desconexión, failover multi-relay a estado degradado y canal `watch` de reconfiguración con limpieza selectiva.
  - 7 de simulación matemática de comisiones y Hold Invoices (`tests/simulation.rs`): validación de 10,000 sats / 25 bps => 13 por parte y 26 total, casos cero/medio satélite/100M sats, y resolución explícita de facturas en disputas.
  - 2 de staging (`tests/staging.rs`).
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: 0 errores, 0 advertencias.
- `cargo fmt --all -- --check`: formato verificado y limpio (código de salida 0).
- `npm --prefix web run build`: compilación de TypeScript y Vite exitosa con 0 errores (código de salida 0).
- Smoke test sintético (`scripts/simulation-smoke.sh`): validación sintáctica de Compose regtest, 4 simulaciones CLI con verificaciones estrictas de error ante montos negativos/cero/argumentos sobrantes, tests de integración y build web (código de salida 0).
- **Prueba End-to-End con Playwright** (`scripts/playwright-smoke.cjs`):
  - Servidor API Axum real sirviendo la distribución estática de Vite en puerto dinámico efímero.
  - Relay WebSocket local simulado con `mostro-community-api mock-relay`.
  - Navegación al Dashboard y ejecución del simulador rápido: comprobación de ausencia de `TypeError` en `total_mostro_fee_sats`.
  - Navegación al Simulador P2P completo: ejecución y verificación de desglose financiero y trazabilidad por pasos.
  - Navegación al Monitor de Órdenes: verificación del estado inicial vacío/desconectado.
  - Reconfiguración dinámica en caliente vía API PUT con el relay local: verificación de suscripción en tiempo real y renderizado exacto de orden (250,000 sats, 100 EUR, estado `pending`).
  - Verificación de filtros por tipo (`sell` vs `buy`) y estado de lista vacía filtrada.
  - Comprobación de viewport móvil responsivo a 390px x 844px sin desbordamiento horizontal (`scrollWidth <= innerWidth`).
  - 0 errores JavaScript de consola en toda la sesión del navegador (código de salida 0).
- Registros reproducibles de salida y códigos de salida guardados en:
  - `/tmp/mostro-final-fmt.log` (salida 0)
  - `/tmp/mostro-final-clippy.log` (salida 0)
  - `/tmp/mostro-final-tests.log` (salida 0)
  - `/tmp/mostro-final-web.log` (salida 0)
  - `/tmp/mostro-final-smoke.log` (salida 0)
  - `/tmp/mostro-final-playwright.log` (salida 0)

## Chat Cifrado y Consola de Arbitraje Asistido (Módulo 3B) — Desarrollo Actual

- **57 pruebas Rust automáticas aprobadas** (`cargo test --workspace --locked`):
  - 11 unitarias en `src/lib.rs` (permisos y symlinks en `mostro.pub`, validación de pares de claves, balances LND sin inventar ceros, túnel TCP bidireccional, backups cifrados).
  - 8 de integración hermética de chat cifrado (`tests/chat.rs`):
    - `test_kind4_nip04_valid_decryption_and_cache`: descifrado hermético de eventos NIP-04 Kind 4 con tag `["e", order_id]` y verificación en caché en memoria.
    - `test_kind4_nip44_decryption`: soporte y descifrado de payloads NIP-44.
    - `test_kind1059_gift_wrap_decryption`: desempaquetado hermético de NIP-59 GiftWrap (Kind 1059), verificación de seal y rumor interno.
    - `test_kind4_nip04_sent_by_community`: manejo correcto de mensajes originados por la identidad de la comunidad (`is_from_me = true`).
    - `test_invalid_events_are_rejected`: rechazo de eventos con firmas inválidas, autores no coincidentes o payloads corruptos.
    - `test_chat_cache_ordering_and_limits`: ordenación cronológica por `created_at`, deduplicación por ID de evento y límites acotados de capacidad en memoria.
    - `test_http_chat_endpoint_contract`: endpoint protegido `GET /api/chat/:order_id` con validación UUID estricta y cabecera CSRF `X-Requested-With: mostro-community`.
    - `test_chat_worker_with_mock_relay`: suscripción WebSocket en background con relay mock local enviando eventos Kind 4 y validando recepción sin redes externas.
  - 4 de configuración (`tests/configuration.rs`).
  - 2 de conexión e identidad (`tests/connection.rs`).
  - 3 de orquestación del daemon (`tests/daemon.rs`).
  - 13 de contratos HTTP (`tests/http.rs`).
  - 7 de integración real WebSocket del monitor (`tests/orders.rs`).
  - 7 de simulación matemática de comisiones y Hold Invoices (`tests/simulation.rs`).
  - 2 de staging (`tests/staging.rs`).
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: 0 errores, 0 advertencias.
- `cargo fmt --all -- --check`: formato verificado y limpio (código de salida 0).
- `npm --prefix web run build`: compilación de TypeScript y Vite exitosa con 0 errores (código de salida 0).
- Consola de Mediación en UI React (`web/src/App.tsx`):
  - Nueva vista accesible desde navegación lateral (`Mediación`), topbar y enlace directo desde el Monitor de Órdenes (`Ir a Consola de Mediación` o botón `Mediar` en órdenes en estado `dispute`).
  - Visualización del historial de chat descifrado con identificación de remitente (`Comprador`, `Vendedor`, `Mediador`, `Mostro`, o `Comunidad`), marcas de tiempo y etiquetas de cifrado (`NIP-04`, `NIP-59 / NIP-44`).
  - Selector y buscador rápido por UUID de disputa y chips de disputas activas.
  - Bosquejo interactivo de acciones de arbitraje asistido (`adm-settle` para liquidar a favor del comprador y `adm-refund` para devolver al vendedor).
- Reporte detallado generado en `/tmp/mostro-gemini-module3b-report.md`.

## Notificaciones de Eventos, Backups Automáticos Offsite y Endurecimiento de Red (Módulo 4) — Desarrollo Actual

- **63 pruebas Rust automáticas aprobadas** (`cargo test --workspace --locked`):
  - 16 unitarias en `src/lib.rs`:
    - Permisos y rechazo de symlinks en `mostro.pub` y claves privadas (`identity.rs`).
    - Balances LND de precisión satoshi y orígenes HTTPS estrictos (`lnd.rs`).
    - Túnel TCP bidireccional LND (`tunnel.rs`).
    - Detección de liquidez y preflight sin fugas de secretos (`preflight.rs`).
    - Cifrado simétrico `age` y rechazo de passphrases cortas (`backup.rs`).
    - Exportación a carpeta secundaria personalizada y retención automática (`backup.rs`).
    - Inicialización de constructores y helpers de alertas (`notifications.rs`).
    - Capacidad y comportamiento de búfer circular acotado a 50 eventos (`notifications.rs`).
    - Publicación y recuperación de eventos recientes en `NotificationHub` (`notifications.rs`).
  - 8 de integración hermética de chat cifrado (`tests/chat.rs`).
  - 4 de configuración (`tests/configuration.rs`).
  - 2 de conexión e identidad (`tests/connection.rs`).
  - 3 de orquestación del daemon (`tests/daemon.rs`).
  - 16 de contratos HTTP (`tests/http.rs`):
    - Incluye `notifications_endpoint_returns_recent_and_sse_headers` (verificación de array JSON y headers de streaming `text/event-stream`).
    - Incluye `backup_status_and_trigger_contracts` (consulta de estado y disparo manual seguro con cabecera CSRF).
    - Incluye `rate_limiting_enforces_limits_and_returns_429` (bloqueo determinista al superar cuota y cabecera `Retry-After`).
  - 5 de integración y ciclo de vida de Módulo 4 (`tests/module4.rs`):
    - `test_notifications_broadcast_and_sse_stream`: difusión multicanal y consumo continuo vía stream SSE.
    - `test_relay_down_notification_emitted_on_connection_failure`: emisión automática de alerta `relay_alert` ante fallo de conexión con relay.
    - `test_dispute_notification_emitted_by_order_monitor`: emisión de alerta `dispute_alert` en tiempo real cuando una orden pasa a estado `dispute`.
    - `test_rate_limiter_token_replenishment`: reabastecimiento continuo del algoritmo Token Bucket.
    - `test_auto_backup_cycle_and_retention_policy`: ciclo completo de respaldo periódico cifrado con age y poda determinista conservando exactamente la cuota de retención configurada.
  - 7 de integración real WebSocket del monitor (`tests/orders.rs`).
  - 7 de simulación matemática de comisiones y Hold Invoices (`tests/simulation.rs`).
  - 2 de staging (`tests/staging.rs`).
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: 0 errores, 0 advertencias.
- `cargo fmt --all -- --check`: formato verificado y limpio (código de salida 0).
- `npm --prefix web run build`: compilación de TypeScript y Vite exitosa con 0 errores (código de salida 0).
- Endurecimiento de red y contenedores (`mandebitcoin-mostro-manager/docker-compose.yml`):
  - Servicio `mostro`: `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`.
  - Servicio `init`: inicialización y permisos `0700` para `/data/backup`, `cap_drop: [ALL]`, `cap_add: [CHOWN, FOWNER, DAC_OVERRIDE]`.
  - Red privada segregada `manager_private` para aislamiento estricto de los contenedores de la aplicación.
  - Rate limiting en API Axum: algoritmo Token Bucket (60 tokens/minuto por cliente IP) con respuesta `429 Too Many Requests` y cabecera `Retry-After`.
  - Timeout middleware global a 30s con respuesta `504 Gateway Timeout`, con exclusión selectiva de `/api/notifications/sse` (que cuenta con `KeepAlive` a 15s) para evitar desconexiones prematuras de streaming.
- Interfaz de Usuario React (`web/src/App.tsx`):
  - Tarjeta en Dashboard **Alertas y Notificaciones de Eventos (SSE en vivo)**: suscripción automática a `/api/notifications/sse`, indicador visual en tiempo real de estado SSE (`En vivo (SSE)` vs `Desconectado`), badges por severidad (`info`, `warning`, `critical`), filtrado y marcas de tiempo relativas.
  - Tarjeta en Dashboard **Backups Automáticos Offsite y Persistencia**: telemetría en vivo del worker (`Activo / Periódico`), conteo de backups retenidos, último backup generado, botón para forzar backup inmediato (`POST /api/backup/trigger`) y listado histórico con fechas y tamaños.
- Reporte detallado generado en `/tmp/mostro-gemini-module4-report.md`.


