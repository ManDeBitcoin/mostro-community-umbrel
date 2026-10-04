# Archivos de Mostro fijados

Copias literales de [MostroP2P/mostro](https://github.com/MostroP2P/mostro). No se editan a mano: se sustituyen al fijar otra versión.

| Archivo | Origen upstream | Uso en el Manager | Licencia |
| --- | --- | --- | --- |
| `settings.v0.19.0.toml` | `settings.tpl.toml` en `v0.19.0` | Plantilla que el renderer compila dentro de la API | MIT |
| `admin.v0.19.0.proto` | `proto/admin.proto` en `v0.19.0` | Contrato gRPC que compila `api/build.rs` (solo `GetVersion`) | MIT |
| `settings.v0.19.2.toml` | `settings.tpl.toml` en `v0.19.2` | Referencia de la versión fijada; no se compila | GPL-3.0-or-later |
| `admin.v0.19.2.proto` | `proto/admin.proto` en `v0.19.2` | Referencia de la versión fijada; no se compila | GPL-3.0-or-later |
| `settings.v0.18.8.toml`, `admin.v0.18.8.proto` | `v0.18.8` | Histórico, sin uso | MIT |

## Por qué se compila la plantilla de v0.19.0 con el daemon v0.19.2

Mostro pasó de MIT a GPL-3.0-or-later en v0.19.2. Entre v0.19.0 y v0.19.2 la plantilla solo ganó un bloque comentado (`serbero_pubkey`) y el proto no cambió, así que la plantilla MIT produce exactamente el mismo `settings.toml`. La prueba `embedded_template_is_equivalent_to_the_pinned_upstream_release` en `api/tests/configuration.rs` compara ambas ya analizadas y falla si alguna vez difieren.

Cuando una versión futura cambie la plantilla de verdad habrá que decidir entre compilar la copia GPL, lo que condiciona la licencia de la API, o mantener una plantilla propia.

## El binario `mostrod`

La imagen Docker descarga el binario oficial sin modificar desde la release de GitHub y comprueba su SHA-256 (ver `config/versions.json` y `docker/Dockerfile.umbrel`). Desde v0.19.2 ese binario es GPL-3.0-or-later. La imagen incluye el texto de la licencia y este aviso en `/usr/share/licenses/mostrod/`. El código fuente correspondiente es el tag de la versión fijada:

<https://github.com/MostroP2P/mostro/tree/v0.19.2>

`LICENSE-MIT` conserva el aviso de copyright del código anterior al cambio de licencia. `LICENSE-GPL-3.0-or-later` es el archivo `LICENSE` de v0.19.2.
