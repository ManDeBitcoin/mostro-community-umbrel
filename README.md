# Mostro Community Manager for Umbrel

Panel para preparar comunidades Mostro. **Vista previa:** guarda borradores de configuración; todavía no inicia mercados ni gestiona operaciones financieras.

## Instalar en Umbrel

Este repositorio también es una tienda comunitaria de una sola aplicación.

**Disponible: [0.1.0-preview.6](https://github.com/ManDeBitcoin/mostro-community-umbrel/releases/tag/v0.1.0-preview.6).** Imágenes amd64 y arm64 probadas, fijadas por digest y con descarga anónima verificada. [Compilación y pruebas](https://github.com/ManDeBitcoin/mostro-community-umbrel/actions/runs/36324500916).

1. En Umbrel, abrir **App Store → Community App Stores / Tiendas comunitarias**.
2. Añadir `https://github.com/ManDeBitcoin/mostro-community-umbrel`.
3. Instalar **Mostro Community Manager**.
4. Comprobar que la ficha muestre **0.1.0-preview.6** o posterior y abrirlo desde Umbrel.

Si intentaste instalar `0.1.0-preview.1` y recibiste 403, actualiza la tienda antes de reintentar. Si Umbrel conserva la instalación fallida y sigue solicitando la imagen antigua, elimina únicamente la instalación fallida de **Mostro Community Manager** y vuelve a instalarla. La instalación independiente de Mostro no forma parte de ese paquete.

ID estable de la aplicación: `mandebitcoin-mostro-manager`. Puerto del panel: `5173`, gestionado por `app_proxy`. No configurar un proxy público directo al contenedor. Datos exclusivos en `${APP_DATA_DIR}/data/config`.

El paquete está en [`mandebitcoin-mostro-manager/`](mandebitcoin-mostro-manager/); los archivos de la raíz son para desarrollo. Depende de la app Lightning de Umbrel para sus consultas de lectura; todavía no usa Bitcoin directamente ni ejecuta operaciones.

## Si ya tienes Mostro funcionando

Puedes conservar tu instalación. El Manager se empaqueta sin daemon Mostro, no monta sus claves ni su base de datos, no abre RPC y solo consulta LND mediante su macaroon de lectura. La API del panel permanece en una red interna; un puente de destino fijo permite consultar LND con TLS.

Esto permite probar el panel por separado. **Instalarlo no importa ni administra automáticamente el Mostro existente.** Antes de conectar esa instancia se debe inventariar versión, red, método de ejecución, estado de operaciones, identidad LND y backups. No arrancar un segundo daemon con la misma identidad, DB o estado financiero. Ver [convivencia y futura conexión](docs/coexistence.md).

## Incluye

- Panel React en español y API Rust/Axum.
- Borrador persistente: comunidad, monedas, límites, comisiones, bonds, relays y catálogo de pagos.
- Validación, revisión optimista, escritura atómica y copia de la revisión anterior.
- Consulta de lectura al LND de Umbrel: sincronización, red, canales y saldos agregados, sin acceso de administración al nodo. El adaptador Mostro aún no está conectado en el paquete.
- Contratos y renderer TOML fijados a Mostro v0.18.8; todavía sin aplicar configuraciones al daemon.

Pendientes: backup cifrado de la identidad, inicio de mercado, trades, disputas, Telegram, upgrades y pruebas E2E regtest. [Estado del blueprint](docs/roadmap.md).

## Desarrollo local

Requisitos: Rust 1.94+, Node 22.13+ y npm. En dos terminales desde la raíz:

```sh
cargo run --locked -p mostro-community-api
```

```sh
npm --prefix web ci
npm --prefix web run dev
```

Abrir `http://127.0.0.1:5173`. Los datos locales se guardan en `var/config/`, ignorado por Git. `.env.example` documenta las variables opcionales; no se carga automáticamente. No se necesitan nodos ni claves para editar el borrador.

## Compilar y verificar

```sh
./scripts/check.sh
docker build -f docker/Dockerfile.umbrel -t mostro-community:preview .
./scripts/container-smoke.sh mostro-community:preview
```

El script de contenedor utiliza datos temporales; comprueba UI, CSP, guardado y persistencia tras reinicio. El workflow [`publish.yml`](.github/workflows/publish.yml) compila y prueba imágenes nativas amd64 y arm64 al publicar un tag `v*`, después genera el manifiesto multi-arquitectura en GHCR y una release. La tienda debe fijar ese manifiesto por digest.

Las imágenes GHCR deben ser públicas para que Umbrel pueda descargarlas sin credenciales. La visibilidad del repositorio no convierte automáticamente sus paquetes en públicos.

[Arquitectura](docs/architecture.md) · [Validación](docs/validation.md) · [Blueprint original](docs/reference/blueprint-v4.md)

## Importar la identidad existente

Desde preview.5, puedes importar tu `nsec` por terminal con entrada oculta y comprobar que corresponda al `npub` esperado. Se almacena con permisos privados, sin sobrescribir otra identidad. No inicia Mostro. Ver [instrucciones y límites](docs/identity.md).

## LND de Umbrel

La integración de lectura utiliza `tls.cert` y `readonly.macaroon` existentes del LND de Umbrel. No copia ni publica sus valores. El panel muestra si la cadena y el grafo están sincronizados y, si LND lo informa, el saldo agregado de canales abiertos. Son indicadores de diagnóstico; no prueban que exista una ruta ni que Mostro pueda aceptar órdenes. Disponible desde preview.6. Ver [conexión y límites](docs/lnd.md).

## Preparación de Mostro (en desarrollo)

Una comprobación local de solo lectura revisa borrador, identidad y LND sin arrancar el daemon. La instalación inspeccionada tiene cero canales Lightning activos: aunque LND está conectado, todavía no hay capacidad para intercambios. La imagen oficial de Mostro se verifica por checksum y versión; el despliegue y las operaciones financieras siguen pendientes. Ver [preflight y requisitos](docs/mostro-preflight.md).
