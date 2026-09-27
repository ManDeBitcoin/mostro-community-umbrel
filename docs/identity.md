# Preparar una identidad existente

La importación se incorpora en preview.5. No está incluida en la imagen preview.4. No inicia un daemon ni aplica el borrador al mercado.

Para una instancia nueva, comprobar primero que no queden pedidos, disputas, bonds o pagos pendientes de la instancia anterior. No borrar sus datos. Antes de arrancar, verificar también que ningún otro daemon utilice la misma identidad, incluyendo servicios systemd y Docker anidado.

## Importación local

La clave se introduce exclusivamente en una terminal local interactiva con entrada oculta; nunca como argumento, variable de entorno, mensaje de chat o campo del panel. Se requiere el formato Nostr `nsec1…` y el `npub1…` esperado. No se acepta una clave pública como privada ni un par que no coincida. La implementación utiliza [Rust Nostr](https://docs.rs/nostr/0.44.8/nostr/) para validar y derivar las claves.

Con Rust instalado, desde el repositorio:

```sh
cargo build --locked -p mostro-community-api
install -d -m 700 ./var/config
CONFIG_DIR=./var/config ./target/debug/mostro-community-api import-identity
```

Esto prepara una identidad **de desarrollo** en `var/config/identity/mostro.nsec`, no la identidad de la app instalada en Umbrel. No usar la clave real para pruebas de desarrollo.

Después de actualizar a preview.5, importar al almacenamiento persistente de Umbrel:

```sh
sudo docker exec -it --user 1000:1000 mandebitcoin-mostro-manager_web_1 mostro-community-api import-identity
```

Introducir primero el npub esperado y después la clave privada cuando aparezca el prompt oculto. El comando imprime solamente el npub verificado. No ejecutar este comando en preview.4.

## Almacenamiento y límites

- Directorio `CONFIG_DIR/identity` con permisos 0700; archivo `mostro.nsec` con permisos 0600, propiedad del usuario del proceso.
- Escritura atómica, sin sustituir identidades existentes; se rechazan directorios enlazados o con permisos públicos.
- La clave de trabajo se guarda en texto plano protegido por permisos del sistema, **no cifrada**. Se dispone de una exportación cifrada previa al mercado, pero la restauración automática y el backup de la futura base de datos Mostro siguen pendientes. Conservar la copia original privada.
- La API de configuración y sus backups de borrador no incluyen la identidad. Un backup completo del volumen sí contiene la clave y debe protegerse como tal.
- La importación no verifica el estado de LND, no recupera operaciones anteriores, no publica en relays y no arranca el mercado.

## Exportación cifrada previa al mercado

En la versión que incluya `export-backup`, este comando pedirá dos veces una frase de cifrado en la terminal y escribirá un archivo `age` en `/data/config/backups/`. Incluye la identidad y el borrador guardado; **no incluye** la futura base de datos de órdenes ni datos de LND. El archivo se descifra de inmediato con la misma frase y se comprueba el `npub` antes de guardarse. No se envía al navegador.

```sh
sudo docker exec -it --user 1000:1000 mandebitcoin-mostro-manager_web_1 mostro-community-api export-backup
```

El comando imprime la ruta exacta del archivo cifrado. Para verificarlo de nuevo dentro del contenedor, usa esa ruta como argumento de `verify-backup`, también con `sudo docker exec -it --user 1000:1000`. Copia luego el archivo `.age` fuera del servidor con `sudo docker cp` y guarda la frase por separado; una copia que permanece únicamente en el mismo disco no protege frente a su pérdida. La restauración automática aún no está implementada, por lo que no se debe considerar este archivo un respaldo completo de un mercado en operación.
