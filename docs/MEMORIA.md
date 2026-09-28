# Memoria del Proyecto: Mostro Community Manager for Umbrel

> **Fecha:** 2026-09-27  
> **Repositorio:** [ManDeBitcoin/mostro-community-umbrel](https://github.com/ManDeBitcoin/mostro-community-umbrel)  
> **Origen del contexto:** Traspaso desde sesión ChatGPT/OpenAI Codex (`https://chatgpt.com/s/cx_6ab957ef39e08191a2685d6194c5bf0e`, thread `01a0e0b9-21b9-7ca2-a806-2a9a18d98f56`), interrumpida por límite de tokens de uso (16:48 UTC). Continuidad inmediata y preservación de estado bajo Antigravity.

---

## 1. Visión del Producto y Arquitectura

**Mostro Community Manager** es una aplicación nativa para Umbrel diseñada para que cualquier operador cree, configure y administre su propia comunidad P2P sobre el protocolo Mostro, sin necesidad de mantener forks del software ni del cliente final.

- **Clientes finales:** Usan la **Mostro App oficial** conectándose al nodo Mostro mediante relays Nostr.
- **Motor P2P:** Daemon oficial upstream de Mostro (fijado a v0.18.8).
- **Infraestructura:** Bitcoin Core y nodo Lightning LND existentes en el Umbrel del operador.
- **Panel Administrativo:** UI en React + Vite servida por una API en Rust (Axum), integrada bajo el modelo de aplicaciones Umbrel (proxy reverso seguro, red privada `manager_private` y volúmenes persistentes).

```text
USUARIOS
   │
   ▼
Mostro App oficial (Nostr)
   │
   ▼
Mostro daemon (v0.18.8)
   │
  LND (Umbrel)
   │
Bitcoin Core (Umbrel)
─────────────────────────────────────────────
UMBREL APP STACK:
  ├── app_proxy: Proxy reverso Umbrel
  ├── lnd_bridge: Túnel localhost hacia LND REST
  ├── web: API Axum + Interfaz React
  ├── mostro: Contenedor opcional / daemon Mostro
  └── data/config: Almacenamiento privado (0700/0600)
```

---

## 2. Estado Actual y Cronología de Entregas

| Versión / Hito | Estado | Logros Clave |
| --- | --- | --- |
| **preview.1 a preview.7** | Desplegado | Configuración de comunidad, monedas fiat, métodos de pago, bonds, límites, fees; LND readonly REST/TLS; Docker multi-arch en GHCR. |
| **preview.8** (`v0.1.0-preview.8`) | Desplegado previamente | - Importación segura de identidad Nostr por CLI (`import-identity`).<br>- Identidad activa del operador importada y verificada: `npub1qqdagara05n9ahlrh5ah9xvgv9r2mpgd2yy4lemmwc7ryq2kskuswt0t3x`.<br>- LND en línea y sincronizado (0 canales activos).<br>- Exportación y verificación de backup pre-mercado cifrado con `age`: `/data/config/backups/pre-market-rev4-1790526552.age`.<br>- Verificación de imagen oficial Mostro v0.18.8 en host mediante `scripts/verify-mostro-image.sh` con `sudo` aprobada. |
| **preview.9** (`v0.1.0-preview.9`) | Desplegado previamente | - Manifiesto multi-arquitectura verificado: `sha256:c0c14d416ecea7940f1ac11e5bdcc8bf6b2111bef87c6e5eb01b69f96107f2d0`.<br>- Módulo `connection.rs`, endpoint `GET /api/connection`, CLI `connection-info`.<br>- Generación nativa de QR en SVG, URI `nostr:`, y `nprofile` con relays para Mostro App.<br>- Staging inerte de `settings.toml` (`stage-mostro-settings`) y restauración protegida en nuevo directorio (`restore-backup`).<br>- Suite de 23 tests aprobada con 0 advertencias de clippy y 0 fugas de secretos. |
| **preview.10** (`v0.1.0-preview.10`) | **Módulo 1 Completado** | - Módulo `daemon.rs` con máquina de estados (`unconfigured`, `configured_standby`, `active_ready`, `active_running`).<br>- Endpoints `GET /api/daemon/status`, `PUT /api/daemon/activate`, `PUT /api/daemon/deactivate` y CLI `daemon-status`, `activate-daemon`, `deactivate-daemon`.<br>- Activación atómica con `active/settings.toml` (0600) y digest SHA-256 sin filtrar credenciales.<br>- Imagen unificada Dockerfile.umbrel con binario oficial `mostrod` v0.18.8 verificado por SHA-256 (amd64 y arm64).<br>- Lanzador con espera pasiva `STANDBY_IF_UNCONFIGURED=true` en Compose evitando bucles de reinicio.<br>- Tarjeta UI de control del daemon con telemetría en vivo, alerta de falta de canales LND y acciones de activación.<br>- Suite ampliada a 27 tests automáticos, 0 advertencias de Clippy. |
| **preview.11** (`v0.1.0-preview.11`) | **Módulo 2 Completado** | - Motor de simulación P2P en Rust (`api/src/simulation.rs`) que modela los 4 escenarios esenciales (`HappyPath`, `DisputeSettledForBuyer`, `DisputeRefundedToSeller`, `SellerCancellation`).<br>- Cálculo matemático exacto de depósitos de garantía (bonds) y comisiones Mostro según la configuración real.<br>- Ciclo de vida completo de Lightning Hold Invoices (`OPEN` -> `ACCEPTED` -> `SETTLED` / `CANCELED`) y eventos Nostr Kind 4 / 38383.<br>- Endpoints `/api/simulation/scenarios` y `/api/simulation/run` con protección anti-CSRF.<br>- CLI interactiva `simulate-trade` para pruebas rápidas desde terminal.<br>- Tarjeta en Dashboard y Estudio Completo en pestaña `Simulador P2P` en React/Vite con desglose de satoshis y línea temporal con actor badges.<br>- Fixture Docker Regtest (`docker/docker-compose.regtest.yml`) y smoke test automatizado (`scripts/regtest-smoke.sh`).<br>- Suite ampliada a 31 tests automáticos, 0 advertencias de Clippy. |
| **Módulo 3A** | **Completado y Verificado** | - Auditoría y corrección matemática del reparto de comisiones upstream: redondeo exacto `((trade_sats * fee_bps + 10000)/20000)` por lado, total retenido coherente `2 * por_parte`, cálculo de comisión de desarrollo sobre total real y protección `u128` contra overflow.<br>- Sincronización JSON/TypeScript (`total_mostro_fee_sats`, `fee_per_side_sats`, `fee_sats`) eliminando fallos `TypeError` de formato en la interfaz.<br>- Resolución explícita de Hold Invoices aceptadas en todos los escenarios de disputa (`BuyerBondHoldInvoiceSettled`).<br>- Identidad pública segura (`mostro.pub`): permisos `0600` de archivo y `0700` de directorio, rechazo estricto de symlinks y directorios públicos, límite 256 bytes, validación `npub` previa y comando CLI `derive-public-identity`. Monitor opera exclusivamente con `npub` sin leer jamás `mostro.nsec`.<br>- Monitor Nostr de solo lectura en Rust (`api/src/orders.rs`): cliente WebSocket multi-relay anónimo, canal `watch` de configuración sin pérdida de mensajes, seguimiento por generaciones para invalidar escrituras obsoletas, caché acotada con tombstones para evitar reactivación por replay de órdenes viejas, y parseo estricto (firmas Schnorr, autor HEX, kind 38383, UUID, límites de tamaño, drift temporal +60s y expiración NIP-40 / `expires_at`).<br>- Estados honestos de conexión (`unconfigured`, `connecting`, `syncing`, `live`, `degraded`, `disconnected`) y flag `is_stale` riguroso (stale pre-EOSE y post-desconexión).<br>- Endpoint `GET /api/orders` con satoshis en string decimal seguro para JavaScript.<br>- Tests herméticos de integración WebSocket en Rust (`api/tests/orders.rs`): relay local simulado con `tokio-tungstenite`, suite ampliada a 49 tests aprobados.<br>- Verificación E2E Playwright (`scripts/playwright-smoke.cjs`): Chromium headless probando simulación real sin errores JS, navegación de órdenes, estado vacío inicial, recepción en vivo de orden desde relay local y diseño responsivo a 390px. |
| **Módulo 3B** | **Completado y Verificado** | - Módulo Rust `api/src/chat.rs` para mensajería cifrada Nostr (Kind 4 / NIP-04 y GiftWrap Kind 1059 con NIP-44 y NIP-59) dirigida a la identidad de la comunidad.<br>- Carga segura de claves en `identity.rs` respetando permisos 0700/0600, rechazo de symlinks y zeroización de secretos en memoria.<br>- Caché acotada en memoria (`ChatCache`) mapeada por `order_id` con deduplicación por `seen_event_ids` y ordenación cronológica estricta.<br>- Endpoint HTTP protegido `GET /api/chat/:order_id` con validación UUID, cabecera de protección CSRF `X-Requested-With: mostro-community` y matching de Host/Origin.<br>- Worker WebSocket de chat (`chat_worker`) suscrito a relays configurados con filtro Kind 4 y Kind 1059 dirigidos a la comunidad.<br>- Consola de Mediación en UI React (`web/src/App.tsx`) con navegación dedicada, visualización de historial de chat cifrado/descifrado, badges de remitente/formato, selector de órdenes en disputa y bosquejo de acciones de arbitraje `adm-settle` y `adm-refund`.<br>- 8 nuevos tests herméticos de integración (`api/tests/chat.rs`) con relay mock WebSocket local. Total suite: 57 tests aprobados, 0 advertencias clippy, 0 errores de compilación frontend. |
| **Módulo 4** | **Completado y Verificado** | - **Notificaciones de Eventos:** Hub centralizado (`NotificationHub`) con canal de difusión (`tokio::sync::broadcast`), búfer circular acotado a 50 eventos en memoria (`GET /api/notifications`), streaming en vivo vía Server-Sent Events con keep-alive a 15s (`GET /api/notifications/sse`) y soporte para webhooks POST no bloqueantes con timeout de 5s. Integración automática de alertas ante caídas/degradación de relays Nostr (`relay_alert`), nuevas órdenes en disputa (`dispute_alert`), backups automáticos y errores críticos.<br>- **Backups Automáticos Offsite:** Módulo `backup.rs` ampliado con exportación protegida a carpetas secundarias o compartidas (`/data/backup`), permisos estrictos (directorio `0700`, archivo `0600`), cifrado simétrico con `age`, política de retención automática determinista (`apply_retention_policy`, conservando los N backups más recientes y eliminando obsoletos por `mtime`), worker background periódico (`auto_backup_worker`), endpoints protegidos `GET /api/backup/status` y `POST /api/backup/trigger`, y comando CLI `auto-backup [target_dir]`.<br>- **Endurecimiento de Red y Contenedores:** `mandebitcoin-mostro-manager/docker-compose.yml` endurecido con `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]` en servicio `mostro`, inicialización y permisos 0700 en `/data/backup` vía servicio `init`, red privada segregada `manager_private`; rate-limiting por token bucket en memoria (`RateLimiter`, 60 req/min por IP devolviendo 429 Too Many Requests con cabecera `Retry-After`) y middleware de timeout global a 30s devolviendo 504 Gateway Timeout (segregando SSE para preservar el streaming continuo).<br>- **Interfaz React:** Tarjetas dedicadas en Dashboard para monitoreo de eventos en vivo SSE y administración de backups automáticos offsite con botón de disparo manual y visualización de retención.<br>- **Pruebas y Verificación:** Suite ampliada a 63 tests herméticos automatizados (`cargo test --workspace --locked`), 0 advertencias de Clippy con `-D warnings`, `cargo fmt` limpio y compilación web exitosa. |
| **Módulo 5 (Fase Final de Integración y Operador)** | **Completado y Verificado** | - **Operaciones LND y Gestión de Liquidez:** Nueva pestaña dedicada en React (`LiquidityOperationsPage`) con inspección en vivo de capacidad de canales, balance local y balance entrante (inbound liquidity), indicador de suficiencia de liquidez, barra de proporción visual, tabla detallada de canales abiertos y manual operativo paso a paso para el operador (regla de oro inbound vs outbound, Alby Hub, LSPs, apertura de canales salientes y activación).<br>- **Endpoint LND Canales:** Endpoint de solo lectura `GET /api/lnd/channels` en Axum con consulta real protegida a LND REST (`/v1/channels`), cálculo de balances agregados y soporte para modo demostración (`?mock=true` / `MOCK_LND_CHANNELS=1`).<br>- **Verificación de Ciclo Completo E2E:** Script integral de validación automatizada (`scripts/verify-e2e.sh`) que levanta el entorno mock, ejecuta 73 tests de Rust, compila el frontend web y valida con `curl` que los endpoints (`/api/health`, `/api/orders`, `/api/notifications/sse`, `/api/chat/:id`, `/api/backup/status`, `/api/lnd/channels`, `/api/simulation/scenarios`, `/`) responden de forma íntegra con protección anti-CSRF.<br>- **Manifiesto Umbrel Production 1.0.0:** Actualización de `mandebitcoin-mostro-manager/umbrel-app.yml` para versión de Producción v1.0.0 y elaboración del manual completo de instalación y administración `docs/DEPLOYMENT.md`.<br>- **Pruebas y Validación:** Suite ampliada a 73 tests herméticos aprobados (`cargo test --workspace --locked`), 0 advertencias de Clippy (`-D warnings`), `cargo fmt --all -- --check` limpio y verificación E2E en verde. |

---

## 3. Acuerdos Clave y Directivas del Operador

1. **Aplazamiento de tareas manuales al final del proyecto:**
   > *"Dejémoslo para al final del proyecto, así mismo para todo lo que requiera mi atención y deniega el desarrollo de la app. Anótalo."*
   - **Copia del backup por SCP:** La transferencia remota del archivo cifrado `.age` fuera del servidor queda disponible para el operador mediante el procedimiento documentado en `docs/DEPLOYMENT.md`.
   - **Canales Lightning:** Guía paso a paso y monitor de inbound liquidity disponibles en la interfaz web para apertura final en Alby Hub.
   - **Desarrollo 100% completado:** Todos los módulos desarrollados de forma autónoma con fixtures, mocks y pruebas herméticas sin requerir intervención ni detener el flujo.

2. **Autorización explícita:**
   > *"Procede, tienes mi permiso"*

3. **Invariantes de Seguridad Innegociables:**
   - **Secreto Absoluto:** El `nsec`, contraseñas de cifrado y macaroons financieros nunca se muestran en el frontend, logs, commits ni respuestas.
   - **Permisos Estrictos:** Directorios `0700` y archivos `0600`.
   - **Principio de Menor Privilegio LND:** El Manager solo monta `readonly.macaroon`.
   - **No Destructividad:** No se sobreescriben configuraciones activas existentes.
   - **Seguridad Financiera:** No se interactúa con redes reales que impliquen gasto de fondos; lecturas seguras y mocks locales.

---

## 4. Estado Final del Proyecto

1. **Desarrollo Completo:** Los Módulos 1, 2, 3A, 3B, 4 y 5 se encuentran finalizados al 100%.
2. **Entregables Verificados:**
   - Código fuente en Rust y React/TypeScript formateado y compilado sin errores.
   - 73 tests automatizados pasando en verde (`cargo test --workspace --locked`).
   - Verificación de ciclo completo aprobada mediante `scripts/verify-e2e.sh`.
   - Documentación exhaustiva en `docs/DEPLOYMENT.md`, `docs/roadmap.md`, `docs/validation.md` y `docs/MEMORIA.md`.
   - Todos los cambios permanecen en el árbol de trabajo local listos para revisión y commit del orquestador.

