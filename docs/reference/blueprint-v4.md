# Mostro Community Manager for Umbrel
## Blueprint maestro para construir una aplicación Umbrel configurable para operadores de comunidades P2P

> **Estado:** Blueprint de producto y arquitectura
>
> **Objetivo:** construir una aplicación para Umbrel que permita a cualquier operador crear, configurar y administrar una comunidad P2P basada en Mostro, sin mantener forks profundos del protocolo ni del cliente de usuario final.
>
> **Cliente de usuario final:** Mostro App oficial.
>
> **Motor P2P:** Mostro daemon upstream.
>
> **Nodo Bitcoin/Lightning:** Bitcoin Core + LND existentes en Umbrel.
>
> **Administración:** interfaz web propia dentro de Umbrel.
>
> **Migración de una instalación existente:** fuera de alcance de este documento; se tratará como proyecto/fase independiente.

---

# 1. Resumen ejecutivo

El producto no es una nueva app para comprar y vender Bitcoin.

El producto es una **app de Umbrel para operadores de comunidades P2P**.

Cada operador instala la app en su Umbrel y configura su propia comunidad:

- nombre;
- logo;
- descripción;
- moneda(s);
- métodos de pago;
- límites;
- fees;
- bonds;
- relays;
- solvers;
- Telegram;
- exposición pública;
- políticas;
- contacto;
- reglas del mercado.

Los usuarios finales utilizan **Mostro App oficial** y se conectan al nodo Mostro del operador.

```text
USUARIO
  │
  ▼
Mostro App oficial
  │
  │ Nostr
  ▼
Mostro daemon
  │
  ▼
LND
  │
  ▼
Bitcoin Core

          Todo lo anterior administrado por:

             Mostro Community Manager
                      │
                    Umbrel
```

La app debe permitir a una persona no técnica operar un mercado P2P sin editar TOML, usar terminal, manejar gRPC manualmente o utilizar MostriX.

---

# 2. Problema que resuelve

Hoy un operador que quiere abrir una comunidad Mostro necesita comprender varias piezas técnicas:

- instalar/configurar Mostro;
- conectar LND;
- configurar Nostr;
- configurar fees;
- configurar bonds;
- administrar solvers;
- revisar disputas;
- ejecutar herramientas administrativas;
- configurar watchdog;
- configurar push;
- vigilar salud;
- realizar backups;
- gestionar upgrades;
- exponer servicios de red.

El producto convierte todo eso en una experiencia de Umbrel:

```text
Instalar
   ↓
Configurar comunidad
   ↓
Iniciar mercado
   ↓
Administrar desde navegador
```

---

# 3. Principios no negociables

## 3.1 Upstream-first

No mantener fork profundo de:

- Mostro daemon;
- Mostro App;
- Mostro Push Server;
- Mostro Watchdog.

Consumir releases oficiales y fijarlas por versión.

## 3.2 No reconstruir el protocolo

No implementar nuestra propia lógica de:

- escrow;
- hold invoices;
- Lightning settlement;
- bond settlement;
- Nostr protocol;
- ratings;
- dispute state machine.

## 3.3 La app es genérica

No debe contener una comunidad fija.

Todo lo que identifica una comunidad debe ser configurable.

## 3.4 Operación desde UI

El operador no debería necesitar SSH para tareas normales.

## 3.5 Seguridad financiera separada de UI

El navegador nunca debe recibir:

- nsec de Mostro;
- macaroon LND;
- secrets RPC;
- claves privadas de infraestructura.

## 3.6 Actualizaciones controladas

Detectar releases upstream automáticamente.

Nunca desplegar un upgrade del componente financiero principal sin tests y aprobación.

## 3.7 Multi-access

Soportar:

- LAN local;
- Tailscale;
- VPS + WireGuard.

Ninguna ruta debe ser obligatoria para el funcionamiento interno del nodo.

---

# 4. Componentes upstream reutilizados

## 4.1 Mostro daemon

Repositorio:

`https://github.com/MostroP2P/mostro`

Responsabilidades upstream:

- órdenes;
- Nostr;
- hold invoices;
- Lightning;
- ratings;
- fees;
- disputes;
- bonds;
- schedulers;
- SQLite;
- RPC administrativo;
- maintenance mode;
- solvers.

Nuestra app lo configura y opera.

No lo reimplementa.

---

## 4.2 Mostro App

Repositorio:

`https://github.com/MostroP2P/app`

