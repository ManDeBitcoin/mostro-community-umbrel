# Validación de esta entrega

Comprobaciones ejecutadas el 2026-09-27:

- `cargo test --workspace --locked`: 8 tests pasan. Incluyen configuración inválida, campos desconocidos/secretos, unidades y escape TOML, persistencia y copia previa, archivo corrupto, CSRF, conflicto de revisiones y estados de infraestructura sin configurar.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: sin advertencias.
- `cargo fmt --all -- --check`: correcto.
- `npm --prefix web run build`: TypeScript y Vite compilan.
- `docker compose config --quiet`: composición de desarrollo válida.
- Chromium headless sobre Vite + API reales, con `CONFIG_DIR` aislado en `/tmp`: carga dashboard, crea comunidad EUR y método de pago, guarda y verifica 0.6% → 60 bps y 30% → 3000 bps, recarga, comprueba persistencia, indicador de cambios y cancelación del descarte, y verifica anchura móvil de 390px sin desbordamiento. Sin errores JavaScript.

El test de navegador detectó y permitió corregir una incompatibilidad de Origin/Host del proxy de Vite. Se conserva Host con `changeOrigin: false`; la API sigue rechazando orígenes ajenos. La captura `screenshots/dashboard.png` muestra el estado inicial sin servicios conectados.

Pendiente: instalación final desde la UI de Umbrel, llamadas a LND/Mostro reales, regtest de trades/bonds, Mostro App, backup/restauración o upgrades. Esas integraciones siguen pendientes; no se ha tocado ningún nodo existente.

## Publicación del paquete Umbrel

La primera compilación de `v0.1.0-preview.1` se detuvo porque la imagen oficial de Rust no incluye rustfmt. La corrección instala explícitamente rustfmt y Clippy antes de ejecutar los checks. La publicación ahora exige verificar anónimamente el manifiesto multi-arquitectura, los manifiestos amd64/arm64, las configuraciones y el acceso HEAD a todas las capas. Una imagen privada o inexistente impide anunciar la release.

### Resultado de publicación — 0.1.0-preview.4

