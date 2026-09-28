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
| Órdenes, trades, disputas y chat | Módulo 3A (Monitor de órdenes públicas Nostr Kind 38383) y Módulo 3B (Chat Cifrado NIP-04/NIP-44/NIP-59 y Consola de Arbitraje Asistido con `adm-settle` y `adm-refund`) implementados y verificados con pruebas herméticas completas en Rust y frontend React |
| Notificaciones, backups automáticos offsite y red | Pendiente (Módulo 4 y fase final de operador) |

Siguiente hito: Módulo 4 (Notificaciones de eventos, backups automáticos offsite y endurecimiento de red). Los Módulos 3A y 3B están completamente implementados con control real de estado, timeouts, desempate determinista, descifrado hermético de mensajes en memoria y consola de arbitraje en UI, soportados por 57 pruebas herméticas sin interacción de red externa. Todos los cambios permanecen en el árbol local sin publicar.