Es el cliente de usuario final.

Nuestra app Umbrel no debe mantener una versión propia salvo necesidad futura.

El operador debe poder mostrar dentro del panel:

- enlace de descarga;
- QR;
- Mostro pubkey;
- relays;
- instrucciones de conexión.

Futuro deseable:

- community deep link;
- community profile;
- QR de onboarding.

Idealmente estas funciones se contribuyen upstream.

---

## 4.3 Mostro Watchdog

Repositorio:

`https://github.com/MostroP2P/mostro-watchdog`

Uso:

- alertas Telegram;
- nuevas disputas;
- cambios de estado;
- health/heartbeat.

Nuestra app debe configurar y ejecutar el servicio.

---

## 4.4 Mostro Push Server

Repositorio:

`https://github.com/MostroP2P/mostro-push-server`

Uso:

- push notifications;
- FCM;
- UnifiedPush;
- eventos de trade/chat.

Debe poder activarse/desactivarse desde Settings.

---

## 4.5 Mostro Score

Repositorios:

- `https://github.com/MostroP2P/mostro-score`
- `https://github.com/MostroP2P/mostro-score-web`

Uso futuro:

- reputación del nodo;
- antigüedad;
- volumen;
- actividad;
- health histórico.

No obligatorio para MVP.

---

## 4.6 Umbrel App Framework

Repositorio:

`https://github.com/getumbrel/umbrel-apps`

Nuestra app debe seguir el modelo actual de Umbrel:

- `umbrel-app.yml`;
- `docker-compose.yml`;
- `app_proxy`;
- almacenamiento persistente;
- widgets opcionales;
- health endpoints;
- dependencias;
- rutas de datos.

---

# 5. Nombre del producto

Nombre técnico provisional:

`Mostro Community Manager`

ID Umbrel sugerido:

`mostro-community`

El nombre comercial puede cambiar.

El `id` de Umbrel debe considerarse estable una vez publicado.

---

# 6. Arquitectura general

```text
                              USUARIOS

                         Mostro App oficial
                                │
                                │ Nostr
                                ▼

                        ┌────────────────┐
                        │ Mostro daemon  │
                        └───────┬────────┘
                                │
                               LND
                                │
                         Bitcoin Core

             ───────────────────────────────
                         UMBREL
             ───────────────────────────────

              Mostro Community Manager
                        │
          ┌─────────────┼──────────────┐
          │             │              │
          ▼             ▼              ▼
      Admin API      Admin Web      Health Agent
          │
          ├── Mostro RPC
          ├── Mostro config
          ├── read-only metrics
          ├── Watchdog config
          ├── Push config
          └── network config/status
```

---

# 7. Servicios Docker de la Umbrel App

```text
mostro-community/
│
├── app_proxy
├── web
├── api
├── mostro
├── watchdog
├── push-server          optional
├── relay                optional
├── updater
└── health-agent
```

## 7.1 `web`

Interfaz administrativa.

## 7.2 `api`

Backend seguro para UI.

## 7.3 `mostro`

Daemon upstream fijado por versión.

## 7.4 `watchdog`

Mostro Watchdog upstream.

## 7.5 `push-server`

Opcional.

## 7.6 `relay`

Opcional si el operador quiere relay propio.

## 7.7 `updater`

No realiza upgrades financieros automáticamente.

Solo:

- consulta releases;
- compara versiones;
- genera estado;
- ejecuta tests de pre-upgrade cuando se solicita.

## 7.8 `health-agent`

Agrega estado de:

- Bitcoin;
- LND;
- Mostro;
- DB;
- relay;
- watchdog;
- push;
- red.

---

# 8. Dependencias Umbrel

La app requiere como mínimo:

- Bitcoin Node funcional;
- Lightning Node LND funcional.

No levantar:

- segundo bitcoind;
- segundo LND.

La app debe verificar durante onboarding:

```text
Bitcoin
✓ instalado
✓ sincronizado

LND
✓ instalado
✓ conectado
✓ identidad disponible
```

Si falta una dependencia, mostrar instrucciones claras.

---

# 9. Integración LND

Mostro debe usar el LND de Umbrel.

El servicio debe recibir/montar:

- TLS certificate;
- macaroon requerido;
- gRPC host/port.

No exponer esas credenciales al frontend.

El backend debe mostrar datos operativos seguros:

- alias;
- pubkey;
- synced_to_chain;
- block height;
- channel count;
- local balance;
- remote balance;
- pending channels;
- health.

