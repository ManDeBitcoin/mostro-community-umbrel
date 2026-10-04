# Guía de Despliegue y Manual de Operaciones: Mostro Community Manager for Umbrel

> **Versión:** 1.0.0 (Producción)  
> **Compatibilidad:** Umbrel OS v0.5+ / UmbrelOS 1.x  
> **Protocolo:** Mostro v0.19.2, protocolo 2 (mensajes kind 14 con cifrado NIP-44) / Lightning Network (LND)

---

## 1. Visión General del Sistema

**Mostro Community Manager** permite a cualquier operador con un nodo Umbrel desplegar y administrar una comunidad P2P de intercambio soberano de Bitcoin sin necesidad de programar, bifurcar software ni mantener clientes móviles propios.

- **Compradores y Vendedores:** Utilizan la **Mostro App oficial** (disponible para Android, iOS y Web) conectándose directamente a tu nodo mediante la identidad pública (`npub` / `nprofile`) y los relays Nostr que configures.
- **Motor de Mercado:** Ejecuta el daemon oficial de **Mostro** (v0.19.2) orquestado de forma aislada.
- **Canal Financiero:** Se conecta al nodo **LND** de tu Umbrel mediante permisos mínimos de solo lectura (`readonly.macaroon`) para la interfaz administrativa, y credenciales seguras para el daemon de pagos.
- **Panel de Control:** Servido mediante una API en Rust de alto rendimiento y una interfaz web en React con soporte para monitor de órdenes, consola de mediación cifrada, gestión de liquidez Lightning, notificaciones SSE y copias de seguridad automáticas offsite.

```text
USUARIOS (Mostro App)
       │ (Nostr kind 14, NIP-44)
       ▼
   Relays Nostr
       │
       ▼
┌────────────────────────────────────────────────────────┐
│ UMBREL DEL OPERADOR                                    │
│  ├── Mostro Community Manager (Web + API Axum)         │
│  │    ├── Monitor de órdenes (Kind 38383)              │
│  │    ├── Consola de mediación de disputas             │
│  │    ├── Operaciones y gestión de liquidez LND        │
│  │    ├── Transmisión de alertas en vivo (SSE)         │
│  │    └── Backups cifrados automáticos (age)           │
│  │                                                     │
│  ├── Daemon Mostro (v0.19.2) [Orquestación Atómica]    │
│  │                                                     │
│  ├── LND (Lightning Node)                              │
│  └── Bitcoin Core Node                                 │
└────────────────────────────────────────────────────────┘
```

---

## 2. Requisitos Previos

Antes de instalar y poner en marcha tu comunidad, asegúrate de que tu nodo Umbrel cumpla con las siguientes condiciones:

1. **Hardware y Sistema Operativo:**
   - Servidor Umbrel operativo (Raspberry Pi 4/5, mini PC x86_64, etc.) con al menos 4 GB de memoria RAM.
   - Disco SSD con espacio disponible (mínimo 10 GB libres para datos de la app y backups).
2. **Aplicaciones Base Instaladas en Umbrel:**
   - **Bitcoin Node (Bitcoin Core):** Completamente sincronizado al 100% de la cadena de bloques.
   - **Lightning Node (LND):** Sincronizado a la cadena y con grafo Lightning actualizado.
3. **Conectividad:**
   - Conexión a internet estable 24/7.
   - Puertos salientes habilitados para conectarse a relays Nostr (`wss://`) y peers Lightning.

---

## 3. Instalación en Umbrel

### Opción A: A través de la Umbrel App Store (Recomendada)
1. Abre el panel de tu Umbrel (`http://umbrel.local`).
2. Dirígete a la **App Store** de Umbrel.
3. Si el repositorio comunitario de Mostro ya está indexado, busca **"Mostro Community Manager"** y haz clic en **Instalar**.
4. Si estás usando una tienda comunitaria personalizada:
   - Ve a los ajustes de la App Store de Umbrel.
   - Añade el repositorio: `https://github.com/ManDeBitcoin/mostro-community-umbrel`.
   - Selecciona **Mostro Community Manager** y confirma la instalación.

### Opción B: Despliegue Manual para Pruebas / Desarrollo
En una terminal SSH en tu servidor Umbrel:
```bash
cd ~/umbrel/app-stores/
git clone https://github.com/ManDeBitcoin/mostro-community-umbrel.git getumbrel__mostro-community
# La aplicación aparecerá inmediatamente disponible en la tienda local de tu Umbrel
```

---

## 4. Guía de Configuración Inicial (Paso a Paso)

Una vez completada la instalación, abre la aplicación **Mostro Community Manager** desde el escritorio de tu Umbrel.

### Paso 1: Configurar la Identidad del Nodo (Nostr)
El nodo Mostro se comunica con el mundo a través de un par de claves criptográficas Nostr (clave privada `nsec` y clave pública `npub`).