- [Workflow completo aprobado](https://github.com/ManDeBitcoin/mostro-community-umbrel/actions/runs/36302699252): builds nativas Linux amd64 y arm64, ocho tests Rust por arquitectura, formato, Clippy, build web y smoke test de contenedor.
- El smoke test verifica archivos estáticos, CSP, guardado por mismo origen, estado aislado y persistencia tras reiniciar Docker. Incluye inicialización del directorio raíz de datos y consulta del nuevo puerto temporal tras el reinicio.
- Chromium sobre la distribución estática real: guardado/recarga, fees, catálogo, cambios sin guardar y vista móvil sin errores.
- Verificación anónima repetida desde el servidor: HTTP HEAD/GET del índice, ambos manifiestos, configs y todas las capas. No requiere credenciales GHCR.
- Digest multi-arquitectura: `sha256:bbf12029ceb7f3e6f41ab26a676d1579609dd98176d1db99526b834aaf176a20`. Ambos servicios del paquete utilizan ese mismo digest.

## Conexión de lectura LND — preview.6

- Pruebas Rust: 16 pasan (siete unitarias, cuatro de configuración y cinco HTTP). Incluyen validación de URL TLS, preservación de satoshis como cadenas, ausencia de datos ficticios y transmisión bidireccional del puente TCP.
- Prueba HTTPS sintética: nueve escenarios, incluidos certificado no confiable, nombre TLS incorrecto, macaroon en cabecera, error de permiso, redirección, respuesta excesiva, saldo no disponible y resolución privada del puente.
- Compilación web y Clippy: correctos.
- Comprobación contra el LND real del operador: `online`, mainnet, cadena y grafo sincronizados y saldo de canales disponible. Se consultó con el macaroon readonly y TLS; no se mostraron ni guardaron credenciales o saldos en el registro de prueba.
- Puente TCP conectado al LND real desde un puerto local de prueba: mismo resultado `online`. El proceso de prueba se detuvo tras la comprobación.
- El workflow de publicación ejecuta la prueba HTTPS sintética dentro de cada imagen nativa, además del smoke test de persistencia y la verificación de descarga anónima.

## Preflight Mostro — preview.7

- 18 pruebas Rust pasan. El preflight lee el borrador y deriva únicamente el npub de la identidad importada; la prueba confirma que nunca incluye el nsec en la respuesta. No cambia datos.
- Clippy, formato Rust y compilación web: correctos.
- El binario oficial Mostro v0.18.8 para x86_64 coincidió con el SHA-256 fijado (`9fa0516a79270dec2dbe074f14cf988c0311a9d56c80f0a00a98e8d579b3cf53`) y respondió `mostro p2p 0.18.8` al ejecutar `--version` con `TERM=xterm`.
- Preflight local de la instalación real: borrador válido en revisión 4, identidad pública coincidente con el npub que proporcionó el operador, LND mainnet sincronizado y **cero canales activos**. El comando no imprimió secretos ni montó credenciales financieras.
- El workflow de publicación verifica el binario upstream en cada arquitectura. No ejecuta Mostro conectado a LND ni realiza pagos.

## Candidato TOML sin secretos — desarrollo posterior a preview.7

- El renderer fija `nsec_privkey` a una cadena vacía, deja RPC deshabilitado y no agrega un token RPC. Solo acepta un origen LND HTTPS sin credenciales y rutas absolutas para certificado y macaroon.
- Las pruebas comprueban el escape de texto, los porcentajes y que sobrevivan los límites upstream `allow_node_change=false`, `escrow_deadline_margin_blocks=24` y transporte `nip44`.
- `./scripts/check.sh` pasó: 18 pruebas Rust, Clippy sin advertencias, formato, build web y validación de Compose. La consulta al LND real y el arranque de Mostro quedan fuera de esta prueba.

## Lanzador privado de la imagen opcional — desarrollo posterior a preview.7

- `scripts/mostro-entrypoint-smoke.sh` pasa con un binario sintético: acepta identidad privada y settings presentes; rechaza permisos amplios, enlaces simbólicos, settings ausentes y el secreto pasado en el entorno de Docker.
- La CI ahora compila la imagen final de Mostro, comprueba `--version` y exige que rechace un arranque sin archivos. La imagen no se publica ni se incorpora a la aplicación Umbrel. La construcción Docker local no se pudo ejecutar desde este entorno sin la contraseña de `sudo`; la prueba de imagen real se comprobará en CI cuando se publique un tag.
- `scripts/verify-mostro-image.sh` permite al operador ejecutar esa misma prueba con `sudo` en el host. Se comprobó su sintaxis, el smoke del lanzador y el flujo del script con un Docker simulado; la construcción real queda pendiente de la ejecución con Docker privilegiado.

El operador ejecutó el script con `sudo` y obtuvo: `Verificación aprobada: imagen oficial v0.18.8 y arranque protegido.` La imagen de prueba se eliminó al finalizar; no se arrancó un servicio Mostro.

## Backup cifrado previo al mercado — desarrollo posterior a preview.7

- La API local puede exportar la identidad y el borrador en un archivo `age` con frase interactiva y permisos privados, y verifica el descifrado antes de publicar el archivo. `verify-backup` valida versión, `npub` derivado del `nsec` y configuración sin restaurar archivos.
- La prueba usa una identidad sintética, comprueba el viaje cifrado y descifrado, permisos de archivo/directorio y rechazo de una frase incorrecta. El mercado y LND no intervienen. La restauración de la configuración y el respaldo de la futura base de datos siguen pendientes.

## Publicación de preview.8

- [GitHub Actions aprobó](https://github.com/ManDeBitcoin/mostro-community-umbrel/actions/runs/36331949528) las imágenes nativas amd64 y arm64, las pruebas Rust, smoke de persistencia, conexión LND sintética y arranque protegido de la imagen opcional de Mostro.
- El manifiesto multi-arquitectura de Manager tiene digest `sha256:09834e540a209147e23040acdcbf1752f74b690cbce7420e004095813bab6aca`; la CI verificó acceso anónimo a los manifiestos y capas antes de crear la release.

## Restauración aislada — desarrollo posterior a preview.8

- La prueba con identidad sintética exporta el backup, lo restaura en un directorio nuevo, comprueba `npub`, revisión original y permisos 0700, y confirma que un destino existente permanece intacto.
- `./scripts/check.sh` pasa con 19 pruebas Rust, Clippy, build web, validación Compose y smoke del lanzador. No se restauró el backup real ni se cambió la instalación Umbrel.