---

# 10. Onboarding inicial

La instalación debe abrir un wizard.

## Paso 1 — Bienvenida

```text
Create your P2P community

This app will configure and operate a Mostro market
using your Umbrel Bitcoin and Lightning node.
```

## Paso 2 — Infraestructura

Detectar:

- Bitcoin;
- LND;
- sync;
- canales.

Mostrar advertencia si LND no tiene liquidez suficiente.

## Paso 3 — Identidad de comunidad

Campos:

```text
Community name
Short description
Logo
Website
Contact URL
Country/region (optional)
Primary language
```

Nada debe estar hardcodeado.

## Paso 4 — Moneda

Permitir una o varias fiat currencies soportadas por la versión Mostro.

Ejemplo:

```text
USD
EUR
ARS
COP
...
```

Guardar como configuración Mostro.

## Paso 5 — Métodos de pago

El operador crea su catálogo.

Ejemplo:

```text
Category: Bank
Name: Banco X
Code: banco_x
Description: Transferencia inmediata
Active: yes
```

Permitir:

- añadir;
- editar;
- ordenar;
- desactivar;
- agrupar.

La app no debe asumir bancos de un país concreto.

## Paso 6 — Límites

Campos:

```text
Minimum trade
Maximum trade
Order expiration
Maximum expiration
```

Mostrar equivalencia aproximada.

## Paso 7 — Fees

Campos:

```text
Trading fee
Dev contribution
Max routing fee
```

Mostrar explicación.

No ocultar que el dev fee sale del ingreso del operador según Mostro.

## Paso 8 — Anti-abuse bond

```text
Enable bonds
Bond %
Minimum sats
Apply:
  maker
  taker
  both

Automatic timeout slash:
  off by default
```

MVP recomendado:

```text
enabled = true
amount_pct = 3%
apply_to = both
automatic timeout slash = false
```

Pero el operador decide.

## Paso 9 — Nostr

Campos:

- Mostro identity;
- relays;
- optional own relay;
- PoW;
- first-contact PoW.

Permitir generar nueva identidad.

Obligar a realizar backup del nsec.

No volver a mostrarlo libremente después del onboarding sin reautenticación.

## Paso 10 — Telegram

Opcional:

- Bot Token;
- Chat ID;
- Send test notification.

## Paso 11 — Push

Opcional:

- enabled;
- Firebase config;
- UnifiedPush;
- public endpoint.

## Paso 12 — Networking

Mostrar:

```text
Local access
✓ available

Tailscale
○ detected / not installed

VPS WireGuard
○ configure / already configured
```

No forzar ninguna opción.

## Paso 13 — Review

Resumen completo.

## Paso 14 — Start Market

Generar:

- Mostro config;
- RPC token;
- service config;
- watchdog config;
- push config;
- data directories.

Iniciar servicios.

---

# 11. Configuración de comunidad

Todas las propiedades deben ser editables después.

## 11.1 Community Profile

```yaml
community:
  name:
  about:
  picture:
  website:
  contact:
  language:
  region:
```

## 11.2 Market

```yaml
market:
  fiat_currencies:
  payment_methods:
  min_trade:
  max_trade:
  fee:
  max_routing_fee:
  order_expiration:
```

## 11.3 Safety

```yaml
safety:
  bond_enabled:
  bond_pct:
  base_bond_sats:
  bond_apply_to:
  automatic_timeout_slash:
  pow:
  pow_first_contact:
```

## 11.4 Nostr

```yaml
nostr:
  relays:
  own_relay_enabled:
```

## 11.5 Notifications

```yaml
notifications:
  telegram:
  push:
```

---

# 12. Admin Dashboard

Pantalla inicial.

```text
My Community

Market                 ONLINE
Bitcoin                SYNCED
Lightning              ONLINE
Mostro                  ONLINE
Nostr                   HEALTHY

Active trades              7
Open orders               21
Open disputes              1
24h volume              $850
24h fees                $5.10

[Open Market]
[Trades]
[Disputes]
[Settings]
```

## 12.1 Umbrel widget

Opcional:

```text
Mostro Community

● Online
7 active trades
1 dispute
```

Usar endpoint JSON real.

---

# 13. Navegación Admin

```text
Dashboard
Market
Orders
Trades
Disputes
Users
Solvers
Payments
Fees
Notifications
Node
Network
Backups
Updates
Settings
Logs
```

