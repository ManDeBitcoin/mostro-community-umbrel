# Estado del blueprint

| Entrega | Estado |
| --- | --- |
| API Axum y UI React local | Implementada |
| Configuración de comunidad, monedas, límites, fees, bonds, relays y catálogo | Borrador persistente; sin aplicar al daemon |
| Renderer TOML del contrato v0.18.8 | Implementado internamente; no desplegado |
| LND / Mostro | Adaptadores de consulta; integración real pendiente |
| Dashboard | Estados reales o explícitamente desconocidos; sin métricas ficticias |
| Compose de desarrollo | Implementado; imágenes nativas y smoke test Docker aprobados |
| Manifest / proxy Umbrel | Publicado en `mandebitcoin-mostro-manager/`, imagen multi-arquitectura pública y fijada por digest; instalación final del operador pendiente |
| Contenedor Mostro | Dockerfile con release/checksums fijados; no arrancado |
| Identidad, backup y arranque de mercado | Pendiente |
| QR de conexión Mostro App | Pendiente de identidad pública y formato compatible verificado |
| Trade smoke test regtest | Pendiente de fixture LND/Bitcoin/relay y cliente |
| Órdenes, trades, disputas y chat | Pendiente |
| Notificaciones, backups cifrados, updates y red | Pendiente |

Siguiente hito: ciclo de vida e identidad en regtest, aplicando configuración validada y verificando un trade completo antes de habilitar operaciones financieras en UI.
