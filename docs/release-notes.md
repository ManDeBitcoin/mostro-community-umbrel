Preview.10 implementa el Módulo 1 de orquestación y ciclo de vida del demonio Mostro (v0.18.8):
- Módulo `daemon.rs` con máquina de estados (`unconfigured`, `configured_standby`, `active_ready`, `active_running`).
- Endpoints `GET /api/daemon/status`, `PUT /api/daemon/activate`, `PUT /api/daemon/deactivate` y comandos CLI correspondientes (`daemon-status`, `activate-daemon`, `deactivate-daemon`).
- Generación segura y activación atómica de `active/settings.toml` (modo 0600) con digest criptográfico SHA-256 sin filtrar claves privadas ni macaroons.
- Incorporación del binario oficial upstream verificado de Mostro v0.18.8 (SHA-256 verificado en amd64 y arm64) y lanzador protegido en la imagen unificada.
- Modo de espera protegida (`STANDBY_IF_UNCONFIGURED=true`) para el demonio en Compose sin causar bucles de reinicio antes de la activación.
- Tarjeta de control de orquestación en el Panel Web con indicadores en vivo, advertencias de canales LND y botones de activación.
- Suite de pruebas ampliada a 27 tests automatizados con 0 advertencias de Clippy.
