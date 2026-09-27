# Estado del blueprint

| Entrega | Estado |
| --- | --- |
| API Axum y UI React local | Implementada |
| Configuración de comunidad, monedas, límites, fees, bonds, relays y catálogo | Borrador persistente; sin aplicar al daemon |
| Renderer TOML del contrato v0.18.8 | Implementado internamente; no desplegado |
| LND / Mostro | Adaptadores de consulta; integración real pendiente |
| Dashboard | Estados reales o explícitamente desconocidos; sin métricas ficticias |
| Compose de desarrollo | Implementado; imágenes nativas y smoke test Docker aprobados |
| Manifest / proxy Umbrel | Publicado en `mandebitcoin-mostro-manager/`, imagen multi-arquitectura pública y fijada por digest; preview.4 instalada y persistencia confirmada por el operador |
| Contenedor Mostro | Dockerfile con release/checksums fijados; no arrancado |
| Identidad | Importación local implementada en código; aún no incluida en preview.4 |
| Backup cifrado y arranque de mercado | Pendiente |
| QR de conexión Mostro App | Pendiente de identidad pública y formato compatible verificado |
| Trade smoke test regtest | Pendiente de fixture LND/Bitcoin/relay y cliente |
| Órdenes, trades, disputas y chat | Pendiente |
| Notificaciones, backups cifrados, updates y red | Pendiente |

Siguiente hito: preparar una instancia nueva conservando la identidad existente. El operador confirma que el Mostro anterior no completó pedidos y no dejó pedidos, disputas ni pagos pendientes. La importación local valida nsec/npub y guarda la clave con permisos privados, sin iniciar Mostro. Antes del arranque falta verificar que no haya otro daemon con la misma identidad (la consulta a Docker anidado no pudo conectarse), comprobar LND y completar el ciclo de vida en regtest. No borrar datos anteriores.