---

# 14. Market

Mostrar:

- nombre comunidad;
- Mostro pubkey;
- estado;
- currency;
- fee;
- bond;
- min/max;
- relays;
- payment methods;
- link/QR para usuarios.

Acciones:

- Pause new trades;
- Resume;
- Copy node pubkey;
- Copy connection info.

---

# 15. Orders

Tabla:

```text
ID
Buy/Sell
Fiat
Amount
Premium
Payment method
Status
Created
Expires
```

Filtros.

No permitir mutaciones financieras arbitrarias.

---

# 16. Trades

Detalle de una operación:

```text
Order
Buyer
Seller
Amount
Payment method
Current state
Created
Last update

Bond buyer
Bond seller
Escrow
Timers

Timeline
Messages
```

El panel debe traducir estados técnicos a lenguaje claro.

---

# 17. Disputes

Esta es una función central.

## 17.1 Queue

```text
NEW
ASSIGNED
WAITING BUYER
WAITING SELLER
READY TO RESOLVE
RESOLVED
```

## 17.2 Detail

Mostrar:

- dispute ID;
- trade;
- amount;
- state;
- initiator;
- buyer identity/reputation;
- seller identity/reputation;
- buyer chat;
- seller chat;
- evidence metadata;
- bond state;
- escrow state;
- assigned solver.

## 17.3 Actions

Backend usa RPC/protocolo upstream.

```text
Take dispute
Send message to buyer
Send message to seller

Resolve:
  Settle / Pay buyer
  Cancel / Refund seller

Bond:
  Slash buyer
  Slash seller
  Release both
```

Mostrar doble confirmación para acciones irreversibles.

---

# 18. Mostro RPC

Usar RPC upstream.

Operaciones actualmente relevantes:

- `CancelOrder`;
- `SettleOrder`;
- `AddSolver`;
- `TakeDispute`;
- `SetMaintenanceMode`;
- `GetMaintenanceStatus`;
- `GetVersion`.

Configurar `auth_token`.

RPC debe permanecer privado.

Arquitectura:

```text
Browser
  ↓
Admin API
  ↓
Mostro RPC
```

Nunca:

```text
Browser → Mostro RPC
```

---

# 19. Solvers

UI:

```text
Name/Alias
Pubkey
Permission
Status
Disputes assigned
```

Permisos:

```text
read
read-write
```

Acciones:

- add;
- deactivate locally if supported by our access layer;
- view activity.

Si upstream no soporta remover solver, no simular que existe.

Mostrar limitación.

---

# 20. Users

MVP read-only.

Mostrar solo datos que existan upstream:

- identity/pubkey;
- reputation;
- ratings;
- trades;
- disputes;
- last activity cuando pueda inferirse.

No crear perfiles con PII.

## Futuro

Moderación:

- active;
- suspended;
- banned.

Debe implementarse solo si existe enforcement server-side.

Frontend-only bans no son seguridad.

---

# 21. Payment Methods Manager

El operador administra métodos.

UI:

```text
Payment Methods

Banks
  ✓ Banco A
  ✓ Banco B

Wallets
  ✓ Wallet X

Cash
  ○ Cash
```

Campos:

```text
id
label
category
description
active
sort_order
icon optional
```

Publicación hacia usuarios depende de capacidades del cliente/protocolo.

La app debe separar:

1. catálogo comunitario;
2. valor que se envía a Mostro.

---

# 22. Fee Dashboard

Mostrar:

```text
24h volume
7d volume
30d volume

Gross Mostro fees
Dev contribution
Routing costs estimated
Bond slashes
Estimated operator revenue
```

No llamar `profit` al ingreso bruto.

---

# 23. Anti-Abuse Bond

UI debe explicar:

```text
A bond temporarily locks Lightning sats from participants.
It is returned on honest completion.
It can be slashed in a dispute according to operator policy.
```

Config editable.

Cambios que afecten trades futuros no deben alterar reglas de trades ya activos.

Guardar config snapshot por trade si upstream lo hace; si no, respetar semántica upstream.

---

# 24. Telegram

Configurar Mostro Watchdog upstream.

UI:

```text
Telegram Alerts

Enabled          ✓
Bot Token        **********
Chat ID          -100...
Last test        Success
Watchdog         Online

[Send Test]
```

Alertas:

- new dispute;
- dispute status;
- watchdog health;
- future custom infra alerts.

---

