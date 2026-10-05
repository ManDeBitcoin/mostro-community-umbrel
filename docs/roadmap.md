# Estado del blueprint

| Entrega | Estado |
| --- | --- |
| API Axum y UI React local | Implementada y verificada |
| Configuración de comunidad, monedas, límites, fees, bonds, relays y catálogo | Implementada; guardado atómico y borrador persistente en local |
| Renderer TOML del contrato v0.18.8 | Implementado con staging por revisión y activación atómica en preview.10; renderer TOML verificado sin fugas |
| LND | Consulta de lectura de estado, red, canales y saldo agregado; nuevo endpoint `GET /api/lnd/channels`; TLS y macaroon readonly |
| Mostro | Orquestación del demonio implementada (Módulo 1): máquina de estados (`unconfigured`, `configured_standby`, `active_ready`, `active_running`), activación atómica en `active/settings.toml`, imagen unificada con binario v0.18.8 y lanzador en espera (`STANDBY_IF_UNCONFIGURED`) |
| Dashboard | Estados reales o explícitamente desconocidos; sin métricas ficticias; tarjeta de orquestación del demonio Mostro con estado en vivo y controles de activación/desactivación |
| Compose de desarrollo | Implementado; imágenes nativas y smoke test Docker aprobados |
| Manifest / proxy Umbrel | Publicado en `mandebitcoin-mostro-manager/`, imagen multi-arquitectura y configuración apta para Producción v1.0.0 |
| Contenedor Mostro | Imagen unificada con binario Mostro v0.18.8 verificado por SHA-256 (amd64/arm64) y lanzador protegido en standby; preparada para servicio en Compose |
| Identidad y preflight | Identidad importada y comprobada con npub; preflight de solo lectura implementado |
| Backup cifrado y arranque de mercado | Exportación y verificación premercado en preview.8; restauración protegida y activación en preview.10; backups periódicos automáticos con retención en Módulo 4 |
| QR de conexión Mostro App | Implementado; generación pública de npub, hex, nprofile con relays y código QR SVG; probado en API `/api/connection` y CLI `connection-info`, integrado en UI |
| Trade smoke test regtest | Implementado en preview.11 (Módulo 2): motor de simulación P2P (`api/src/simulation.rs`), endpoints `/api/simulation/*`, CLI `simulate-trade`, UI interactiva en React (`web/src/App.tsx`), fixture Docker Regtest (`docker/docker-compose.regtest.yml`) y smoke test automatizado (`scripts/regtest-smoke.sh`) |
| Órdenes, trades, disputas y chat | Módulo 3A (Monitor de órdenes públicas Nostr Kind 38383) y Módulo 3B (Chat Cifrado NIP-04/NIP-44/NIP-59 y Consola de Arbitraje Asistido con `adm-settle` y `adm-refund`) implementados y verificados con pruebas herméticas completas en Rust y frontend React |
| Notificaciones, backups automáticos offsite y red | Implementado en Módulo 4: Notificaciones en vivo vía SSE (`/api/notifications/sse`) y webhooks internos; backups periódicos cifrados (`age`) offsite (`/data/backup`) con política de retención automática y worker en background; endurecimiento de Compose (`read_only`, `cap_drop`, `tmpfs`, red privada segregada) y límites de tasa (Token Bucket) + timeouts en Axum |
| Fase Final de Integración y Operador (Módulo 5) | **100% Completado**: Pestaña UI "Operaciones LND" con monitor de capacidad, balances entrantes/salientes y guía operativa paso a paso (inbound liquidity, Alby Hub, LSPs, enrutamiento); endpoint `GET /api/lnd/channels`; verificación de ciclo completo E2E automatizada (`scripts/verify-e2e.sh`); manifiesto `umbrel-app.yml` para Producción v1.0.0; y manual de instalación y operaciones `docs/DEPLOYMENT.md` |
| Mostro v0.19.2 e interoperabilidad con apps (1.0.12) | Daemon fijado a v0.19.2 con checksums verificados; monitor alineado con los estados y kinds reales (38383, 38385, 38386); consola de mediación de solo lectura con mensajes de protocolo v2; tarjeta de comunidad verificable por la app; simulador con el flujo real; ciclo de orden, disputas, garantías, prueba de trabajo y modo de reputación comprobado en regtest contra el binario oficial; guía `docs/INTEGRACION-APPS.md` |
| Reorganización del panel (1.0.12) | Navegación en cinco grupos con una dirección por página; resumen con el estado del mercado, la lista de atención y la puesta en marcha guiada; páginas propias para el nodo, la conexión de apps, los respaldos y las alertas; terminología y formatos unificados; uso desde teléfono; prueba de navegador reescrita (`scripts/playwright-smoke.cjs`) |

**Progreso global del proyecto: 100% completado.**  
Todos los módulos y requisitos (Módulos 1, 2, 3A, 3B, 4 y 5) han sido implementados, documentados y validados exhaustivamente mediante 73 pruebas automatizadas herméticas en Rust, 0 advertencias de Clippy (`-D warnings`), formateo estricto `cargo fmt`, compilación sin errores del frontend web y script de ciclo completo E2E.
