# Integración de apps con un nodo Mostro gestionado por el Manager

Guía técnica para quien desarrolla una app de servicio (la Mostro App de BitMaxis u otro cliente) que opera contra un nodo Mostro administrado con Mostro Community Manager.

Todo lo que aquí se afirma sobre el daemon se comprobó contra el binario oficial `mostrod` **v0.19.2** (mostro-core 0.16.0) ejecutado en regtest el 3 y el 4 de octubre de 2026 con un `settings.toml` generado por el Manager, o se leyó en el código de esa versión. La sección [Qué se verificó](#12-qué-se-verificó-y-cómo) separa lo ejecutado de lo solo leído.

## 1. Las diez reglas

1. La app habla con el nodo **solo por Nostr**. El Manager no ofrece ninguna API a las apps: su HTTP queda detrás de la autenticación de Umbrel.
2. Para operar basta la **clave pública del nodo** y sus **relays**. Comisión, límites, monedas, garantía y versión se leen del evento de información del nodo (kind 38385), no de valores fijos en la app.
3. Antes de enviar nada, comprueba en ese evento `protocol_version = "2"` y que el evento sea reciente. Un nodo sin anuncio reciente está parado. Lee también `pow_first_contact`: si no es `0`, el primer mensaje de cada clave debe llevar esa prueba de trabajo.
4. Los mensajes son eventos **kind 14** firmados por la clave de la operación, con contenido cifrado **NIP-44 v2**. Kind 4 y gift wrap (1059) no reciben respuesta.
5. Una orden lleva **sats fijos o prima, nunca ambos**. `amount ≠ 0` con `premium ≠ 0` devuelve `cant-do: invalid_parameters`.
6. Una orden a precio de mercado se envía con `amount = 0`. Los sats los fija el daemon cuando alguien la toma.
7. `fiat_amount`, `min_amount`, `max_amount` y `premium` son **enteros**.
8. Usa un `request_id` propio en cada petición y correlaciona la respuesta por él. Un rechazo de `new-order` no trae `id`.
9. Muchos fallos son **silenciosos**: sin respuesta en unos segundos, la petición no se aceptó. No muestres una orden como creada hasta recibir `new-order` del daemon, y no des una orden por libre solo porque figure como `pending`.
10. No atrases ni aleatorices `created_at` en los mensajes al nodo: un evento con más de 10 s de antigüedad se descarta.

## 2. Quién habla con quién

```text
App de servicio ──(Nostr: kinds 14, 38383, 38385, 38386)──► relays ◄── mostrod ──► LND
                                                                          ▲
Operador ──(navegador, sesión de Umbrel)──► Manager ── settings.toml ─────┘
```

El Manager genera la configuración del daemon, lo arranca y lo supervisa. No participa en las operaciones ni reenvía mensajes. Sus rutas HTTP (`/api/…`) pasan por `app_proxy` de Umbrel y exigen la sesión del operador, de modo que una app móvil no puede consultarlas.

La tarjeta de la comunidad llega a la app fuera de banda: QR, enlace o texto pegado.

## 3. Descubrir el nodo

### 3.1 Tarjeta de la comunidad (JSON v1)

Convención entre el Manager y las apps que la leen. No forma parte del protocolo Mostro. Sirve para arrancar un cliente con un solo escaneo y comprobar que la emitió el operador del nodo.

| Campo | Tipo | Contenido |
| --- | --- | --- |
| `version` | entero | Siempre `1` |
| `name` | texto | Nombre de la comunidad |
| `pubkey` | texto | Clave pública del nodo, 64 hex en minúsculas |
| `relays` | lista de texto | Relays `ws://` o `wss://`, sin barra final |
| `currency` | texto | Moneda principal, ISO 4217 en mayúsculas |
| `payment_methods` | lista de texto | Etiquetas de los métodos de pago activos |
| `fee_bps` | entero | Comisión **total** de una operación en puntos básicos. Cada parte paga la mitad |
| `bond_percent` | entero | Garantía en porcentaje entero, `0` si está desactivada. Orientativo |
| `website` | texto | URL o cadena vacía |
| `contact` | texto | URL o cadena vacía |
| `signature` | texto | Firma Schnorr BIP-340, 128 hex |

`pubkey` y `signature` son siempre cadenas. Si el nodo no tiene identidad o configuración guardada, el Manager no emite tarjeta.

**Firma.** Se firma el SHA-256 de esta cadena, sin escapar nada:

```text
v=<version>&name=<name>&pubkey=<pubkey>&relays=<relays ordenados, unidos por coma>&currency=<currency>&payment_methods=<unidos por coma, en el orden de la tarjeta>&fee_bps=<fee_bps>&bond_percent=<bond_percent>&website=<website>&contact=<contact>
```

Normalización antes de formar la cadena: `name`, `website` y `contact` sin espacios en los extremos, `pubkey` en minúsculas, `currency` en mayúsculas, cada relay sin espacios ni barra final. Es la misma cadena que calcula `canonical_digest` en `rust/src/api/community.rs` de la app.

Verificación:

1. Normaliza los campos como arriba.
2. Calcula `digest = SHA-256(cadena canónica)`.
3. Verifica la firma BIP-340 sobre los 32 bytes de `digest` con la clave x-only `pubkey`. En `k256` es `VerifyingKey::verify_raw(&digest, &sig)`.
4. Comprueba además que `pubkey` es el nodo que el usuario espera. La firma prueba que la tarjeta la emitió quien controla esa clave, no que esa clave sea la comunidad correcta.

Vector de prueba, emitido por el Manager y verificado con el algoritmo de la app:

```json
{"version":1,"name":"BitMaxis - Regtest","pubkey":"30b0b9ab6043de1b6ceeff85e1c0e9dc5302d9ffce71eda6aa38a3a992ca5e33","relays":["ws://127.0.0.1:39777"],"currency":"USD","payment_methods":["Transferencia bancaria"],"fee_bps":60,"bond_percent":0,"website":"https://mostro.bitmaxis.com/","contact":"","signature":"c883269ca11f85386614cf355a90fbb0875848228659dd47b3f28cc6d86e49d0dace81da8da7f7e64ce7d98c2f7d3f7cd9fa1366d0004838afb89d389a4929b8"}
```

```text
cadena: v=1&name=BitMaxis - Regtest&pubkey=30b0b9ab6043de1b6ceeff85e1c0e9dc5302d9ffce71eda6aa38a3a992ca5e33&relays=ws://127.0.0.1:39777&currency=USD&payment_methods=Transferencia bancaria&fee_bps=60&bond_percent=0&website=https://mostro.bitmaxis.com/&contact=
digest: d6a36f0d46513507fe07c551a4cf6763065abf6019d11b5ff1b7231966456ef6
```

**Formatos de entrega.** El Manager ofrece tres, en este orden de preferencia:

| Formato | Ejemplo | Qué recibe la app |
| --- | --- | --- |
| Enlace de tarjeta | `mostro://community/<base64url sin relleno del JSON>` | La tarjeta firmada completa |
| JSON | el objeto de arriba | La tarjeta firmada completa |
| nprofile | `mostro://community/nprofile1…` | Solo clave pública y relays |

**Límites del esquema v1.** Los campos no se escapan: un `&` en el nombre, la web o el contacto, o una `,` en un relay o en una etiqueta de pago, harían que una misma firma valiera para dos tarjetas distintas. El Manager no deja guardar esos valores ni firma una tarjeta que los contenga. Admitirlos exige una versión 2 con escape, implementada a la vez en el Manager y en la app. `bond_percent` no expresa el mínimo en sats ni a qué parte se aplica: para eso está el evento de información.

### 3.2 Evento de información del nodo (kind 38385)

Evento direccionable firmado por el nodo, con `d` igual a su clave pública en hex. El daemon lo publica al arrancar y cada 5 minutos. Es la **fuente autoritativa** de todo lo que la app muestra sobre el nodo.

Filtro: `{"kinds":[38385],"authors":["<pubkey del nodo>"]}`.

| Tag | Significado |
| --- | --- |
| `mostro_version`, `mostro_commit_hash` | Versión del daemon que responde |
| `protocol_version` | `"2"`: transporte kind 14. Sin tag: daemon anterior a v0.18 (protocolo 1). Otro valor: nodo no compatible |
| `min_order_amount`, `max_order_amount` | Límites de una operación en sats |
| `fiat_currencies_accepted` | Monedas separadas por coma. Vacío significa todas |
| `fee` | Comisión total como fracción (`0.006` = 0,6 %). Cada parte paga la mitad |
| `expiration_hours` | Vida de una orden sin tomar |
| `expiration_seconds` | Segundos que una operación tomada puede esperar la factura del comprador o el pago del vendedor antes de cancelarse |
| `hold_invoice_expiration_window` | Segundos que tiene quien toma una orden para pagar su factura de garantía |
| `invoice_expiration_window` | Vigencia mínima que debe tener la factura del comprador |
| `pow`, `pow_first_contact` | Prueba de trabajo NIP-13 exigida a cada mensaje y al primer mensaje de una clave nueva |
| `max_orders_per_response` | Máximo de ids por petición `orders` |
| `bond_enabled` | `true` o `false`, siempre presente |
| `bond_amount_pct`, `bond_base_amount_sats`, `bond_apply_to`, `bond_slash_on_waiting_timeout`, `bond_slash_node_share_pct`, `bond_payout_claim_window_days` | Solo si la garantía está activada |
| `serbero` | Clave hex del asistente de disputas del nodo, solo si hay uno |
| `maintenance_mode` | `true`: el nodo no acepta órdenes ni tomas nuevas |
| `lnd_version`, `lnd_node_pubkey`, `lnd_node_alias`, `lnd_networks`, `lnd_chains`, `lnd_uris` | Datos del nodo Lightning. `lnd_networks` distingue mainnet de pruebas |
| `y` | `["mostro", "<nombre de la instancia>"]` |
| `z` | `"info"` |

Reglas para la app:

- **Vigencia.** Considera el nodo activo solo si el evento tiene menos de unos 11 minutos (dos publicaciones perdidas). El Manager usa ese mismo umbral.
- **Garantía.** `bond = max(redondeo(bond_amount_pct × sats), bond_base_amount_sats)`. El importe base es un suelo, no un sumando. Con `bond_enabled = false` no hay que mostrar ninguna garantía.
- **Comisión.** Muestra `fee / 2` por parte. `fee_bps` de la tarjeta es el mismo dato en otra unidad.

Evento real de v0.19.2 con la garantía desactivada:

```json
[["d","30b0…5e33"],["mostro_version","0.19.2"],["mostro_commit_hash","e041963fcdc8f8d0be6149edd2e49136df3b87d3"],["max_order_amount","1000000"],["min_order_amount","1000"],["expiration_hours","24"],["expiration_seconds","900"],["fiat_currencies_accepted","USD"],["max_orders_per_response","10"],["fee","0.006"],["pow","0"],["pow_first_contact","0"],["protocol_version","2"],["hold_invoice_cltv_delta","144"],["lnd_version","0.21.3-beta commit=v0.21.3-beta"],["lnd_node_pubkey","0246…1f01"],["lnd_commit_hash","572b…82dc"],["lnd_node_alias","regtest-mostro"],["lnd_chains","bitcoin"],["lnd_networks","regtest"],["lnd_uris",""],["y","mostro","BitMaxis - Regtest"],["z","info"],["invoice_expiration_window","3600"],["hold_invoice_expiration_window","300"],["bond_enabled","false"],["maintenance_mode","false"]]
```

Con la garantía activada y prueba de trabajo de primer contacto, otro nodo v0.19.2 anunció además:

```json
[["pow","0"],["pow_first_contact","8"],["bond_enabled","true"],["bond_amount_pct","0.03"],["bond_base_amount_sats","1000"],["bond_apply_to","both"],["bond_slash_on_waiting_timeout","false"],["bond_slash_node_share_pct","0.5"],["bond_payout_claim_window_days","15"]]
```

### 3.3 Otros eventos del nodo

| Kind | Contenido |
| --- | --- |
| 0 | Nombre, descripción y web de la instancia |
| 10002 | Lista de relays del nodo (un tag `r` por relay conectado). No es fiable como lista completa: solo incluye los relays conectados al publicar |
| 30078, `d = "mostro-rates"` | Cotizaciones BTC/fiat que usa el nodo, `{"BTC":{"USD":84706.4,…}}`, con expiración de 10 minutos |
| 38384 | Valoración acumulada de un usuario tras recibir una valoración: tags `total_reviews`, `total_rating`, `last_rating`, `min_rate`, `max_rate`, `since` y `days`. El nodo las publica en lotes, cada hora por defecto, y con `d` igual a la clave de operación de quien valoró, no a la identidad valorada. Para mostrar reputación usa el tag `rating` de la orden y el payload `peer` |
| 8383 | Auditoría del aporte al desarrollo de Mostro, solo en mainnet |

Para estimar sats en pantalla usa la cotización del propio nodo (kind 30078) y no un proveedor distinto: es el precio con el que el daemon fijará la operación.

## 4. Libro de órdenes (kind 38383)

Evento direccionable firmado por el nodo, con `d` igual al UUID de la orden. Filtro: `{"kinds":[38383],"authors":["<pubkey del nodo>"]}`, opcionalmente con `#s`, `#k` o `#f`.

| Tag | Valor |
| --- | --- |
| `d` | UUID de la orden |
| `k` | `buy` o `sell` |
| `f` | Moneda fiat |
| `s` | Estado público |
| `amt` | Sats. `"0"` si la orden es a precio de mercado y aún no se tomó |
| `fa` | Importe fiat. Dos valores `[mínimo, máximo]` en una orden de rango pendiente |
| `pm` | Un valor por método de pago |
| `premium` | Prima, entero con signo |
| `published_at` | Creación de la orden. No cambia entre revisiones |
| `expires_at` | Fin del plazo para tomarla |
| `expiration` | Expiración NIP-40 del evento |
| `rating` | Solo en pendientes: el texto JSON `["rating", {"total_reviews", "total_rating", "days", "since"}]` de quien publica. `since` es el día de su primera operación, en segundos Unix. Existe desde v0.19.2 y falta si quien publica opera en privacidad total |
| `source` | Solo en pendientes: `mostro:<id>?relays=…&mostro=<pubkey>` |
| `network`, `layer` | Red de LND y `lightning` |
| `y`, `z` | `["mostro", "<nombre>"]` y `"order"` |

**Estados.** El daemon v0.19.2 publica cuatro valores de `s`:

| `s` | Cuándo se publica |
| --- | --- |
| `pending` | Al crear la orden. También mientras quien la toma no ha pagado su garantía |
| `in-progress` | Venta tomada a la espera de la factura del comprador, o compra tomada a la espera del pago del vendedor |
| `success` | Completada, también tras una resolución de un mediador a favor del comprador |
| `canceled` | Cancelada, expirada o devuelta al vendedor por un mediador |

El código reconoce un quinto valor, `completed-by-admin`, pero v0.19.2 nunca lo asigna.

**El tag `s` no sigue la operación.** Los demás estados internos (activa, fiat enviado, disputa…) no generan evento, así que el último valor publicado se mantiene:

- Una orden `in-progress` sigue así mientras está activa, con el fiat enviado o en disputa.
- Una venta tomada **con la factura ya adjunta** en `take-sell` salta la espera de factura y nunca pasa por `in-progress`: figura como `pending` hasta `success` o `canceled`.
- Una orden cuyo tomador se retira antes de enviar su factura **vuelve a publicarse como `pending`**: la secuencia pública es `pending`, `in-progress`, `pending`.

Por eso `pending` no garantiza que la orden siga libre. El estado real de una operación se sigue por los mensajes privados, y un `take-sell` sobre una orden ya tomada recibe `cant-do: invalid_order_status`. Una disputa tampoco cambia `s`: se anuncia aparte (sección 8).

Reemplaza revisiones según NIP-01: gana el `created_at` mayor y, a igualdad, el id menor. El daemon garantiza `created_at` creciente por orden. Para la antigüedad usa `published_at`.

Tres revisiones reales de una misma orden:

| `s` | `amt` | `fa` | `premium` |
| --- | ---: | --- | ---: |
| `pending` | 0 | 50 | 5 |
| `in-progress` | 56076 | 50 | 5 |
| `success` | 56076 | 50 | 5 |

## 5. Mensajes con el nodo: protocolo v2 (kind 14)

### 5.1 Sobre visible

```json
{
  "kind": 14,
  "pubkey": "<clave de la operación>",
  "created_at": 1791063447,
  "tags": [["p", "<pubkey del nodo>"], ["expiration", "<unix>"]],
  "content": "<NIP-44 v2>",
  "sig": "<firma de la clave de la operación>"
}
```

- Autor: la **clave de la operación**, distinta para cada operación. Añade el tag `nonce` de NIP-13 si el nodo exige prueba de trabajo.
- Cifrado: NIP-44 v2 con la clave de conversación entre la clave de la operación y la del nodo.
- Respuestas: el nodo firma con su clave y etiqueta `p` con la clave de la operación. Filtro de suscripción: `{"kinds":[14],"authors":["<nodo>"],"#p":["<claves de operación activas>"]}`.
- Las respuestas expiran en los relays a los 30 días.

### 5.2 Contenido cifrado

Una tupla JSON de tres elementos:

```json
[
  { "order": { "version": 2, "request_id": 634461, "trade_index": 7, "action": "new-order", "payload": { "order": { } } } },
  "<firma de la clave de la operación sobre el JSON del mensaje, o null>",
  ["<pubkey de identidad>", "<firma de identidad>"]
]
```

| Elemento | Contenido |
| --- | --- |
| 1 | El mensaje. Clave superior: `order`, `dispute`, `cant-do`, `rate`, `dm` o `restore` |
| 2 | Firma Schnorr de la clave de la operación sobre el SHA-256 del JSON del elemento 1, o `null` |
| 3 | Prueba de identidad, o `null` en modo de privacidad total |

Campos del mensaje, en este orden: `version` (2), `request_id`, `trade_index`, `id`, `action` en kebab-case y `payload`. mostro-core serializa siempre `trade_index` (con `null` si no se usa) y omite `id` cuando no hay orden todavía.

**Dos modos de identidad:**

- **Reputación.** Clave de identidad estable más una clave por operación. El elemento 3 lleva la clave de identidad y su firma sobre `mostro-transport-v2-identity:<pubkey de la operación en hex>:<JSON del mensaje>`. El elemento 2 es obligatorio. `trade_index` debe ser mayor que el último usado por esa identidad.
- **Privacidad total.** La clave de la operación es la identidad. Elementos 2 y 3 en `null`, sin `trade_index`. Sin reputación.

Las respuestas del nodo llevan siempre `null` en los elementos 2 y 3.

**Serialización canónica.** La firma del elemento 2 y la de identidad se calculan sobre el JSON **tal como lo serializa mostro-core**. El daemon no verifica los bytes recibidos, sino su propia serialización del mensaje, de modo que una app que no use mostro-core debe reproducirla exactamente:

- JSON compacto, sin espacios.
- Mensaje: `version`, `request_id`, `trade_index`, `id`, `action`, `payload`. `request_id`, `trade_index` y `payload` se escriben como `null` cuando faltan. `id` se omite cuando falta.
- Orden dentro de `payload.order`: `kind`, `status`, `amount`, `fiat_code`, `min_amount`, `max_amount`, `fiat_amount`, `payment_method`, `premium`, `created_at`, `expires_at`. `min_amount`, `max_amount`, `created_at` y `expires_at` se escriben como `null` cuando faltan. `id`, `buyer_trade_pubkey`, `seller_trade_pubkey` y `buyer_invoice` se omiten cuando faltan, y van en ese orden: `id` al principio y los otros tres tras `premium`.

Las apps basadas en mostro-core 0.16 (`wrap_message_nip44`) ya lo hacen así. En modo de privacidad total no hay firmas internas y el orden de los campos es indiferente.

Vector de prueba, tomado de una operación real en modo de reputación que el daemon aceptó:

```text
mensaje:              {"order":{"version":2,"request_id":3201652,"trade_index":1,"id":"14fd6884-a025-4165-9571-1fa5c773f22c","action":"take-sell","payload":null}}
clave de operación:   d8edb78f5ab7148d0dceb386c382de6702800689b4842171d1f90dc125695dcd
SHA-256 del mensaje:  6d290cffc9d3817f3da157fc8151871f0d2ba5ecbc780c7179cc01de7dc47163
firma (elemento 2):   5047e5ed3d8154b8732132ee9bced6a120ae840c79aa050c6e9fbcbb56da0d782b470f80841ef45fa5563ba5f985221f49eb85d0b15efe3e2169e67b94de49c1
clave de identidad:   50b1e698415e5d357613052ac9b19da865e7701d0978744aa5e5a96c21151709
texto de identidad:   mostro-transport-v2-identity:d8edb78f5ab7148d0dceb386c382de6702800689b4842171d1f90dc125695dcd:<mensaje>
SHA-256 de ese texto: 2f5d1edb785e335214d28df37b0c383bd3aef9b3f8f699aa3978fd3f281d79a0
firma de identidad:   988ed315f7ce58d25128a89a9446db641a702557d9fa0bb30bc2d5f7b172de68fdafef7fa2017dbb30291409d479792f91e4759bdd00b0e9b7eeba3f78d358eb
```

Ambas son firmas Schnorr BIP-340 en hex sobre los 32 bytes del SHA-256. Un mensaje con cualquiera de las dos alterada no recibe respuesta.

### 5.3 Comprobaciones del daemon y fallos silenciosos

El daemon valida en este orden y, salvo donde se indica, **no responde** cuando algo falla:

1. Prueba de trabajo del evento ≥ `pow`.
2. Kind 14 y firma del evento válida.
3. Evento no repetido en los últimos 60 s.
4. Clave que el nodo no conoce: prueba de trabajo ≥ `pow_first_contact`. Ver la regla más abajo.
5. Descifrado y firmas internas.
6. `created_at` con menos de 10 s de antigüedad.
7. Identidad distinta de la clave de la operación: exige la firma del elemento 2.
8. Modo mantenimiento: responde `cant-do: maintenance_mode`.
9. `trade_index`, solo en `new-order`, `take-sell` y `take-buy`: si no es mayor que el último usado por una identidad conocida, responde `cant-do: invalid_trade_index`. Un índice 0 para una identidad nueva se descarta sin respuesta.
10. Forma del mensaje: una acción sin su `id` o sin el payload que exige (por ejemplo `take-sell` sin `id`, `add-invoice` sin `payment_request`, `new-order` sin `order`) se descarta sin respuesta.
11. Reglas de la acción: aquí sí responde `cant-do` con el motivo.

Los errores internos del daemon, como no tener cotización para la moneda, tampoco se responden.

**Qué clave «conoce» el nodo.** La que participa en una orden no terminada, la que tiene una garantía pendiente y la del mediador asignado a una disputa abierta. El nodo la reconoce en cuanto acepta su `new-order`, `take-sell`, `take-buy` o `admin-take-dispute`, y la olvida uno o dos minutos después de que la orden termine: recalcula la lista cada 60 s por defecto. En un nodo con `pow_first_contact` mayor que `pow`:

- El mensaje que presenta la clave necesita la prueba de primer contacto. Los siguientes de esa operación no.
- Un mensaje enviado **después de cerrarse la orden** vuelve a necesitarla. El caso práctico es la valoración: `rate-user` se aceptó sin prueba justo al terminar la operación y se descartó sin respuesta 135 s después. Con la prueba se aceptó.
- Según la especificación del transporte, la app v1 y mostro-cli no leen `pow_first_contact`. En un nodo que lo fije por encima de `pow`, sus órdenes y tomas se descartan sin respuesta.

Consecuencia para la app: fija un tiempo de espera por petición (la app BitMaxis usa 10 s), trata el silencio como «no aceptado» y ofrece reintentar con un evento nuevo.

### 5.4 Respuesta de rechazo

```json
[{"cant-do":{"version":2,"request_id":62841,"trade_index":null,"action":"cant-do","payload":{"cant_do":"invalid_parameters"}}},null,null]
```

La clave superior es `cant-do`, no `order`. Llega a la clave que envió la petición y repite su `request_id`.

## 6. Crear órdenes

### 6.1 Combinaciones válidas

| Modalidad | `amount` | `fiat_amount` | `min_amount` / `max_amount` | `premium` |
| --- | --- | --- | --- | --- |
| Precio de mercado | `0` | entero > 0 | ausentes | cualquier entero, también negativo o `0` |
| Precio fijo | sats > 0 | entero > 0 | ausentes | `0` |
| Rango | `0` | `0` | ambos, con mínimo < máximo | cualquier entero |

Además:

- `fiat_code` debe estar en `fiat_currencies_accepted` del nodo, salvo que esa lista esté vacía.
- Los sats, fijos o calculados con la cotización del nodo, deben quedar entre `min_order_amount` y `max_order_amount`. En un rango se comprueban los dos extremos. La prima no interviene en esta comprobación.
- `payment_method` es texto libre. El daemon lo parte por comas para el tag `pm`: no pongas comas dentro de un nombre.
- `expires_at` es opcional. Si falta, la orden vive `expiration_hours`.
- Una orden de compra puede incluir `buyer_invoice` (BOLT11, dirección Lightning o LNURL). No es obligatorio.
- Con garantía para quien publica, la respuesta no es `new-order` sino `pay-bond-invoice`. La confirmación `new-order` y el evento público llegan después de pagarla (sección 7.3).

### 6.2 Resultados reales contra v0.19.2

Nodo de prueba: solo USD, mínimo 1 000 sats, máximo 1 000 000 sats, sin garantía.

| Petición `new-order` | Respuesta |
| --- | --- |
| venta, `amount: 112433`, `fiat_amount: 100`, `premium: 5` | `cant-do: invalid_parameters` |
| venta, `amount: 116886`, `fiat_amount: 100`, `premium: 1` | `cant-do: invalid_parameters` |
| venta, `amount: 118055`, `fiat_amount: 100`, `premium: 0` | orden creada a precio fijo |
| venta, `amount: 0`, `fiat_amount: 100`, `premium: 5` | orden creada a precio de mercado |
| venta, `amount: 0`, `fiat_amount: 100`, `premium: 0` | orden creada |
| venta, `amount: 0`, `fiat_amount: 100`, `premium: -3` | orden creada |
| venta, `amount: 0`, `fiat_amount: 0`, `min_amount: 50`, `max_amount: 200`, `premium: 2` | orden de rango creada |
| compra, `amount: 0`, `fiat_amount: 100`, `premium: 3`, sin factura | orden creada |
| venta en `EUR` | `cant-do: invalid_fiat_currency` |
| venta de 2 000 USD (más de 1 000 000 sats) | `cant-do: out_of_range_sats_amount` |
| `fiat_amount: 0` sin rango | `cant-do: invalid_amount` |
| solo `min_amount` | `cant-do: invalid_amount` |
| rango con `amount: 50000` | `cant-do: invalid_amount` |

Las dos primeras filas son exactamente lo que enviaba el flujo de venta simple de la app BitMaxis. Es el origen del error «parámetro inválido: la prima de venta no es válida».

### 6.3 Precio, prima y comisión

```text
sats_base  = fiat_amount / precio_BTC_en_fiat × 100 000 000
sats       = truncar(sats_base × (1 − premium / 100))
comisión   = redondear(fee × sats / 2)        por cada parte
vendedor paga   sats + comisión               factura retenida
comprador cobra sats − comisión
```

- La fórmula es la misma para compra y venta. **Prima positiva: menos sats por el mismo fiat**, es decir, bitcoin más caro, favorable a quien vende. Prima negativa: más sats, favorable a quien compra.
- El daemon aplica `1 − premium/100`. No es `1 / (1 + premium/100)`: con un 10 % la diferencia ronda el 1 %.
- El precio de una orden de mercado se fija **al tomarla**, no al publicarla.

Operación real: 50 USD con prima +5 % y comisión 0,6 %, cotización 84 706,4 USD.

| Concepto | Sats |
| --- | ---: |
| Importe de la operación | 56 076 |
| Comisión por parte | 168 |
| Factura retenida que pagó el vendedor | 56 244 |
| Lo que recibió la factura del comprador | 55 908 |

### 6.4 Validación recomendada en la app antes de enviar

- Rechazar `amount_sats > 0` junto con `premium ≠ 0`.
- Exigir importe fiat entero ≥ 1 y prima entera. No truncar en silencio.
- No publicar con un importe por defecto si el campo está vacío o no se puede leer.
- Comprobar la moneda contra `fiat_currencies_accepted` y los sats estimados contra los límites del nodo, avisando de que el precio definitivo lo fija el nodo.
- Comprobar `maintenance_mode` y la vigencia del evento de información.

## 7. Ciclo de una operación

Secuencias reales, ejecutadas contra v0.19.2. «→» es un mensaje al nodo y «←» del nodo.

### 7.1 Orden de venta tomada por un comprador

| Paso | Vendedor (publica) | Comprador (toma) | `s` público |
| --- | --- | --- | --- |
| 1 | → `new-order` | | |
| 2 | ← `new-order` con `id` y la orden en `pending` | | `pending` |
| 3 | | → `take-sell` con `id` | |
| 4 | ← `waiting-buyer-invoice` | ← `add-invoice`: orden en `waiting-buyer-invoice` con `amount` = sats a cobrar | `in-progress` |
| 5 | | → `add-invoice` con `payment_request: [null, "<bolt11>", null]` | |
| 6 | ← `pay-invoice` con `payload.peer` (reputación de quien tomó) | | |
| 7 | ← `pay-invoice` con `payment_request: [orden, "<factura retenida>", null]` | ← `waiting-seller-to-pay` | |
| 8 | paga la factura retenida | | |
| 9 | ← `buyer-took-order`, orden `active` | ← `hold-invoice-payment-accepted`, orden `active` | |
| 10 | | → `fiat-sent` | |
| 11 | ← `fiat-sent-ok` | ← `fiat-sent-ok` | |
| 12 | → `release` | | |
| 13 | ← `hold-invoice-payment-settled` | ← `released` | |
| 14 | ← `rate` | ← `purchase-completed`, ← `rate` | `success` |

Detalles que una app debe contemplar:

- **`pay-invoice` llega dos veces** (pasos 6 y 7). El primero solo trae `payload.peer`, con `pubkey` vacío y la reputación de quien tomó. La factura está en el segundo, dentro de `payload.payment_request[1]`. No asumas que todo `pay-invoice` trae factura.
- El `amount` que ve cada parte difiere: el vendedor ve sats más su comisión y el comprador sats menos la suya.
- En el paso 9 la orden incluye `buyer_trade_pubkey` y `seller_trade_pubkey`. Con ellas se deriva el chat entre las partes, que el nodo no puede leer. `fiat-sent-ok` repite la clave de la otra parte en `payload.peer.pubkey`.
- El `peer` del paso 6 trae siempre `reputation: {"rating", "reviews", "operating_days"}`. Si quien tomó opera en modo de reputación incluye además `since`. En privacidad total los valores son cero.
- La factura retenida del paso 7 trae una expiración de 24 horas. El plazo real para pagarla es `expiration_seconds` desde la toma: pasado ese tiempo el nodo cancela la operación.
- **Factura adjunta.** El comprador puede adjuntar su factura ya en `take-sell` (`payment_request: [null, "<bolt11>", null]`) y saltarse los pasos 4 a 6. En una orden a precio de mercado aún no conoce los sats, así que la factura debe ser **sin importe**: el nodo le pagó `sats − comisión`. En este camino el vendedor recibe un solo `pay-invoice` y la orden no se publica como `in-progress` (sección 4).
- **Orden de rango.** Para tomarla hay que indicar el importe fiat, entre el mínimo y el máximo: `payload: {"amount": <fiat>}`, o `payment_request: [null, "<bolt11>", <fiat>]` si se adjunta la factura. Sin importe la respuesta es `cant-do: out_of_range_sats_amount`. Al tomarla, el evento público pasa a llevar ese único importe en `fa`.

### 7.2 Orden de compra tomada por un vendedor

| Paso | Comprador (publica) | Vendedor (toma) | `s` público |
| --- | --- | --- | --- |
| 1 | → `new-order` con `kind: "buy"` | | |
| 2 | ← `new-order` con `id` y la orden en `pending` | | `pending` |
| 3 | | → `take-buy` con `id` | |
| 4 | ← `waiting-seller-to-pay` | ← `pay-invoice` con `payment_request: [orden, "<factura retenida>", null]` | `in-progress` |
| 5 | | paga la factura retenida | |
| 6 | ← `add-invoice`: orden en `waiting-buyer-invoice` con `amount` = sats a cobrar | ← `waiting-buyer-invoice` | |
| 7 | ← `add-invoice` con `payload.peer` (reputación de quien tomó) | | |
| 8 | → `add-invoice` con `payment_request: [null, "<bolt11>", null]` | | |
| 9 | ← `hold-invoice-payment-accepted`, orden `active` | ← `buyer-took-order`, orden `active` | |
| 10 | → `fiat-sent` | | |
| 11 | ← `fiat-sent-ok` | ← `fiat-sent-ok` | |
| 12 | | → `release` | |
| 13 | ← `released`, ← `purchase-completed`, ← `rate` | ← `hold-invoice-payment-settled`, ← `rate` | `success` |

- Aquí es **`add-invoice`** el que llega dos veces al comprador (pasos 6 y 7): uno pide la factura y el otro solo informa de la reputación del vendedor.
- Si el comprador incluye `buyer_invoice` al crear la orden, los pasos 6 a 8 desaparecen: al pagarse la factura retenida la operación pasa directamente a activa. En una orden a precio de mercado esa factura debe ser sin importe.

### 7.3 Con garantía (bond)

Cuando el evento de información anuncia `bond_enabled = true`, la parte que indique `bond_apply_to` paga antes una factura retenida de garantía. Secuencia real con `bond_apply_to = both`, 3 % y mínimo de 1 000 sats, en una operación de 35 186 sats:

| Momento | Mensaje | Qué hace la app |
| --- | --- | --- |
| Quien publica envía `new-order` | ← `pay-bond-invoice` con `payment_request: [orden, "<bolt11>", null]` | Pagar la factura. La orden aún no existe en los relays |
| Garantía de quien publica pagada | ← `new-order` con la orden en `pending` | La orden ya es pública |
| Quien toma envía `take-sell` o `take-buy` | ← `pay-bond-invoice` | Pagar la factura. La orden sigue `pending` y otro usuario puede adelantarse |
| Garantía de quien toma pagada | sigue el flujo normal (`add-invoice` o `pay-invoice`) | |
| La operación termina sin penalización | ningún mensaje | El nodo cancela ambas facturas de garantía: los sats nunca salieron del canal |

- En `pay-bond-invoice` la orden embebida es solo un soporte: `amount` son los **sats de la garantía** (1 056 en el ejemplo) y `status` es `pending` como valor neutro. No la muestres como el importe de la operación.
- La factura de garantía lleva el memo `mostro bond order_id=<id>`.
- Plazo: la de quien publica expiró a los 900 s y la de quien toma a los 300 s (`hold_invoice_expiration_window`). El plazo de quien publica no se anuncia en el evento de información: léelo de la propia factura.
- Importe: `max(redondeo(bond_amount_pct × sats), bond_base_amount_sats)`.
- Si dos usuarios toman la orden a la vez, ambos reciben `pay-bond-invoice`. Gana quien paga primero. El otro recibe `canceled` y su factura de garantía se cancela sin cobrarse.
- Quien toma y se retira con `cancel` antes de enviar su factura recupera su garantía.
- Tras una disputa resuelta con `admin-settle` sin penalización, ambas garantías se devolvieron igual.

**Penalización.** Un mediador puede ejecutar la garantía de una parte al resolver una disputa (sección 8). Secuencia real con una garantía de 1 054 sats y `bond_slash_node_share_pct = 0.5`:

| Paso | Mensaje | Contenido |
| --- | --- | --- |
| 1 | Parte penalizada ← `bond-slashed` | `payload.order.amount` = sats de la garantía perdida, 1 054 |
| 2 | Otra parte ← `add-bond-invoice` | `payload.bond_payout_request: {"order": {…, "amount": 527}, "slashed_at": <unix>}` |
| 3 | Otra parte → `add-bond-invoice` | `payload.payment_request: [null, "<bolt11 de 527 sats>", null]` |
| 4 | Otra parte ← `bond-invoice-accepted` | orden con `amount` = 527 |
| 5 | Otra parte ← `bond-payout-completed` | orden con `amount` = 527. La factura quedó pagada |

- El nodo se queda con su parte, `bond_slash_node_share_pct`, y ofrece el resto a la otra parte.
- El paso 2 llega hasta un minuto después de la resolución. La factura del paso 3 debe ser por el importe exacto de `amount`.
- El plazo para reclamar termina en `slashed_at + bond_payout_claim_window_days × 86 400`.
- En estos mensajes la orden lleva `status: null`, y `amount` no es el importe de la operación.
- La garantía de la parte no penalizada se devuelve.

### 7.4 Cancelaciones

| Situación | Mensajes | Efecto |
| --- | --- | --- |
| Quien publica cancela una orden sin tomar | → `cancel`; ← `canceled` | `s` público `canceled` |
| Quien tomó se retira antes de enviar su factura | → `cancel`; ← `canceled`. Quien publicó recibe otra vez ← `new-order` con la misma `id` | La orden vuelve a `pending` y se puede tomar de nuevo |
| Quien tomó deja vencer `expiration_seconds` sin enviar su factura | El nodo actúa solo: quien tomó ← `canceled` y quien publicó ← `new-order` con la misma `id`. Con un plazo de 900 s llegaron a los 915 s | La orden vuelve a `pending`. Con `bond_slash_on_waiting_timeout = false` la garantía de quien tomó se devuelve |
| Cancelación de mutuo acuerdo con la operación activa | A → `cancel`: A ← `cooperative-cancel-initiated-by-you`, B ← `cooperative-cancel-initiated-by-peer`. B → `cancel`: ambos ← `cooperative-cancel-accepted` | Tras el primer `cancel` el depósito sigue retenido. Tras el segundo, el nodo lo cancela y los sats vuelven al vendedor. `s` público `canceled` |

La app de quien publica debe aceptar un segundo `new-order` para una orden que ya conoce: significa que vuelve a estar libre.

Según el código, cuando quien deja vencer el plazo es quien publicó, la orden no vuelve a ofrecerse: se cancela. Ese caso no se ejecutó.

### 7.5 Valoraciones

Tras `success` el nodo envía `rate` a cada parte. La app responde con `rate-user`, el `id` de la orden y `payload: {"rating_user": <1 a 5>}`. El nodo confirma con `rate-received` y el mismo payload.

- Cada parte valora una sola vez por orden. Una segunda valoración no recibe respuesta.
- La valoración se acumula en la **identidad** de la otra parte. Si esa parte opera en privacidad total no hay nada que acumular y el nodo no responde.
- El resultado se ve en el tag `rating` de la siguiente orden que esa identidad publique. Tras una única valoración de 5, el nodo anunció `{"total_reviews":1,"total_rating":2.5}`: el valor no es una media simple.
- En un nodo con `pow_first_contact`, envía la valoración en cuanto llegue `rate` o mina la prueba de primer contacto (sección 5.3).

## 8. Disputas

Cualquiera de las partes envía `{"dispute":{"version":2,"request_id":…,"trade_index":null,"id":"<id de la orden>","action":"dispute","payload":null}}`.

El nodo responde a quien la abre con `dispute-initiated-by-you` y a la otra parte con `dispute-initiated-by-peer`. Ambos son mensajes `order` con `id` de la orden y `payload: {"dispute": ["<id de la disputa>", null]}`.

A la vez publica un evento **kind 38386** con `d` igual al id de la disputa:

| Tag | Valor |
| --- | --- |
| `s` | `initiated`, `in-progress`, `settled`, `seller-refunded`, `released` o `cooperatively-canceled` |
| `initiator` | `buyer` o `seller` |
| `published_at` | Apertura de la disputa |
| `y`, `z` | `["mostro", "<nombre>"]` y `"dispute"` |

El evento público **no nombra la orden**. La relación entre disputa y orden solo aparece en los mensajes privados.

Resolución, ejecutada en regtest con la clave del nodo como administrador:

| Paso | Mensaje | Efecto |
| --- | --- | --- |
| 1 | Mediador → `admin-take-dispute` con `id` de la **disputa** | Disputa `in-progress`. Las partes reciben `admin-took-dispute` con `payload.peer.pubkey` del mediador |
| 2a | Mediador → `admin-settle` con `id` de la orden | El nodo cobra la factura retenida y paga al comprador. Partes: `admin-settled`. Comprador: `purchase-completed`. Disputa `settled`, orden `success` |
| 2b | Mediador → `admin-cancel` con `id` de la orden | El nodo cancela la factura retenida y los sats vuelven al vendedor. La factura del comprador queda sin pagar. Partes: `admin-canceled`. Disputa `seller-refunded`, orden `canceled` |

Qué debe hacer la app:

- Guardar el id de la disputa que llega en `dispute-initiated-by-*`.
- Al recibir `admin-took-dispute`, abrir el chat de disputa con la clave del mediador. Si esa clave coincide con el tag `serbero` del evento de información, es el asistente automático del nodo y no una persona.
- Tratar `admin-settled` y `admin-canceled` como cierres definitivos.

En un nodo con `pow_first_contact` mayor que cero, el `admin-take-dispute` también es un primer contacto: sin la prueba de trabajo el nodo no responde. Una vez tomada la disputa, el `admin-settle` se aceptó sin ella.

Con garantías activas, el mediador puede añadir a `admin-settle` o `admin-cancel` el payload `{"bond_resolution": {"slash_seller": <bool>, "slash_buyer": <bool>}}` para penalizar a una parte. Sin ese payload no se penaliza a nadie. La secuencia que sigue está en la sección 7.3.

## 9. Errores

Motivos de `cant-do` que una app de compraventa verá, con el texto sugerido para el usuario:

| Motivo | Cuándo | Qué decir |
| --- | --- | --- |
| `invalid_parameters` | Sats fijos junto con prima | «La orden no puede llevar sats fijos y prima a la vez» |
| `invalid_amount` | Fiat ≤ 0, rango incompleto o invertido, rango con sats fijos | «Importe no válido» |
| `invalid_fiat_currency` | Moneda no admitida por el nodo | «Esta comunidad no opera en esa moneda» |
| `out_of_range_sats_amount` | Sats fuera de los límites, o importe fuera del rango al tomar | «El importe está fuera de los límites de la comunidad» |
| `price_too_stale` | El nodo no tiene cotización reciente | «No hay cotización reciente. Inténtalo en unos minutos» |
| `invalid_invoice` | Factura mal formada, vencida o de otro importe | «La factura no es válida para este importe» |
| `pending_order_exists` | Quien toma ya tiene otra operación a medias | «Termina tu operación en curso antes de tomar otra» |
| `invalid_order_status`, `not_allowed_by_status` | La orden ya no admite esa acción | «La orden ya no está disponible» |
| `is_not_your_order` | La clave no participa en la orden | «Esta orden no es tuya» |
| `invalid_pubkey` | Al tomar: es tu propia orden. En `fiat-sent` o `dispute`: la clave no es la parte esperada | «No puedes tomar tu propia orden» o «Esta acción no te corresponde» |
| `invalid_peer` | La acción corresponde a la otra parte (`release` solo el vendedor, `add-invoice` solo el comprador) | «Esta acción corresponde a la otra parte» |
| `not_found` | La orden no existe en este nodo | «La orden no existe o ya no está disponible» |
| `invalid_trade_index` | Índice ya usado | Resincronizar el índice y reintentar |
| `maintenance_mode` | El nodo está en mantenimiento | «La comunidad no acepta operaciones nuevas por mantenimiento» |
| `unknown` | Motivo de un daemon más reciente | Mostrar un error genérico, no fallar |

No muestres al usuario el texto crudo de la excepción. Un mensaje como `Order rejected by Mostro: InvalidParameters` no le dice qué corregir.

## 10. Qué mostrar de comisiones y garantía

| Dato en pantalla | Origen | Cálculo |
| --- | --- | --- |
| Comisión del usuario | tag `fee` | `fee / 2 × sats` |
| Sats estimados | kind 30078 del nodo | fórmula de la sección 6.3, con «≈» |
| Límites | `min_order_amount`, `max_order_amount` | directos |
| Monedas | `fiat_currencies_accepted` | vacío = todas |
| Garantía | `bond_enabled` y tags `bond_*` | `max(pct × sats, base)`, solo para la parte que indique `bond_apply_to` |
| Plazo para pagar o enviar la factura | `expiration_seconds` | segundos desde que se toma la orden |
| Plazo para pagar la garantía | la expiración de la propia factura de garantía | quien toma: `hold_invoice_expiration_window`. Quien publica: un plazo del nodo que no se anuncia |

Si falta el evento de información, la app no debe inventar valores. Debe decir que no puede contactar con la comunidad.

## 11. Diagnóstico rápido

| Síntoma | Causa probable | Dónde mirar |
| --- | --- | --- |
| `invalid_parameters` al publicar | Sats fijos y prima en la misma orden | Sección 6 |
| El error aparece solo a veces | La app envía sats cuando ya cargó la cotización y `0` cuando no | Sección 6.2 y anexo A |
| Sin respuesta al publicar o al tomar | Reloj del dispositivo atrasado más de 10 s, prueba de trabajo insuficiente, relay distinto del que escucha el nodo, o cliente de protocolo 1 | Sección 5.3 |
| Sin respuesta solo en el primer mensaje de cada operación | El nodo anuncia `pow_first_contact` y la app no lo mina | Sección 5.3 |
| Sin respuesta en modo de reputación y sí en privacidad total | La firma interna no se calcula sobre la serialización canónica | Sección 5.2 |
| La valoración no recibe `rate-received` | La otra parte opera en privacidad total, ya se valoró, o falta la prueba de primer contacto tras el cierre | Secciones 7.5 y 5.3 |
| La orden se publica y nadie la ve | La app y el nodo no comparten relay | Tarjeta y kind 10002 |
| La app muestra garantía y el nodo no la exige | Valor fijo en la app en lugar de `bond_enabled` | Sección 3.2 |
| La app muestra otra versión u otros límites | Lee un evento de información antiguo o de otra clave | Comparar `pubkey` y `created_at` |
| La tarjeta no verifica | Cadena canónica distinta o relay con barra final | Sección 3.1 |
| El pago al comprador no sale | Sin ruta dentro de `max_routing_fee`, o sin liquidez saliente en el nodo | Panel de liquidez del Manager |

Para el operador: en el Manager, la tarjeta del daemon muestra la versión que el nodo **anuncia** en los relays y hace cuánto. Si dice «sin anuncio», las apps verán el nodo como inactivo aunque el contenedor esté en marcha.

## 12. Qué se verificó y cómo

Ejecutado el 3 y el 4 de octubre de 2026 con `mostrod` v0.19.2 oficial (SHA-256 `4d9aa45b…c071` para amd64), LND 0.21.3-beta y Bitcoin Core 31.1 en regtest, con un relay local y un cliente de prueba propio, independiente de mostro-core. El `settings.toml` lo generó siempre el Manager. Salvo donde se indica, el cliente operó en modo de privacidad total.

En un nodo sin garantía ni prueba de trabajo, como el de BitMaxis:

- Arranque del daemon y publicación de kinds 0, 10002, 38385 y 30078.
- Las trece peticiones `new-order` de la sección 6.2.
- Una venta completa con prima +5 %, con los importes de la sección 6.3.
- Una venta tomada con la factura adjunta y sin importe.
- Una orden de rango, tomada sin importe y con importe.
- Una compra tomada con `take-buy` hasta `success`.
- Cancelación por quien publica, retirada de quien tomó y cancelación de mutuo acuerdo.
- Tomar la propia orden, tomar una orden ya tomada y actuar sobre una orden inexistente.
- Mensajes descartados sin respuesta: sin `id`, sin payload y con `created_at` 60 s atrás. Con 8 s de antigüedad se aceptó.
- Dos disputas: una resuelta con `admin-settle` y otra con `admin-cancel`.

En un segundo nodo con garantía del 3 % para ambas partes y `pow_first_contact = 8`:

- El evento de información con todos los tags `bond_*` y de prueba de trabajo.
- `new-order`, `take-sell` y `admin-take-dispute` sin prueba de trabajo: sin respuesta. Con ella: aceptados. Los mensajes siguientes se aceptaron sin ella.
- Una venta completa con las dos garantías, devueltas al terminar.
- Una compra con la factura del comprador incluida al crear la orden.
- Dos tomas simultáneas de la misma orden.
- El vencimiento del plazo de quien tomó, con la orden de nuevo en `pending`.
- Una disputa resuelta con `admin-settle` sin penalización y otra con `admin-cancel` y penalización, hasta `bond-payout-completed`.
- En **modo de reputación**, con clave de identidad, una clave por operación, firma interna y prueba de identidad: una venta completa con garantías, las valoraciones de la sección 7.5, el rechazo de un `trade_index` repetido, el tag `rating` de la siguiente orden, la publicación del kind 38384 y el descarte de mensajes con una firma alterada.

En ambos nodos, el monitor de órdenes, el de disputas y la consola de mensajes del Manager leyeron esos mismos eventos, y la tarjeta del Manager se verificó con una copia del verificador de la app (`k256`).

Leído en el código y no ejecutado: la penalización automática por vencimiento (`bond_slash_on_waiting_timeout = true`), el vencimiento cuando falla quien publicó, el modo mantenimiento, la restauración de sesión, Cashu y Serbero.

No verificado: el comportamiento de relays `ws://` desde una PWA servida por HTTPS, y la app BitMaxis en ejecución. Sus hallazgos proceden de leer su código.

## Anexo A. Hallazgos en la app BitMaxis

Sobre el árbol de trabajo de `mostro-app` en la rama `feat/bitmaxis-only` a 2026-10-04. Los números de línea pueden haber cambiado.

**A1. Venta simple: sats fijos junto con prima (bloqueante).** `lib/features/simple_mode/widgets/simple_sell_confirm_sheet.dart:55-64` construye la orden con `premium: widget.premium` y `amountSats: estimatedSats`. Con cualquier prima distinta de cero el nodo responde `invalid_parameters`. Si la cotización no ha cargado, `estimatedSats` es nulo y la orden sí se acepta, por eso el fallo parece intermitente.

El parche está en [`docs/patches/bitmaxis-app-venta-simple-prima.patch`](patches/bitmaxis-app-venta-simple-prima.patch) y aplica limpio sobre ese árbol. Desde la raíz del repositorio de la app:

```bash
git apply /ruta/a/mostro-community-umbrel/docs/patches/bitmaxis-app-venta-simple-prima.patch
```

```diff
--- a/lib/features/simple_mode/widgets/simple_sell_confirm_sheet.dart
+++ b/lib/features/simple_mode/widgets/simple_sell_confirm_sheet.dart
@@ -58,9 +58,11 @@
         fiatCode: widget.fiatCode,
         paymentMethod: widget.paymentMethod,
         premium: widget.premium,
-        amountSats: widget.estimatedSats != null
-            ? BigInt.from(widget.estimatedSats!)
-            : null,
+        // El modo simple publica siempre a precio de mercado: el nodo fija
+        // los sats al tomar la orden y aplica la prima. Sats fijos con prima
+        // se rechazan con cant-do invalid_parameters. `estimatedSats` es
+        // solo para mostrar.
+        amountSats: null,
       );
 
       final order = await rust_orders.createOrder(params: params);
```

**A2. Venta simple con prima 0: precio congelado.** El mismo código publica una orden de precio fijo con los sats calculados en el teléfono, aunque la interfaz la presenta como «al mercado». El cambio de A1 lo corrige.

**A3. Importe por defecto y decimales.** `lib/features/simple_mode/screens/simple_sell_screen.dart:448` usa `parsedAmount ?? 100.0`: con el campo vacío o con coma decimal publica 100 unidades. El botón nunca se desactiva. `rust/src/mostro/actions.rs:62-64` convierte fiat y prima a entero truncando. Hay que exigir un entero ≥ 1 y rechazar el resto.

**A4. Defensa en el núcleo Rust.** Añadir en `create_order_once` (`rust/src/api/orders.rs`) el rechazo de `amount_sats > 0` con prima distinta de cero y de importes o primas no enteros, con marcadores que la interfaz pueda traducir.

**A5. Errores sin traducir.** `rust/src/api/orders.rs:4290-4317` solo da texto propio a nueve motivos. El resto, incluidos `InvalidParameters`, `InvalidFiatCurrency`, `PriceTooStale` y `PendingOrderExists`, llega como `Order rejected by Mostro: <motivo>`, y las hojas del modo simple muestran `e.toString()`. Usar la tabla de la sección 9.

**A6. Estimación de sats.** `simple_sell_screen.dart:78-84` calcula `fiat / (precio × (1 + prima/100))`. El nodo calcula `fiat / precio × (1 − prima/100)`. Usar la fórmula del nodo.

**A7. Garantía fija del 3 %.** `simple_buy_screen.dart:304`, `simple_sell_screen.dart:454` y `simple_sell_confirm_sheet.dart:26,204` muestran un 3 % cuando no hay perfil de comunidad. El nodo BitMaxis anuncia `bond_enabled = false`. Leer la política del evento de información.

**A8. Tarjeta sin verificar.** `verify_community_signature` existe en `rust/src/api/community.rs` pero ninguna pantalla lo llama. Al importar un `nprofile`, `parse_nip19_community` inventa moneda USD, comisión de 60 puntos básicos y garantía del 3 %. Si se recupera el flujo de tarjeta: verificar la firma, mostrar «verificada» solo si es válida y no rellenar comisiones ni garantía con valores inventados.

**A9. Valoración tras el cierre en nodos con prueba de primer contacto.** La app ya mina `pow_first_contact` al crear y tomar órdenes. `rate_user` (`rust/src/mostro/actions.rs:260`) usa en cambio la dificultad general. Uno o dos minutos después del cierre el daemon ya no reconoce la clave de la operación, y en un nodo con `pow_first_contact` mayor que `pow` la valoración se pierde sin respuesta (sección 5.3). Envolver `rate-user` con la dificultad de primer contacto. No afecta al nodo BitMaxis mientras mantenga ambos valores en 0.

## Anexo B. Nodo BitMaxis en producción

Datos públicos leídos de sus tres relays el 2026-10-04, antes de la actualización:

| Dato | Valor |
| --- | --- |
| Clave pública | `001bd4747d7d265edfe3bd3b7299886146ad850d51095fe77b763c32015685b9` |
| Relays | `wss://relay.mostro.network`, `wss://mostro-p2p.tech`, `wss://relay.shadowbip.com` |
| Versión anunciada | 0.19.0 |
| Red | mainnet |
| Moneda | USD |
| Límites | 1 000 a 1 000 000 sats |
| Comisión | 0,006 en total, 0,3 % por parte |
| Garantía | desactivada |
| Prueba de trabajo | `pow = 0` y `pow_first_contact = 0` |

Tras instalar la versión del Manager que incluye mostrod v0.19.2, `mostro_version` debe pasar a `0.19.2`. Ninguna regla de esta guía cambia entre 0.19.0 y 0.19.2: el protocolo, los eventos y las validaciones de órdenes son los mismos.

## Anexo C. Cambios de mostrod entre v0.19.0 y v0.19.2 visibles para una app

- Nuevo tag opcional `serbero` en el evento de información.
- Nuevo campo `since` junto a `days` en la reputación: tag `rating` de las órdenes, evento 38384 y payload `peer`. `days` sigue presente.
- Cancelar una orden en espera de pago cuando el vendedor acaba de pagar la factura retenida devuelve ahora `cant-do: not_allowed_by_status`.
- Abrir una disputa mientras la orden cambia de estado puede devolver `cant-do: not_allowed_by_status`.
- El aporte al desarrollo solo se paga con LND en mainnet.

Sin cambios en el transporte, en los kinds, en los estados públicos ni en las reglas de `new-order`.