# 25. Push Notifications

Opcional.

Configurar Mostro Push Server upstream.

Mostrar:

```text
Push Server
Online

FCM
Configured

UnifiedPush
Enabled
```

No exponer Firebase service credentials al browser.

---

# 26. Network Access

La app debe ser amigable con tres rutas.

## 26.1 LAN

Default.

Usar Umbrel `app_proxy`.

## 26.2 Tailscale

Umbrel ya puede ejecutar su app oficial de Tailscale.

Nuestra app no instala ni controla Tailscale.

Solo:

- detecta si el host tiene interface/ruta Tailscale cuando sea posible;
- muestra documentación;
- funciona correctamente accedida por Tailnet IP/hostname.

No hardcodear host.

## 26.3 VPS + WireGuard

Para operadores con VPS propio.

Arquitectura:

```text
Internet
   ↓
VPS
Caddy/Nginx
   ↓
WireGuard
   ↓
Umbrel
```

Wizard opcional para guardar información operativa:

```text
public PWA URL
push URL
relay URL
VPS health URL
```

La app no necesita administrar el WireGuard del VPS en MVP.

Puede verificar conectividad.

---

# 27. Seguridad de red

Nunca publicar directamente:

- LND gRPC;
- Mostro RPC;
- DB;
- macaroons;
- nsec.

El VPS solo reverse-proxy los endpoints públicos necesarios.

Admin preferido:

```text
LAN
or
Tailscale
or
private WireGuard
```

---

# 28. Maintenance Mode

Botón:

```text
Enter Maintenance Mode
```

Explicar:

> New/take operations will stop. Existing trades and administrative actions continue according to Mostro behavior.

Mostrar:

- active trades;
- pending escrow;
- pending payouts;
- open disputes.

No permitir upgrades críticos sin revisión de estado.

---

# 29. Updates

Este producto debe diferenciar:

```text
Community Manager update
Mostro update
Watchdog update
Push Server update
Relay update
```

## 29.1 Release watcher

Consultar releases oficiales.

UI:

```text
Mostro
Installed: 0.x.y
Latest:    0.x.z

Status: Update available

[Release Notes]
[Run Compatibility Test]
[Prepare Update]
```

## 29.2 No auto-update financiero

Mostro no se actualiza automáticamente.

Proceso:

```text
new release
↓
download metadata
↓
regtest/compatibility checks
↓
operator review
↓
maintenance mode if needed
↓
backup
↓
upgrade
↓
health
↓
resume
```

## 29.3 Watchdog/Push

Pueden tener una política más automatizada, pero siempre con rollback.

---

# 30. Upstream Version Matrix

Mantener archivo:

```yaml
release: 1.0.0

components:
  mostro:
    version: x.y.z
  mostro_app:
    minimum_compatible: a.b.c
  watchdog:
    version: x.y.z
  push_server:
    version: x.y.z

umbrel:
  minimum_version: x.y
```

El cliente Mostro App no corre dentro de esta Umbrel App, pero su compatibilidad debe documentarse.

---

# 31. Backups

UI:

```text
Backups

Mostro DB          protected
Mostro config      protected
Community config   protected
Secrets            encrypted

Last backup        ...
Status             ...
```

## Incluye

- `mostro.db`;
- Mostro config;
- community config;
- Watchdog config;
- Push config;
- relay config;
- version matrix.

## Secretos

Cifrados.

No exportarlos como texto plano por defecto.

---

# 32. Restore

Proceso guiado.

No restaurar LND como parte de esta app.

LND recovery pertenece a Umbrel/LND.

Nuestra app restaura solo sus componentes.

---

# 33. Migración

**Fuera del alcance actual.**

El producto debe reservar una futura sección:

```text
Settings
  └── Import / Migrate
```

Pero el MVP no implementará migración automática desde:

- MostriX;
- Mostro instalado manualmente;
- otro Umbrel;
- otro servidor.

La migración deberá estudiarse contra:

- DB actual;
- Mostro nsec;
- LND identity;
- trades activos;
- config;
- bonds;
- disputes.

No asumir que copiar SQLite basta.

---

# 34. Logs

Centralizar logs.

Filtros:

- Mostro;
- admin API;
- watchdog;
- push;
- relay.

Redactar:

- secrets;
- nsec;
- macaroon;
- auth tokens;
- sensitive invoice data.

UI:

```text
Logs
[Mostro] [Watchdog] [Push] [System]

Download sanitized support bundle
```

