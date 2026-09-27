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
| Trade smoke test regtest | Módulo 2: fixture LND/Bitcoin/relay y simulación de ciclo completo P2P |
| Órdenes, trades, disputas y chat | Pendiente |
| Notificaciones, backups cifrados, updates y red | Pendiente |

Siguiente hito: Módulo 2 (Fixture Regtest & Simulación del Ciclo Completo P2P). Tras completar la orquestación del demonio Mostro en preview.10, se implementará el entorno de pruebas regtest con Bitcoin Core, 2 nodos LND locales, relay Nostr sintético y clientes simulados para comprobar la creación de órdenes, hold invoices, depósitos de garantía (bonds), liberación y resolución de disputas antes de la puesta en marcha con fondos reales en mainnet. La identidad del operador y el backup pre-mercado permanecen intactos y protegidos bajo permisos 0700/0600.

