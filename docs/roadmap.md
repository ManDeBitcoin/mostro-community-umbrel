# Estado del blueprint

| Entrega | Estado |
| --- | --- |
| API Axum y UI React local | Implementada |
| Configuración de comunidad, monedas, límites, fees, bonds, relays y catálogo | Borrador persistente; sin aplicar al daemon |
| Renderer TOML del contrato v0.18.8 | Implementado con staging por revisión y activación atómica en preview.10; renderer TOML verificado sin fugas |
| LND | Consulta real de lectura de estado, red, canales y saldo agregado; TLS y macaroon readonly; no habilita operaciones |
| Mostro | Orquestación del demonio implementada (Módulo 1): máquina de estados (`unconfigured`, `configured_standby`, `active_ready`, `active_running`), activación atómica en `active/settings.toml`, imagen unificada con binario v0.18.8 y lanzador en espera (`STANDBY_IF_UNCONFIGURED`) |
| Dashboard | Estados reales o explícitamente desconocidos; sin métricas ficticias; tarjeta de orquestación del demonio Mostro con estado en vivo y controles de activación/desactivación |
| Compose de desarrollo | Implementado; imágenes nativas y smoke test Docker aprobados |
| Manifest / proxy Umbrel | Publicado en `mandebitcoin-mostro-manager/`, imagen multi-arquitectura pública y fijada por digest; preview.9 publicada; preview.10 incorpora servicio Mostro y orquestación |
| Contenedor Mostro | Imagen unificada con binario Mostro v0.18.8 verificado por SHA-256 (amd64/arm64) y lanzador protegido en standby; preparada para servicio en Compose en preview.10 |
| Identidad y preflight | Identidad importada y comprobada con npub; preflight de solo lectura implementado |
| Backup cifrado y arranque de mercado | Exportación y verificación premercado en preview.8; restauración protegida y activación en preview.10; DB y ciclo regtest en Módulo 2 |
| QR de conexión Mostro App | Implementado; generación pública de npub, hex, nprofile con relays y código QR SVG; probado en API `/api/connection` y CLI `connection-info`, integrado en UI |
| Trade smoke test regtest | Implementado en preview.11 (Módulo 2): motor de simulación P2P (`api/src/simulation.rs`), endpoints `/api/simulation/*`, CLI `simulate-trade`, UI interactiva en React (`web/src/App.tsx`), fixture Docker Regtest (`docker/docker-compose.regtest.yml`) y smoke test automatizado (`scripts/regtest-smoke.sh`) |
| Órdenes, trades, disputas y chat | Módulo 3A implementado en local (Monitor de órdenes públicas Nostr Kind 38383 de solo lectura y auditoría matemática de comisiones, verificado con tests herméticos WebSocket y Playwright E2E); Chat cifrado NIP-04/NIP-44, consola de mediación/arbitraje y ciclo regtest en vivo pendientes para Módulo 3B / Módulo 4 |
| Notificaciones, backups automáticos offsite y red | Pendiente (Módulo 4 y fase final de operador) |

Siguiente hito: Módulo 3B (Chat Cifrado NIP-04/NIP-44 y Consola de Arbitraje Asistido). Con el monitor de solo lectura Kind 38383 verificado exhaustivamente contra relays locales (sin firmar ni publicar eventos en la red ni exponer claves privadas), el siguiente paso abordará la mensajería cifrada de disputas para mediadores y las acciones de resolución de disputas (`adm-settle` / `adm-refund`). Todas las tareas manuales del operador (canales de pago Alby Hub y transferencia remota SCP del backup cifrado) continúan pospuestas al cierre final, preservando la seguridad de fondos y credenciales. Todos los cambios permanecen en el árbol de trabajo local (sin commits, push ni tags en Git).