---

# 35. Health

Estado:

```text
Bitcoin
Lightning
Mostro
Database
Nostr relays
Watchdog
Push
Relay
Public endpoints
```

Semáforo:

```text
green
yellow
red
```

Mostrar acciones sugeridas.

---

# 36. Monitoring

## Local

Health agent.

## VPS

Monitor público.

## Externo

Idealmente un tercer health monitor para detectar que también cayó el VPS.

---

# 37. Reputación del operador

Fase posterior.

Integrar Mostro Score.

Panel:

```text
Node age
Successful trades
Volume
Recent activity
Liveness
```

Esto permite que operadores de distintas comunidades construyan reputación verificable.

---

# 38. Comunidades verificadas

Fase posterior.

No es requisito para que un operador use la app.

Puede existir un registry independiente que firme comunidades.

Nuestra Umbrel App debe poder exportar un `community manifest`:

```json
{
  "name": "...",
  "mostro_pubkey": "...",
  "relays": [],
  "website": "...",
  "contact": "..."
}
```

El operador puede solicitar verificación externamente.

La app no debe controlar quién es "oficial" globalmente.

---

# 39. Admin API

Preferencia:

Rust + Axum.

Razones:

- stack cercano a Mostro;
- binario compacto;
- buena concurrencia;
- integración gRPC.

## Endpoints MVP

```text
GET  /api/health
GET  /api/dashboard

GET  /api/community
PUT  /api/community

GET  /api/market/settings
PUT  /api/market/settings

GET  /api/payment-methods
POST /api/payment-methods
PUT  /api/payment-methods/:id
DELETE /api/payment-methods/:id

GET  /api/orders
GET  /api/trades
GET  /api/trades/:id

GET  /api/disputes
GET  /api/disputes/:id
POST /api/disputes/:id/take
POST /api/disputes/:id/message
POST /api/disputes/:id/settle
POST /api/disputes/:id/cancel

GET  /api/solvers
POST /api/solvers

GET  /api/node
GET  /api/lightning

GET  /api/maintenance
POST /api/maintenance/enable
POST /api/maintenance/disable

GET  /api/notifications
PUT  /api/notifications

GET  /api/network

GET  /api/versions
POST /api/updates/test
POST /api/updates/prepare
POST /api/updates/apply

GET  /api/logs
```

---

# 40. Mutaciones financieras

Regla crítica:

El Admin API no modifica la DB de Mostro para resolver trades.

Usar:

- Mostro RPC;
- protocolo admin upstream.

No:

```sql
UPDATE orders SET ...
```

---

# 41. Lectura de DB

Puede permitirse read-only cuando RPC no exponga métricas suficientes.

Crear adapter.

```text
Mostro DB
  ↓ read-only
Metrics Adapter
  ↓
Admin API
```

No acoplar toda la UI al schema SQLite.

Si upstream cambia schema, solo cambia adapter.

---

# 42. UI Tech

Opciones:

- React/Next;
- React/Vite;
- SvelteKit.

Recomendación:

**React + TypeScript + Vite** para SPA administrativa simple.

No necesita SSR.

Backend separado.

Características:

- responsive;
- mobile-friendly;
- dark/light;
- accessible;
- no secrets en browser.

---

# 43. Diseño UX

Objetivo:

"operar una comunidad", no "administrar un daemon".

Evitar términos técnicos donde no son útiles.

Ejemplo:

En vez de:

```text
NOSTR_ORDER_EVENT_KIND
```

mostrar:

```text
Open Orders
```

En vez de:

```text
SettleOrder RPC
```

mostrar:

```text
Release Bitcoin to buyer
```

Con confirmación:

```text
This action is irreversible.
```

---

# 44. Authentication

La app vive dentro de Umbrel.

Aun así:

- integrar adecuadamente con app access model;
- proteger mutaciones;
- CSRF;
- session controls;
- optional second factor para administración remota futura.

No asumir que una URL privada elimina el riesgo.

---

# 45. Secrets Storage

Separar:

```text
config/
secrets/
data/
```

Permisos mínimos.

Secretos:

- Mostro nsec;
- RPC auth token;
- Telegram token;
- Firebase service credentials;
- LND credentials references.

No guardar en browser.

---

# 46. Config generation

La UI no debe editar TOML arbitrariamente.

Usar typed configuration model.

```text
UI form
  ↓
validated config object
  ↓
config renderer
  ↓
settings.toml
```

