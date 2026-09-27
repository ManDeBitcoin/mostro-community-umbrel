# Consulta de LND en Umbrel

La app declara dependencia de `lightning` y toma las rutas exportadas por Umbrel. Monta solo `tls.cert` y el archivo `readonly.macaroon` de la red Bitcoin configurada, ambos en modo lectura dentro de la API. Nunca monta `admin.macaroon`, `tls.key`, el directorio completo de LND ni su base de datos.

La API sigue en `manager_private`; un contenedor puente pertenece también a la red Umbrel y transmite TCP únicamente al IP:puerto REST de LND exportado por Umbrel. No contiene claves ni descifra TLS. La API se conecta al puente y verifica el certificado contra `localhost`, uno de los nombres presentes en el certificado del LND inspeccionado. El cliente no acepta certificados inválidos, desactiva proxies y redirecciones, y solo llama `GET /v1/getinfo` y `GET /v1/balance/channels`.

El panel recibe una selección de campos: sincronización de cadena y grafo, red, altura, número de canales y saldo agregado local/remoto. Los valores de satoshis son cadenas para conservar su precisión. Una respuesta incompleta o un error en saldo no se transforma en cero. Un nodo que responde no se presenta como listo para transacciones financieras. El Manager no arranca Mostro ni crea pagos.

Para verificar sin mostrar el macaroon:

```sh
sudo docker exec mandebitcoin-mostro-manager_web_1 mostro-community-api check-lnd
```

El resultado muestra solo los campos seleccionados. Evita compartir el alias o los saldos si deseas mantenerlos privados. Si LND renueva `tls.cert` o `readonly.macaroon` mediante sustitución atómica del archivo, reinicia únicamente el Manager para renovar sus montajes de archivo; no hay que reiniciar LND.

Esta integración se verificó con el LND real del operador por HTTPS y macaroon readonly: respondió mainnet, `synced_to_chain=true`, `synced_to_graph=true` y saldo de canales disponible. Las pruebas sintéticas también comprueban TLS, nombre de host, macaroon, redirecciones, límites de respuesta, estado parcial y error de permiso.
