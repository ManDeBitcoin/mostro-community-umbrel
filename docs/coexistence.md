# Convivencia con una instancia Mostro existente

## Qué instala esta release

- App ID: `mandebitcoin-mostro-manager`; nombres de contenedores distintos de Mostro.
- Puerto del panel: `5173` a través de `app_proxy`; sin publicación directa de API/RPC.
- Datos: solo el directorio propio `${APP_DATA_DIR}/data`.
- Servicios: `app_proxy`, inicialización de permisos de datos y Manager (UI + API).
- Red `manager_private` interna. `app_proxy` y un puente TCP de destino fijo conectan también a la red de Umbrel; la API del panel permanece en la red privada.

No incluye Mostro, Bitcoin, LND, Watchdog, relay ni Push. No monta socket Docker, configuración existente ni base de datos de Mostro. La API lee únicamente `tls.cert` y `readonly.macaroon` de LND; el puente de red no recibe credenciales. El `nsec` importado pertenece al almacenamiento del Manager y no se expone por HTTP. Instalar o desinstalar el Manager no debe reiniciar ni cambiar esos otros servicios.

La disponibilidad de `5173` se debe comprobar en cada servidor antes de instalar. Si hay un conflicto real, cambiar `port` en el manifest antes de instalar; los puertos internos 3001 de distintos contenedores no son por sí mismos un conflicto.

## Cómo conectar el Mostro actual en una etapa posterior

1. Identificar contenedor/servicio, versión exacta, red y rutas (sin publicar secretos).
2. Confirmar si hay trades, disputes, bonds o pagos pendientes mediante interfaces de lectura compatibles.
3. Verificar backup consistente y vinculación de identidad de Mostro con su LND.
4. Añadir primero observación de solo lectura por una ruta privada; comprobar compatibilidad del RPC y de las credenciales.
5. Diseñar y probar en regtest las mutaciones administrativas antes de habilitarlas en el panel.

No copiar SQLite/nsec a otro daemon y arrancarlo en paralelo. Cambiar identidad, usar otra base de datos con el mismo estado Lightning o mezclar credenciales puede dejar operaciones pendientes fuera del control de la instancia correcta. La migración es un proyecto aparte.

Una comprobación de archivos no prueba que un servicio esté vivo: para cerrar el inventario hace falta acceso de lectura a Docker/systemd o que el operador proporcione el nombre y la ruta de la instancia.

## Docker anidado en Dockge (Umbrel)

Una lista del Docker del host no incluye necesariamente los contenedores de Dockge. En la instalación inspeccionada, su compose configura el daemon con `--host unix:///data/docker.sock`. Consultar dentro del contenedor sin especificar esa ruta produce un error de conexión y no demuestra que esté vacío:

```sh
sudo docker exec dockge_docker_1 docker -H unix:///data/docker.sock ps -a --format={{.Names}}
```

Esta consulta muestra únicamente nombres; no muestra claves ni modifica contenedores. Si aparece un prompt `>` al pegar un comando con comillas, cancelar con Ctrl+C y pegar la línea completa anterior, que no necesita comillas.
