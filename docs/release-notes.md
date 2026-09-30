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
