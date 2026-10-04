# Preparación de Mostro sin arrancar el mercado

El comando `mostro-community-api check-mostro` consulta solamente el borrador guardado, la identidad importada y el LND de lectura. Devuelve el `npub`, estados y número de canales activos; no devuelve el `nsec`, los macaroons ni los saldos. La respuesta `can_start_market: false` es intencional mientras no se haya integrado y probado el daemon financiero.

Una conexión LND `online` significa que respondió por HTTPS y está sincronizado. No garantiza capacidad de pago o recepción. El preflight separa `capacity: no_active_channels`, `no_local_liquidity`, `no_remote_liquidity`, `balances_observed` y `unknown`. Incluso `balances_observed` no prueba que exista una ruta usable.

La instalación inspeccionada informó **cero canales activos** el 2026-09-27. Antes de operaciones reales se necesitará capacidad Lightning local y remota, además de pruebas de ruta, del nodo y del flujo completo de Mostro. Abrir o financiar canales modifica el nodo y requiere una decisión operativa separada del desarrollo de esta app.

La [documentación upstream de Mostro v0.19.2](https://github.com/MostroP2P/mostro/blob/v0.19.2/docs/LIGHTNING_OPS.md) describe sus facturas retenidas y pagos salientes. El daemon necesita credenciales con permisos financieros, que **no** se montan en el Manager. La imagen oficial de Mostro se comprueba por SHA-256 y con `--version` en CI, pero todavía no se instala ni ejecuta en Umbrel. El binario llama a `clearscreen` incluso antes de procesar `--help`; su imagen necesita `TERM=xterm` y `ncurses-base` para arrancar sin TTY. También requiere un `settings.toml` válido antes de iniciar en modo no interactivo. La configuración aplicada, la restauración, la conexión de LND con permisos mínimos y las pruebas regtest siguen pendientes.

El renderer interno ya puede formar un candidato `settings.toml` desde la plantilla fijada (ver `config/upstream/README.md`). Es deliberadamente inerte: deja `nsec_privkey` vacío, RPC deshabilitado y no se escribe en el volumen del daemon. [Mostro admite `MOSTRO_NSEC_PRIVKEY`](https://github.com/MostroP2P/mostro/tree/v0.19.2#providing-the-nsec-via-environment-variable) para suministrar la identidad en el arranque sin duplicarla en el TOML. La imagen opcional incluye un lanzador que exige un archivo de identidad privado, del mismo usuario y sin enlace simbólico, además de `settings.toml`, antes de iniciar Mostro; no incorpora el secreto en la imagen ni en Compose. El lanzador se prueba con un binario sintético y la CI comprueba que la imagen real rehúsa arrancar sin archivos. Faltan el montaje y permisos mínimos de LND para pagos, backup y una prueba de ciclo completo en regtest antes de incorporar el daemon al paquete Umbrel.

En desarrollo, `mostro-community-api stage-mostro-settings https://HOST:10009` genera una copia privada en `CONFIG_DIR/staging/revision-N/`. El origen gRPC debe usar HTTPS y puerto explícito; el certificado y el futuro macaroon financiero se referencian como `/lnd/tls.cert` y `/lnd/mostro.macaroon` dentro del futuro contenedor. El comando no monta ese macaroon, no lee la identidad y rechaza preparar dos veces la misma revisión. El resultado es solo para revisión: el Compose de Umbrel no monta esta carpeta en Mostro ni arranca el daemon. La ruta definitiva de datos y credenciales se fijará tras las pruebas regtest.

Para comprobar la imagen desde el host Umbrel cuando Docker requiere `sudo`:

```sh
sudo bash /home/umbrel/work/mostro-community-umbrel/scripts/verify-mostro-image.sh
```

El script construye la imagen opcional y ejecuta dos contenedores efímeros sin red, puertos, montajes ni credenciales: uno consulta la versión y otro comprueba que el arranque sin identidad sea rechazado por la razón esperada. Borra la etiqueta de imagen usada al finalizar. No instala ni arranca Mostro como servicio y no consulta LND.
