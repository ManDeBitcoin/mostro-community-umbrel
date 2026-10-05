# Fronteras upstream

Implementación inicial en `api/src/adapters.rs`:

- Mostro: cliente gRPC generado desde `config/upstream/admin.v0.19.0.proto`, idéntico byte a byte al de v0.19.2 (ver `config/upstream/README.md`); solo `GetVersion` utilizado. No operaciones financieras expuestas.
- LND: REST `/v1/getinfo`, certificado TLS verificado y macaroon de solo lectura cargados en backend. Se devuelve una lista explícita de campos, no la respuesta cruda.
- Bitcoin: aún sin adaptador directo. Estado `unknown`; no se infiere que Bitcoin esté sincronizado por una conexión TCP ni por el estado de LND.

Faltan adaptadores de lectura SQLite, Nostr administrativo, Watchdog y Push. El gRPC de Mostro no ofrece chat, lista de órdenes ni bond-resolution payload. No simular esas capacidades.