1. Para generar o importar tu clave de forma hermética, accede a la consola del servidor:
   ```bash
   # Importar clave privada de forma interactiva (se oculta en pantalla y se valida checksum)
   mostro-community-api import-identity
   ```
2. La clave se almacenará en `/data/config/identity/mostro.nsec` con permisos estrictos `0600` en un directorio `0700`.
3. Deriva la clave pública para que el monitor opere sin tocar la clave privada:
   ```bash
   mostro-community-api derive-public-identity
   ```
4. En el panel web, pestaña **Conexión con Mostro App**, verás:
   - Tu clave pública `npub`.
   - Tu clave hexadecimal.
   - El código QR interactivo y el enlace `nostr:nprofile` listo para compartir.

### Paso 2: Definir las Reglas de Mercado
Accede a la pestaña **Configuración** en el menú lateral:

1. **Identidad:** Asigna un nombre a tu comunidad (ej. *"Bitcoin Madrid P2P"*), idioma preferido y enlace web o canal de soporte.
2. **Monedas y Límites:**
   - Selecciona las monedas fiat en las que operará tu comunidad (ej. `EUR`, `USD`, etc.).
   - Define el monto mínimo y máximo por orden en satoshis (ej. mínimo 10,000 sats; máximo 2,000,000 sats).
   - Establece la comisión de la comunidad (en puntos base, ej. 0.60% = 60 bps).
   - Define la comisión máxima tolerable de enrutamiento Lightning (`max_routing_fee_bps`, ej. 15 bps).
3. **Seguridad y Garantías (Bonds):**
   - Activa el depósito de garantía (bond) obligatorio para desincentivar cancelaciones maliciosas.
   - Define el porcentaje de fianza (ej. 3.00%) y la fianza base mínima.
4. **Relays Nostr:**
   - Especifica entre 2 y 4 relays de alta velocidad (ej. `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.mostro.network`).
5. **Métodos de Pago:**
   - Agrega los métodos de pago aceptados por tu comunidad (ej. Transferencia SEPA Instant, Bizum, Efectivo en mano, Revolut).
6. Haz clic en **Guardar configuración** en la parte inferior. Los cambios se guardarán de forma atómica en el almacenamiento local.

### Paso 3: Preparación de Canales Lightning y Liquidez LND
Dirígete a la pestaña **Operaciones LND** en el panel de navegación.

> **¡Regla de Oro de la Liquidez en Mostro!**  
> Cuando un vendedor publica una oferta o acepta una orden de compra, el vendedor paga un **Hold Invoice** hacia tu nodo Mostro. Para que ese pago sea recibido con éxito, tu nodo **DEBE tener Liquidez Entrante (Inbound Liquidity)**. Si tu nodo solo tiene liquidez local (fondos salientes), las órdenes no podrán iniciarse.

#### Procedimiento para el Operador:
1. **Verificar Canales Existentes:**
   - Observa la barra de proporción de liquidez en la pestaña **Operaciones LND**.
   - Comprueba que el campo *Liquidez Entrante (Inbound / Remota)* cuente con saldo suficiente (recomendado: al menos 500,000 a 1,500,000 sats).
2. **Obtener Canales Entrantes (Inbound) con Alby Hub:**
   - Abre la app **Alby Hub** en tu Umbrel.
   - Ve a la sección **Canales** y selecciona **Comprar canal entrante** / **Solicitar Inbound**.
   - Selecciona un proveedor de confianza (Alby LSP, Olympic, LNBig o Voltage).
   - Define el tamaño del canal (ej. 1,000,000 sats) y confirma la transacción.
3. **Abrir Canales Salientes (Outbound):**
   - Abre 1 o 2 canales hacia nodos de enrutamiento reconocidos (**ACINQ**, **Kraken**, **Bitfinex**, **River**) para garantizar que Mostro pueda liquidar los pagos a los compradores cuando se confirme la transferencia fiat.
4. Una vez confirmados los canales en la cadena (3 confirmaciones), el panel mostrará el estado **"Suficiente ✓"** en verde.

### Paso 4: Validación Previa con el Simulador P2P
Antes de abrir el mercado a usuarios reales:
1. Entra en la pestaña **Simulador P2P**.
2. Selecciona los escenarios de prueba:
   - *Intercambio Exitoso (Happy Path)*: Valida los cálculos matemáticos de fianzas y comisiones.
   - *Disputa con Resolución al Comprador*: Simula el flujo de arbitraje ante impago o conflicto.
   - *Cancelación por Vendedor*: Verifica la anulación de Hold Invoices sin penalizaciones.
3. Haz clic en **Ejecutar Simulación** y comprueba los flujos paso a paso.

### Paso 5: Activación del Demonio Mostro
1. Regresa al **Panel General**.
2. En la tarjeta **Orquestación del Demonio Mostro**, verifica que las advertencias previas estén resueltas (identidad presente, canales activos, configuración guardada).
3. Haz clic en **Activar Configuración de Mercado**.
4. El sistema generará atómicamente el archivo `active/settings.toml` (0600) y el servicio Mostro comenzará a operar en segundo plano.