Antes de escribir:

- validar;
- crear backup;
- render temp;
- ejecutar config check;
- atomic replace;
- restart if needed.

---

# 47. Restart Policy

Cambios deben clasificarse:

```text
HOT
no restart

MOSTRO_RESTART
restart daemon

STACK_RESTART
restart services

MAINTENANCE_REQUIRED
must drain/pause first
```

UI debe informar antes de aplicar.

---

# 48. Audit Log

Registrar acciones admin:

```text
timestamp
actor/session
action
target
result
```

Ejemplos:

- changed fee;
- added solver;
- maintenance enabled;
- dispute settled;
- bond slashed;
- update applied.

Nunca registrar secrets.

---

# 49. Notification Events

Admin notifications:

```text
new dispute
dispute update
Mostro offline
LND unsynced
low liquidity warning
relay unreachable
push server offline
update available
backup failed
```

Telegram puede recibir subset configurable.

---

# 50. Liquidity Warnings

Dashboard debe alertar:

```text
Low outbound liquidity
Low inbound liquidity
No active channels
High pending HTLCs
```

No implementar rebalancing automático en MVP.

---

# 51. First Run Defaults

Defaults deben ser conservadores.

Ejemplo conceptual:

```text
fee                    explicit operator choice
bond                    enabled suggested
auto timeout slash      off
max trade               low
pow_first_contact       enabled suggested
admin RPC               private + auth token
```

No asumir USD.

No asumir país.

---

# 52. MVP Scope

## Debe incluir

- Umbrel install;
- onboarding;
- Bitcoin/LND detection;
- Mostro upstream;
- configurable community;
- currencies;
- payment methods;
- fees;
- bonds;
- relays;
- PoW;
- dashboard;
- orders/trades;
- disputes;
- admin chat;
- settle/cancel;
- solvers;
- Telegram;
- health;
- maintenance;
- logs;
- backups;
- LAN;
- Tailscale friendly;
- VPS/WireGuard friendly;
- version management;
- release watcher.

## Puede esperar

- automated migration;
- operator bonds;
- verified registry;
- advanced user bans;
- KYC;
- AI dispute solver;
- automated liquidity;
- multi-node federation UI;
- mobile admin native app.

---

# 53. Fases

## Phase 0 — Architecture spike

- package skeleton;
- Umbrel proxy;
- API;
- Mostro container;
- connect LND.

## Phase 1 — Configuration

- onboarding;
- community settings;
- renderer;
- start/stop.

## Phase 2 — Operations dashboard

- health;
- metrics;
- orders;
- trades.

## Phase 3 — Disputes

- queue;
- chat;
- take;
- settle;
- cancel;
- bonds.

## Phase 4 — Notifications

- watchdog;
- Telegram;
- push config.

## Phase 5 — Network

- LAN validation;
- Tailscale validation;
- VPS/WireGuard documentation/status.

## Phase 6 — Updates/backups

- watcher;
- tests;
- backups;
- rollback.

## Phase 7 — Closed beta

- mainnet small trades.

---

# 54. Acceptance Criteria

MVP listo cuando:

1. Se instala desde Umbrel.
2. Detecta Bitcoin/LND.
3. El operador crea comunidad desde UI.
4. Configura currency.
5. Configura payment methods.
6. Configura fee.
7. Configura bonds.
8. Mostro inicia.
9. Mostro App oficial puede conectarse.
10. Crear/tomar trade funciona.
11. Dashboard refleja operación.
12. Disputa aparece.
13. Telegram alerta.
14. Admin toma disputa.
15. Admin conversa.
16. Admin settle/cancel.
17. Bond resolution funciona.
18. Maintenance funciona.
19. LAN funciona.
20. Tailscale funciona cuando está instalado.
21. VPS/WireGuard puede reverse-proxy endpoints públicos.
22. Backup funciona.
23. Update check detecta nueva release.
24. Update de Mostro requiere test/aprobación.
25. Reinicio conserva estado.

---

# 55. Repositorio propio

Solo necesitamos mantener principalmente:

```text
mostro-community-umbrel/
├── umbrel-app.yml
├── docker-compose.yml
├── web/
├── api/
├── config/
├── adapters/
│   ├── mostro-rpc/
│   ├── mostro-db-readonly/
│   ├── lnd/
│   └── umbrel/
├── updater/
├── health/
├── scripts/
└── docs/
```

