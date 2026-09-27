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
| **preview.8** (`v0.1.0-preview.8`) | **Instalado y Operativo en Umbrel** | - Importación segura de identidad Nostr por CLI (`import-identity`).<br>- Identidad activa del operador importada y verificada: `npub1qqdagara05n9ahlrh5ah9xvgv9r2mpgd2yy4lemmwc7ryq2kskuswt0t3x`.<br>- LND en línea y sincronizado (0 canales activos).<br>- Exportación y verificación de backup pre-mercado cifrado con `age`: `/data/config/backups/pre-market-rev4-1790526552.age`.<br>- Verificación de imagen oficial Mostro v0.18.8 en host mediante `scripts/verify-mostro-image.sh` con `sudo` aprobada. |
| **Post-preview.8 (Commit b75becc)** | En repositorio | Restauración aislada de backups en nuevos directorios sin sobreescribir la instancia activa. |
| **Staging de configuración Mostro** | Implementado | Módulo `staging.rs` y comando `stage-mostro-settings`: genera `settings.toml` inerte por revisión en directorio privado `0700/0600`. |
| **Conexión y QR Mostro App** | Implementado | Módulo `connection.rs`, endpoint `GET /api/connection`, CLI `connection-info`, generación nativa de QR en SVG, URI Nostr con `nprofile` y tarjeta en UI web sin exposición de secretos. Suite completa de 23 tests aprobada. |

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

1. Preparar fixture regtest y entorno de pruebas sintéticas para el ciclo completo de órdenes P2P de Mostro.
2. Evaluar y fijar permisos mínimos para el montaje financiero del daemon Mostro sin comprometer el Manager.
3. Smoke test de ciclo de vida completo (creación de orden, hold invoice, aceptación, liberación y resolución de disputas) en regtest antes del despliegue final.
