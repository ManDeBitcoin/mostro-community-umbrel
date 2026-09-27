# Estado del blueprint

| Entrega | Estado |
| --- | --- |
| API Axum y UI React local | Implementada |
| Configuración de comunidad, monedas, límites, fees, bonds, relays y catálogo | Borrador persistente; sin aplicar al daemon |
| Renderer TOML del contrato v0.18.8 | Candidato sin nsec ni token RPC, RPC apagado; preparación privada por revisión en desarrollo, no desplegada |
| LND | Consulta real de lectura de estado, red, canales y saldo agregado; TLS y macaroon readonly; no habilita operaciones |
| Mostro | Adaptador RPC de lectura disponible; daemon y conexión pendientes |
| Dashboard | Estados reales o explícitamente desconocidos; sin métricas ficticias |
| Compose de desarrollo | Implementado; imágenes nativas y smoke test Docker aprobados |
| Manifest / proxy Umbrel | Publicado en `mandebitcoin-mostro-manager/`, imagen multi-arquitectura pública y fijada por digest; preview.9 publicada con conexión Mostro App (nprofile/QR), LND conectado y persistencia confirmada por el operador |
| Contenedor Mostro | Dockerfile con release/checksums fijados, TERM y terminfo; lanzador privado que exige identidad y settings, probado sin LND; aún no se instala en Umbrel |
| Identidad y preflight | Identidad importada y comprobada con npub; preflight de solo lectura implementado |
| Backup cifrado y arranque de mercado | Exportación y verificación premercado en preview.8; restauración y preparación TOML aisladas en desarrollo, sin aplicación a la instancia activa; DB y arranque pendientes |
| QR de conexión Mostro App | Implementado; generación pública de npub, hex, nprofile con relays y código QR SVG; probado en API `/api/connection` y CLI `connection-info`, integrado en UI |
| Trade smoke test regtest | Pendiente de fixture LND/Bitcoin/relay y cliente |
| Órdenes, trades, disputas y chat | Pendiente |
| Notificaciones, backups cifrados, updates y red | Pendiente |

Siguiente hito: preparar una instancia nueva conservando la identidad existente. El operador confirma que el Mostro anterior no completó pedidos y no dejó pedidos, disputas ni pagos pendientes. La importación local valida nsec/npub y guarda la clave con permisos privados, sin iniciar Mostro. El inventario Docker del host no muestra Mostro y el operador indica que Dockge no contiene contenedores relevantes. La consulta local tampoco muestra procesos `mostro` ni unidades `mostro*` en systemd de sistema o del usuario Umbrel. LND respondió mediante TLS y macaroon de lectura en mainnet con cadena/grafo sincronizados, pero reporta cero canales activos. Alby Hub está configurado con ese mismo LND y la clave pública del nodo coincide; el operador abrirá canales manualmente. Antes del arranque hay que comprobar capacidad Lightning local/remota, evaluar permisos financieros mínimos y completar el ciclo de vida en regtest. No borrar datos anteriores.