No repo propio de cliente final inicialmente.

---

# 56. Adapter Pattern

Toda integración upstream debe ir detrás de interfaces.

Ejemplo:

```text
trait MostroAdmin {
  get_version()
  get_maintenance()
  set_maintenance()
  take_dispute()
  settle_order()
  cancel_order()
  add_solver()
}
```

Si Mostro cambia gRPC:

- actualizar adapter;
- no reescribir UI.

Mismo patrón para:

- LND;
- DB;
- Watchdog;
- Push.

---

# 57. Upstream Watcher

Monitorear:

```text
MostroP2P/mostro
MostroP2P/app
MostroP2P/mostro-watchdog
MostroP2P/mostro-push-server
Umbrel relevant changes
```

Mostro App se monitorea porque el operador debe saber compatibilidad del cliente.

---

# 58. Upgrade Workflow

```text
Update Available
      ↓
View Release Notes
      ↓
Compatibility Test
      ↓
Check Active Trades
      ↓
Backup
      ↓
Maintenance if required
      ↓
Deploy
      ↓
Health Checks
      ↓
Resume
```

Rollback solo si migration semantics lo permiten.

---

# 59. Development Rules for AI

Una IA que implemente este blueprint debe:

1. revisar upstream antes de escribir;
2. no duplicar features;
3. no modificar escrow code;
4. no escribir directo a Mostro DB;
5. usar adapters;
6. pin versions;
7. tests para cada mutación;
8. tests E2E con regtest;
9. mantener secrets fuera de UI;
10. no inventar RPCs;
11. documentar limitaciones upstream;
12. contribuir upstream cambios genéricos cuando sea posible.

---

# 60. Critical Test Matrix

## Installation

- clean install;
- missing LND;
- unsynced Bitcoin;
- no channels.

## Config

- valid;
- invalid;
- restart;
- rollback.

## Trade

- create;
- take;
- fiat sent;
- release;
- cancel.

## Bonds

- maker;
- taker;
- release;
- slash.

## Dispute

- open;
- take;
- buyer wins;
- seller wins;
- restart during dispute.

## Network

- LAN;
- Tailscale;
- WireGuard;
- VPS down.

## Update

- update available;
- failed test;
- successful upgrade;
- restart.

---

# 61. Explicit Non-Goals

El producto NO será:

- wallet;
- exchange custodial;
- fork de Mostro;
- fork permanente de Mostro App;
- KYC provider;
- fiat payment processor;
- replacement de Bitcoin Core;
- replacement de LND.

---

# 62. Producto final

La propuesta final es:

> **Una app de Umbrel que convierte un nodo Bitcoin + Lightning en una plataforma operable de comunidad Mostro P2P, administrable desde una interfaz gráfica, configurable por cada operador y actualizable desde upstream.**

El operador administra:

```text
su marca
su comunidad
sus métodos
sus límites
sus fees
sus bonds
sus solvers
sus relays
sus alertas
sus disputas
su infraestructura
```

Mostro mantiene:

```text
protocolo
Lightning escrow
orders
ratings
bonds
dispute state machine
Nostr transport
```

Mostro App mantiene:

```text
experiencia del usuario final
```

Ese reparto de responsabilidades permite que el operador se concentre en:

- liquidez;
- comunidad;
- soporte;
- resolución de disputas;
- crecimiento;
- reputación;

y no en mantener un protocolo financiero.

---

# 63. Próxima etapa de construcción

Primera iteración debe entregar:

1. `umbrel-app.yml`;
2. `docker-compose.yml`;
3. Admin Web skeleton;
4. Admin API skeleton;
5. LND adapter;
6. Mostro RPC adapter;
7. settings renderer;
8. health dashboard;
9. onboarding;
10. start Mostro;
11. Mostro App connection QR/instructions;
12. regtest trade smoke test.

Después:

13. disputes;
14. Telegram;
15. backups;
16. updater;
17. network validation.

---

# 64. Migración futura

La instalación existente del operador deberá migrarse en una fase posterior.

Ese trabajo debe comenzar con un **migration assessment**, no con copia automática de archivos.

Debe inventariar:

```text
Mostro version
DB schema
Mostro nsec
LND identity
active trades
open disputes
active bonds
config
relays
solvers
watchdog
```

Solo después se define estrategia de import.

Hasta entonces, este blueprint trata exclusivamente la construcción de la nueva Umbrel App.

---

## Fin del blueprint
