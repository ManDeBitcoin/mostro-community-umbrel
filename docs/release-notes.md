# Mostro Community Manager v1.0.12

- Incluye el daemon oficial Mostro v0.19.2, comprobado por SHA-256 para amd64 y arm64. La actualización no requiere migración de base de datos ni cambios de configuración.
- Mostro v0.19.2 envía el aporte al desarrollo a la nueva dirección del proyecto, porque la anterior fue suspendida, y solo cuando LND opera en mainnet.
- El monitor de órdenes reconoce el estado «En curso» que el daemon publica al tomarse una orden. Antes descartaba esa revisión y la orden seguía figurando como oferta abierta.
- Las disputas se leen de los eventos propios del nodo (kind 38386) y generan una alerta al abrirse.
- La consola de mediación muestra las disputas y los mensajes de protocolo de cada orden, y explica cómo resolverlas con un cliente de mediación. Se retiraron los botones de resolución, que no ejecutaban ninguna acción.
- La tarjeta del daemon muestra la versión que el nodo anuncia en los relays y hace cuánto. Si el daemon se reinicia en bucle, el panel lo indica.
- Guardar un cambio que no altera la configuración del daemon ya no lo reinicia.
- La tarjeta de la comunidad se firma con el formato que verifican las apps y se ofrece como enlace `mostro://community/…` con todos los datos.
- El panel ya no publica por su cuenta el evento de información del nodo: lo publica solo el daemon.
- El simulador sigue la secuencia y los importes reales de una operación en Mostro v0.19.2.
- El panel avisa cuando la prueba de trabajo de la primera conversación supera a la general: las apps que no la calculan dejan de recibir respuesta del daemon.
- Nueva guía técnica para desarrolladores de apps: `docs/INTEGRACION-APPS.md`.

# Mostro Community Manager v1.0.11

- Actualización integral al Protocolo Mostro v0.19.0 (Protocolo de Transporte v2 sobre Nostr Kind 14 con cifrado NIP-44 v2).
- Detección e introspección activa de la versión del daemon Mostro en ejecución con reporte en la API (`/api/daemon/status`) y visualización en tiempo real en la tarjeta de servicio y cuadrícula del panel de administración.
- Adaptación del canal de mensajería y mediación para decodificar eventos Kind 14 y procesar estructuras de órdenes en tupla de 3 elementos (`[order, signature, proof]`).
- Actualización de plantillas de configuración upstream v0.19.0 incorporando el nuevo parámetro `maker_bond_payment_timeout_seconds` y retirando directivas de transporte obsoletas.
- Verificación criptográfica SHA-256 de los binarios oficiales upstream de Mostro v0.19.0 para arquitecturas amd64 y arm64.

# Mostro Community Manager v1.0.10

- Actualización del estándar de JSON comunitario para conexiones con Mostro App (esquema estándar v1 con version, name, pubkey, relays, currency, payment_methods, fee_bps, bond_percent, website, contact, signature).
- Firma criptográfica Schnorr (BIP-340) generada automáticamente sobre el payload canónico con la identidad Nostr del nodo.
- Nuevo endpoint público `GET /api/community/card` para consultar la tarjeta de la comunidad directamente.
- Integración en la interfaz de conexión para copiar el JSON estándar y generar el código QR interactivo correspondiente.

# Mostro Community Manager v1.0.9

- Rediseño estético y armonioso de la tarjeta de Conexión con Mostro App y Mostrix.
- Distribución en 2 columnas: panel de código QR interactivo con selector de pestañas (URI Mostro / JSON) a la izquierda y detalles de conexión con botones de copiado a la derecha.
- Visualización dinámica del payload activo (URI o JSON) según la pestaña seleccionada.

# Mostro Community Manager v1.0.8

- Agregado switch para alternar entre formato URI y JSON en el código QR comunitario.
- Corregido el copiado al portapapeles en entornos HTTP.

# Mostro Community Manager v1.0.7

Actualización del formato de conexión de la URI QR (nostr: -> mostro://community/)

# Mostro Community Manager v1.0.6

Onboarding soberano con generación de identidad Nostr, plantillas de comisiones y catálogo bilingüe de divisas ISO 4217.

- Generación soberana de clave privada Nostr (nsec/npub) en 1 clic e importación directa desde el panel web con permisos restringidos (0600) y modal de custodia.
- Prellenado rápido (presets) exclusivo para comisiones de mercado, desarrollo y fianza anti-abuso (sin sobreescribir identidad, relays ni métodos de pago).
- Selector interactivo de divisas fiat con el catálogo oficial ISO 4217 (174 monedas) y búsqueda bilingüe (español e inglés) insensible a mayúsculas y acentos.
- Píldoras de acceso rápido para monedas P2P frecuentes (USD, EUR, ARS, VES, COP, BRL, MXN, CLP, PEN, GBP, CHF) y validación de hasta 30 divisas por el protocolo.
