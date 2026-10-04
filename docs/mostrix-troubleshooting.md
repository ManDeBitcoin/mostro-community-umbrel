# Órdenes de Mostrix y estado del daemon

> La regla de sats fijos y prima vale para cualquier cliente, también la Mostro App de BitMaxis. Se reprodujo contra mostrod v0.19.2: ver [INTEGRACION-APPS.md](INTEGRACION-APPS.md), sección 6.

## `Invalid parameters` al crear una orden

Mostro rechaza una orden con `amount != 0` y `premium != 0`. La función
`SmallOrder::check_zero_amount_with_premium` devuelve `InvalidParameters`:
el premium solo se aplica cuando los sats se calculan a precio de mercado.
No se habilita esta combinación cambiando las reglas del Manager.

Para el ejemplo de compra por PayPal de las capturas:

| Modalidad | Amount (sats) | Fiat | Premium |
| --- | ---: | --- | ---: |
| Importe fijo | 10000 | 5 USD | 0 |
| Precio de mercado | 0 | 5 USD | 10 |

La segunda opción no conserva los 10.000 sats: necesita una cotización
disponible y el resultado debe cumplir los límites del nodo. El premium no
es la comisión de Mostro. Estas alternativas corrigen esa validación; no
demuestran que se haya creado una orden ni liquidado una operación.

Referencias de código verificadas:

- [Validación del daemon en el commit mostrado por Mostrix](https://github.com/MostroP2P/mostro/blob/5b07be2a107b3bc5a66d9ffb7ec4bb5bb8695b47/src/app/order.rs).
- [Validación en Mostro v0.18.8](https://github.com/MostroP2P/mostro/blob/v0.18.8/src/app/order.rs) y, sin cambios, en [v0.19.2](https://github.com/MostroP2P/mostro/blob/v0.19.2/src/app/order.rs) con `mostro-core 0.16.0`.
- [Contrato de SmallOrder](https://github.com/MostroP2P/mostro-core/blob/main/src/order.rs), también comprobado en la dependencia fijada `mostro-core 0.14.6` de v0.18.8.

## La información del cliente no coincide con el Manager

Las capturas anuncian daemon **0.17.5**, máximo **100.000 sats** y ventana
de factura **300 segundos**. El paquete del Manager fijaba entonces **0.18.8**
(hoy fija la versión indicada en `config/versions.json`).
La configuración activa local inspeccionada durante este diagnóstico
tenía máximo **1.000.000 sats** y ventana **3.600 segundos**. Esto demuestra
que los datos no coinciden; por sí solo no identifica qué contenedor responde
ni descarta información histórica del relay.

1. Comparar el identificador hex/npub y los relays del panel con Mostrix.
2. Revisar la fecha de Mostro Info y contrastar versión, límites y monedas
   anunciadas con la configuración aplicada al daemon.
3. Consultar la versión real del contenedor de Mostro y sus registros de
   arranque. El binario empaquetado o un archivo de configuración no prueban
   qué instancia está respondiendo.
4. Si existe otro daemon con la misma identidad, revisar primero su estado
   de operaciones y persistencia antes de cualquier migración o reinicio.

Desde la versión 1.0.12 el panel hace esa comparación por ti: la tarjeta del
daemon muestra la versión que el nodo **anuncia** en los relays (su evento
kind 38385) y hace cuánto, y avisa si esa versión no coincide con el binario
del paquete o si alguien anuncia la identidad sin que el panel vea el daemon.

El Manager distingue configuración preparada de ejecución observada. La API
del dashboard no inventa una versión ni declara el servicio conectado por
encontrar `active/settings.toml`. `configuration_active` indica que ese archivo
existe; `market_started` solo pasa a `true` cuando el daemon ha anunciado su
evento de información en los relays en los últimos minutos.
Una respuesta RPC informa conectividad y versión, pero no prueba recepción de
órdenes. La detección de proceso en `/proc` solo cubre el entorno visible al
Manager: en Umbrel el daemon tiene un contenedor separado.

Guardar de nuevo la configuración tampoco confirma que un daemon existente
la haya recargado. La supervisión entre contenedores y la comprobación completa
de operaciones siguen requiriendo verificación operativa.