---

## 5. Operaciones y Mantenimiento Diario

### Monitor de Órdenes Públicas
- En la pestaña **Órdenes públicas**, consulta en tiempo real todas las ofertas de compra y venta anunciadas por tu comunidad en Nostr (Kind 38383).
- Filtra por tipo (compra/venta) o por estado (pendientes, en curso, cerradas).
- El estado público es menos detallado que el real. Una orden tomada suele figurar como «En curso» hasta que se cierra, pero una venta tomada con la factura ya adjunta sigue como «Pendiente». El daemon no publica las disputas en el evento de la orden: las anuncia aparte y el panel las muestra en un aviso y en la pestaña **Mediación**.
- El botón **Ver** abre los mensajes de protocolo de una orden.

### Consola de Mediación de Disputas
- Cuando dos usuarios no se ponen de acuerdo sobre el pago fiat, una de las partes abre una disputa y el nodo la anuncia en un evento propio (kind 38386).
- La pestaña **Mediación** lista esas disputas y, para cada orden, los mensajes de protocolo entre los usuarios y el daemon (kind 14, NIP-44), descifrados en memoria con la identidad del nodo.
- El panel **no** puede leer el chat entre comprador y vendedor ni el del mediador con las partes, y **no** resuelve disputas: es de solo lectura.
- La disputa la resuelve un mediador registrado en el nodo desde un cliente de mediación (Mostrix o `mostro-cli`). La clave del propio nodo es administradora por defecto:
  - `mostro-cli admtakedispute -d <id-de-la-disputa>` para tomarla.
  - `mostro-cli admsettle -o <id-de-la-orden>` si el comprador demostró el pago: el nodo le paga.
  - `mostro-cli admcancel -o <id-de-la-orden>` si el pago no existió: los sats vuelven al vendedor.
  - `mostro-cli admaddsolver -n <npub>` para registrar una clave de mediador distinta de la del nodo.

### Alertas y Notificaciones (SSE)
- La aplicación mantiene una conexión permanente vía Server-Sent Events (`/api/notifications/sse`).
- Recibirás alertas inmediatas ante:
  - Desconexión o degradación de relays Nostr.
  - Apertura de nuevas disputas que requieran arbitraje.
  - Fallos de enrutamiento o canales agotados.
  - Ejecución periódica de respaldos.

### Copias de Seguridad Automáticas Offsite
1. En la tarjeta de respaldos del **Panel General**, ingresa una frase de cifrado segura (mínimo 16 caracteres).
2. El sistema cifra con **age** la identidad Nostr del nodo y la configuración de la comunidad, y conserva copias en `/data/backup`.
3. Política de retención: Se mantienen los **7 respaldos más recientes**, eliminando automáticamente los más antiguos.
4. **Copia remota (Offsite):** Se recomienda programar un comando `scp` o rsync hacia un almacenamiento externo o NAS:
   ```bash
   scp -P 22 umbrel@umbrel.local:/data/backup/*.age /tu/almacenamiento/seguro/
   ```

> **Qué no incluye el respaldo.** La base de datos del daemon (`/data/config/active/mostro.db`) guarda las operaciones abiertas, las disputas y las garantías, y **no** forma parte de estos respaldos. Restaurar un respaldo en otro equipo recupera la identidad y la configuración, no las operaciones en curso. Antes de migrar o reinstalar, espera a que no queden operaciones activas o copia esa base de datos con el daemon detenido. El saldo y los canales dependen del respaldo de LND, que gestiona la app Lightning de Umbrel.

### Restauración ante Desastres (Disaster Recovery)
Si necesitas reinstalar tu servidor o migrar a un nuevo hardware:
1. Copia tu archivo de respaldo `.age` al nuevo servidor.
2. Ejecuta el comando de restauración:
   ```bash
   mostro-community-api restore-backup /ruta/al/backup-revX.age /nuevo/directorio/config
   ```
3. Introduce la frase de paso original para restaurar la identidad y la configuración íntegra.

---

## 6. Seguridad y Buenas Prácticas

- **Principio de Mínimo Privilegio:** El Community Manager opera con macaroon de solo lectura (`readonly.macaroon`) y nunca almacena claves privadas en texto claro en el navegador.
- **Permisos de Archivos:** Todo el almacenamiento sensible bajo `/data/config` se mantiene estrictamente en permisos `0700` para carpetas y `0600` para archivos.
- **Protección Anti-CSRF:** Todos los endpoints de mutación y lectura sensible exigen la cabecera `X-Requested-With: mostro-community` y validación estricta de origen.
- **Seguridad en Contenedores:** Los servicios en Docker Compose operan con `read_only: true`, `cap_drop: [ALL]`, `tmpfs: [/tmp]` y red interna segregada `manager_private`.
- **Cero Gasto Accidental:** Todas las funciones de monitoreo y simulación son de solo lectura o dry-run en memoria.
