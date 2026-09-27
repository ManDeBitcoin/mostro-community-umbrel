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

---

## 3. Acuerdos Clave y Directivas del Operador

1. **Aplazamiento de tareas manuales al final del proyecto:**
   > *"Dejémoslo para al final del proyecto, así mismo para todo lo que requiera mi atención y deniega el desarrollo de la app. Anótalo."*
   - **Copia del backup por SCP:** La transferencia remota del archivo cifrado `.age` fuera del servidor queda pendiente para el cierre final.
   - **Canales Lightning:** La apertura manual de canales vía Alby Hub se realizará al finalizar la integración.
   - **Cualquier otra intervención que bloquee:** Se desarrollará de forma autónoma con fixtures y entornos de prueba sintéticos sin detener el flujo.

2. **Autorización explícita:**
   > *"Procede, tienes mi permiso"*

3. **Invariantes de Seguridad Innegociables:**
   - **Secreto Absoluto:** El `nsec`, contraseñas de cifrado y macaroons financieros nunca deben mostrarse en el frontend, logs, commits ni respuestas.
   - **Permisos Estrictos:** Directorios `0700` y archivos `0600`.
   - **Principio de Menor Privilegio LND:** El Manager solo monta `readonly.macaroon`.
   - **No Destructividad:** No se sobreescriben configuraciones activas existentes.
   - **Seguridad Financiera:** No se abrirá mercado en mainnet sin verificación previa de ciclo completo en regtest.

---

## 4. Próximos Pasos Técnicos Inmediatos

1. Taggear y publicar `v0.1.0-preview.11` en GitHub y verificar build multi-arquitectura en GitHub Actions.
2. Promover `v0.1.0-preview.11` al repositorio local de Umbrel App Store con el simulador P2P integrado.
3. Iniciar **Módulo 3 (Monitor de Órdenes P2P en Vivo, Chat Cifrado y Resolución Asistida de Disputas)**:
   - Suscripción en tiempo real a relays Nostr para órdenes Kind 38383 de la comunidad.
   - Consola de arbitraje para el mediador (Solver) para emitir `adm-settle` y `adm-refund`.
   - Historial de transacciones y estados de facturas Lightning.

