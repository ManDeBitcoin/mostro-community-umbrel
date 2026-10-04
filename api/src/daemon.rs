//! Daemon orchestration, runtime validation and safe activation.
//! Ensures Mostro daemon only starts when all cryptographic and network prerequisites are satisfied.
use crate::{
    adapters::Integrations,
    config::render_settings,
    identity,
    orders::{NODE_INFO_FRESH_SECS, NodeInfo},
    store::Document,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;

const CERT_PATH: &str = "/lnd/tls.cert";
const MACAROON_PATH: &str = "/lnd/mostro.macaroon";
const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DaemonState {
    Unconfigured,
    ConfiguredStandby,
    ActiveReady,
    ActiveRunning,
}

/// mostrod release this package pins and ships (see `config/versions.json`).
pub const MOSTRO_VERSION: &str = "0.19.2";
pub const PROTOCOL_VERSION: u32 = 2;

/// Where a reported daemon version comes from, most trustworthy first.
pub const VERSION_SOURCE_ANNOUNCED: &str = "announced";
pub const VERSION_SOURCE_BINARY: &str = "binary";
pub const VERSION_SOURCE_PINNED: &str = "pinned";

fn version_from_output(stdout: &[u8]) -> Option<String> {
    // `mostrod --version` prints "mostro p2p <version>" after terminal control codes.
    String::from_utf8_lossy(stdout)
        .split_whitespace()
        .last()
        .filter(|v| v.len() <= 32 && v.bytes().next().is_some_and(|b| b.is_ascii_digit()))
        .map(str::to_string)
}

/// Version of the mostrod binary shipped next to this API, and how it was
/// obtained. This describes the package, not the process that is running:
/// in Umbrel the daemon lives in another container of the same image.
pub fn packaged_mostrod_version() -> (String, &'static str) {
    for bin_path in ["/usr/local/bin/mostrod", "mostrod"] {
        if let Ok(output) = std::process::Command::new(bin_path)
            .env("TERM", "xterm")
            .arg("--version")
            .output()
            && output.status.success()
            && let Some(version) = version_from_output(&output.stdout)
        {
            return (version, VERSION_SOURCE_BINARY);
        }
    }
    (MOSTRO_VERSION.to_string(), VERSION_SOURCE_PINNED)
}

pub fn detect_mostrod_version() -> String {
    packaged_mostrod_version().0
}

/// Last unexpected exit of mostrod, recorded by the container entrypoint.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LastExit {
    pub at_unix: u64,
    pub code: i32,
    pub uptime_secs: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DaemonReport {
    pub state: DaemonState,
    pub identity_present: bool,
    pub npub: Option<String>,
    pub draft_revision: Option<u64>,
    pub active_revision: Option<u64>,
    pub active_settings_hash: Option<String>,
    pub active_settings_path: Option<String>,
    pub lnd_channel_count: u64,
    pub lnd_synced: bool,
    pub can_activate: bool,
    pub warnings: Vec<String>,
    /// Best known daemon version: the one the daemon announces on the relays
    /// when that announcement is recent, otherwise the packaged binary's.
    pub mostro_version: String,
    /// `announced`, `binary` or `pinned`: what `mostro_version` is based on.
    #[serde(default)]
    pub version_source: String,
    /// Version of the mostrod binary shipped in this package.
    #[serde(default)]
    pub packaged_version: String,
    pub protocol_version: u32,
    /// The daemon's own kind 38385 event, as last seen on the relays.
    #[serde(default)]
    pub announced: Option<NodeInfo>,
    #[serde(default)]
    pub announced_age_secs: Option<u64>,
    /// True while the announcement is recent enough to prove a live daemon.
    #[serde(default)]
    pub announced_fresh: bool,
    #[serde(default)]
    pub last_exit: Option<LastExit>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActiveStatus {
    pub revision: u64,
    pub settings_sha256: String,
    pub lnd_grpc_origin: String,
    pub activated_at_unix: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActivationResult {
    pub revision: u64,
    pub settings_path: PathBuf,
    pub settings_sha256: String,
    pub activated_at_unix: u64,
    /// False when the rendered settings were already active and the file
    /// was left untouched.
    #[serde(default)]
    pub settings_changed: bool,
}

fn ensure_private_dir(path: &Path) -> Result<(), &'static str> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("No se pudo crear el directorio de activación"),
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "Directorio no disponible")?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("El directorio debe ser privado (0700) y no un enlace");
    }
    Ok(())
}

/// Replaces `path` atomically: the daemon never reads a half-written file.
fn write_private(path: &Path, contents: &[u8]) -> Result<(), &'static str> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Ruta de configuración activa inválida")?;
    let temp = path.with_file_name(format!(".{file_name}.tmp"));
    let _ = fs::remove_file(&temp);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| "No se pudo crear el archivo de configuración activa")?;
    let written = file
        .write_all(contents)
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temp, path));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
        return Err("No se pudo escribir el archivo de configuración activa");
    }
    Ok(())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn read_last_exit(active_dir: &Path) -> Option<LastExit> {
    let text = fs::read_to_string(active_dir.join("mostro.last_exit")).ok()?;
    let mut fields = text.split_whitespace();
    Some(LastExit {
        at_unix: fields.next()?.parse().ok()?,
        code: fields.next()?.parse().ok()?,
        uptime_secs: fields.next()?.parse().ok()?,
    })
}

/// Seconds since the entrypoint started the current mostrod process.
fn current_run_secs(active_dir: &Path) -> Option<u64> {
    fs::metadata(active_dir.join("mostro.pid"))
        .ok()?
        .modified()
        .ok()?
        .elapsed()
        .ok()
        .map(|elapsed| elapsed.as_secs())
}

pub async fn report(root: &Path, integrations: &Integrations) -> DaemonReport {
    report_with_node_info(root, integrations, None).await
}

/// `node_info` is the daemon's own kind 38385 event from the relay monitor.
/// It is the only evidence that a daemon with this identity is really alive.
pub async fn report_with_node_info(
    root: &Path,
    integrations: &Integrations,
    node_info: Option<NodeInfo>,
) -> DaemonReport {
    let npub = identity::inspect(root).unwrap_or(None);
    let identity_present = npub.is_some();

    let document_path = root.join("community.json");
    let draft_doc: Option<Document> = fs::read(&document_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let draft_revision = draft_doc.as_ref().map(|d| d.revision);
    let max_routing_fee_bps = draft_doc
        .as_ref()
        .and_then(|d| d.config.as_ref())
        .map(|c| c.market.max_routing_fee_bps);
    let first_contact_pow_above_base = draft_doc
        .as_ref()
        .and_then(|d| d.config.as_ref())
        .is_some_and(|c| c.safety.pow_first_contact > c.safety.pow);

    let active_dir = root.join("active");
    let settings_file = active_dir.join("settings.toml");
    let status_file = active_dir.join("status.json");

    let (active_revision, active_settings_hash, active_settings_path) = if settings_file.is_file() {
        let status: Option<ActiveStatus> = fs::read(&status_file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        let hash = fs::read(&settings_file).ok().map(|bytes| {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            format!("{:x}", hasher.finalize())
        });
        (
            status.map(|s| s.revision),
            hash,
            Some(settings_file.display().to_string()),
        )
    } else {
        (None, None, None)
    };

    let lnd_probe = integrations.lightning().await;
    let lnd_channel_count = lnd_probe
        .get("num_active_channels")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let lnd_synced = lnd_probe
        .get("synced_to_chain")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut warnings = Vec::new();
    if !identity_present {
        warnings.push("Falta importar la clave privada Nostr (nsec) del bot.".into());
    }
    if draft_revision.is_none() {
        warnings.push("Falta configurar el borrador de reglas de la comunidad.".into());
    }
    if lnd_channel_count == 0 {
        warnings.push("LND reporta 0 canales activos. Mostro requiere canales Lightning abiertos para crear y liquidar hold invoices.".into());
    }
    if !lnd_synced {
        warnings.push("LND no está sincronizado con la cadena de bloques.".into());
    }

    let now = unix_now();
    let last_exit = read_last_exit(&active_dir);
    let run_secs = current_run_secs(&active_dir);
    // A daemon that keeps dying right after it starts is not running, even
    // though the entrypoint has just respawned it.
    let crash_looping = last_exit.as_ref().is_some_and(|exit| {
        now.saturating_sub(exit.at_unix) < 120
            && exit.uptime_secs < 60
            && run_secs.is_none_or(|secs| secs < 30)
    });

    let can_activate = identity_present && draft_revision.is_some();
    let state = if active_settings_path.is_some() {
        if is_mostrod_running(&active_dir) && !crash_looping {
            DaemonState::ActiveRunning
        } else {
            DaemonState::ActiveReady
        }
    } else if can_activate {
        DaemonState::ConfiguredStandby
    } else {
        DaemonState::Unconfigured
    };

    let announced_age_secs = node_info
        .as_ref()
        .map(|info| now.saturating_sub(info.created_at));
    let announced_fresh = announced_age_secs.is_some_and(|age| age <= NODE_INFO_FRESH_SECS);
    let announced_version = node_info
        .as_ref()
        .filter(|_| announced_fresh)
        .and_then(|info| info.mostro_version.clone());
    let (packaged_version, packaged_source) = packaged_mostrod_version();

    if crash_looping && let Some(exit) = &last_exit {
        warnings.push(format!(
            "El daemon terminó con código {} a los {} s de arrancar y se está reiniciando. Revisa los registros del contenedor mostro (LND, relays o configuración).",
            exit.code, exit.uptime_secs
        ));
    }
    if state == DaemonState::ActiveReady && !crash_looping {
        warnings.push("Configuración guardada, pero ejecución del daemon sin verificar. En Umbrel el daemon está en otro contenedor; guardar settings.toml no confirma su arranque ni la versión que reciben los clientes.".into());
    }
    if state == DaemonState::ActiveRunning
        && !announced_fresh
        && run_secs.is_some_and(|secs| secs > NODE_INFO_FRESH_SECS)
    {
        warnings.push("El daemon figura en ejecución, pero su evento de información (kind 38385) no aparece actualizado en los relays configurados. Los clientes no pueden confirmar que el nodo está activo: revisa los relays y los registros.".into());
    }
    if state != DaemonState::ActiveRunning
        && announced_fresh
        && let Some(age) = announced_age_secs
    {
        warnings.push(format!(
            "El nodo anunció su información en los relays hace {age} s, pero este panel no ve el daemon en ejecución. Es normal durante unos minutos después de detenerlo. Si el anuncio se sigue renovando, otra instancia de Mostro usa esta misma clave: no actives una segunda."
        ));
    }
    if let Some(announced) = &announced_version
        && state == DaemonState::ActiveRunning
        && *announced != packaged_version
    {
        warnings.push(format!(
            "El daemon anuncia la versión {announced} y este paquete incluye la {packaged_version}. Reinicia la aplicación para aplicar la actualización o comprueba que no responda otra instancia."
        ));
    }
    if active_revision.is_some() && active_revision != draft_revision {
        warnings.push("Hay cambios en el borrador que no están en la configuración activa.".into());
    }
    if max_routing_fee_bps == Some(0) {
        warnings.push("La comisión máxima de enrutamiento es 0: Mostro solo podrá pagar a los compradores por rutas sin comisión y los pagos pueden quedar reintentándose. El valor por defecto de Mostro es 0,2 %.".into());
    }
    if first_contact_pow_above_base {
        warnings.push("La prueba de trabajo de la primera conversación es mayor que la general: el daemon descarta sin respuesta las órdenes, tomas y valoraciones de las apps que no la calculan. Comprueba que tus clientes leen pow_first_contact antes de activarla.".into());
    }

    let (mostro_version, version_source) = match announced_version {
        Some(version) => (version, VERSION_SOURCE_ANNOUNCED),
        None => (packaged_version.clone(), packaged_source),
    };

    DaemonReport {
        state,
        identity_present,
        npub,
        draft_revision,
        active_revision,
        active_settings_hash,
        active_settings_path,
        lnd_channel_count,
        lnd_synced,
        can_activate,
        warnings,
        mostro_version,
        version_source: version_source.to_string(),
        packaged_version,
        protocol_version: PROTOCOL_VERSION,
        announced: node_info,
        announced_age_secs,
        announced_fresh,
        last_exit,
    }
}

/// Explicit activation requested by the operator: writes the settings and
/// (re)starts the daemon even when the settings did not change.
pub fn activate(root: &Path, lnd_grpc_origin: &str) -> Result<ActivationResult, &'static str> {
    apply_settings(root, lnd_grpc_origin, true)
}

/// Brings the active settings in line with the saved draft. The daemon is
/// restarted only when the rendered `settings.toml` actually changes.
pub fn sync_active_settings(
    root: &Path,
    lnd_grpc_origin: &str,
) -> Result<ActivationResult, &'static str> {
    apply_settings(root, lnd_grpc_origin, false)
}

fn apply_settings(
    root: &Path,
    lnd_grpc_origin: &str,
    restart_when_unchanged: bool,
) -> Result<ActivationResult, &'static str> {
    let origin = Url::parse(lnd_grpc_origin).map_err(|_| "Origen LND inválido")?;
    if origin.port().is_none() {
        return Err("El origen LND gRPC debe incluir un puerto explícito");
    }
    let root_metadata = fs::symlink_metadata(root).map_err(|_| "CONFIG_DIR no disponible")?;
    if !root_metadata.is_dir() || root_metadata.permissions().mode() & 0o077 != 0 {
        return Err("CONFIG_DIR debe ser un directorio privado (0700)");
    }
    if identity::read_private(root)?.is_none() {
        return Err("No se puede activar el demonio sin una identidad privada importada");
    }
    let document_path = root.join("community.json");
    let metadata = fs::symlink_metadata(&document_path).map_err(|_| "Falta el borrador")?;
    if !metadata.is_file() || metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("Borrador inválido o demasiado grande");
    }
    let document: Document = serde_json::from_slice(
        &fs::read(document_path).map_err(|_| "No se pudo leer el borrador")?,
    )
    .map_err(|_| "Borrador inválido")?;
    let config = document.config.as_ref().ok_or("Borrador vacío")?;

    let settings = render_settings(config, lnd_grpc_origin, CERT_PATH, MACAROON_PATH)
        .map_err(|_| "No se pudo generar settings.toml")?;

    let active_dir = root.join("active");
    ensure_private_dir(&active_dir)?;

    let mut hasher = Sha256::new();
    hasher.update(settings.as_bytes());
    let settings_sha256 = format!("{:x}", hasher.finalize());

    let settings_file = active_dir.join("settings.toml");
    let status_file = active_dir.join("status.json");
    let now_unix = unix_now();

    // A draft that renders the same settings (a payment label, the contact
    // link) must not restart a daemon that may have trades in flight.
    let settings_changed = fs::read(&settings_file)
        .map(|current| current != settings.as_bytes())
        .unwrap_or(true);

    let status = ActiveStatus {
        revision: document.revision,
        settings_sha256: settings_sha256.clone(),
        lnd_grpc_origin: lnd_grpc_origin.to_string(),
        activated_at_unix: now_unix,
    };

    if settings_changed {
        write_private(&settings_file, settings.as_bytes())?;
    }
    // Ask for the restart as soon as the new settings are on disk. If a later
    // step failed first, the daemon would keep running the old settings while
    // the next save found the file already up to date and never restarted it.
    //
    // The daemon publishes its own kind 0, 10002 and 38385 events when it
    // starts. The panel never signs protocol events with the node key: an
    // info event from here would advertise a node whether or not mostrod came up.
    if settings_changed || restart_when_unchanged {
        notify_standby(root);
    }

    let status_bytes = serde_json::to_vec_pretty(&status)
        .map_err(|_| "No se pudo serializar el estado de activación")?;
    write_private(&status_file, &status_bytes)?;

    File::open(&active_dir)
        .and_then(|file| file.sync_all())
        .map_err(|_| "No se pudo sincronizar el directorio activo")?;

    Ok(ActivationResult {
        revision: document.revision,
        settings_path: settings_file,
        settings_sha256,
        activated_at_unix: now_unix,
        settings_changed,
    })
}

pub fn deactivate(root: &Path) -> Result<(), &'static str> {
    let active_dir = root.join("active");
    let settings_file = active_dir.join("settings.toml");
    let status_file = active_dir.join("status.json");

    if settings_file.exists() {
        fs::remove_file(&settings_file).map_err(|_| "No se pudo eliminar settings.toml activo")?;
    }
    if status_file.exists() {
        fs::remove_file(&status_file).map_err(|_| "No se pudo eliminar status.json activo")?;
    }
    let _ = fs::remove_file(root.join(".standby_wake"));
    let _ = fs::remove_file(active_dir.join(".standby_wake"));
    let _ = fs::remove_file(active_dir.join("mostro.pid"));
    let _ = fs::remove_file(active_dir.join("mostro.heartbeat"));
    let _ = fs::remove_file(active_dir.join("mostro.last_exit"));

    notify_standby(root);

    for pid in mostrod_pids(&active_dir) {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    Ok(())
}

/// Asks the supervisor in the daemon container to (re)start mostrod. The
/// request is a file inside CONFIG_DIR and nowhere else: in Umbrel that is the
/// volume both containers share, and a test or a CLI run with another
/// CONFIG_DIR can never reach a production daemon.
fn notify_standby(root: &Path) {
    let _ = File::create(root.join(".standby_wake"));
    let _ = File::create(root.join("active").join(".standby_wake"));
}

fn uses_settings_directory(cmdline: &[u8], settings_dir: &Path) -> bool {
    let args: Vec<&[u8]> = cmdline.split(|byte| *byte == 0).collect();
    args.windows(2)
        .any(|pair| pair[0] == b"-d" && pair[1] == settings_dir.as_os_str().as_bytes())
}

/// The daemon is visible in this container, or the entrypoint that supervises
/// it in the daemon container touched its heartbeat within the last 30 s. A
/// pid file alone proves nothing: it survives a hard kill.
fn is_mostrod_running(settings_dir: &Path) -> bool {
    if !mostrod_pids(settings_dir).is_empty() {
        return true;
    }
    fs::metadata(settings_dir.join("mostro.heartbeat"))
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|elapsed| elapsed.as_secs() < 30)
}

fn mostrod_pids(settings_dir: &Path) -> Vec<u32> {
    let mut pids = Vec::new();
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            if let Ok(file_name) = entry.file_name().into_string()
                && file_name.chars().all(|c| c.is_ascii_digit())
            {
                let comm_path = entry.path().join("comm");
                if let Ok(comm) = fs::read_to_string(&comm_path)
                    && comm.trim() == "mostrod"
                    && fs::read(entry.path().join("cmdline"))
                        .is_ok_and(|args| uses_settings_directory(&args, settings_dir))
                    && let Ok(pid) = file_name.parse::<u32>()
                    && pid > 1
                {
                    pids.push(pid);
                }
            }
        }
    }
    pids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_detection_requires_this_instances_settings_directory() {
        let dir = Path::new("/data/config/active");
        assert!(uses_settings_directory(
            b"/usr/local/bin/mostrod\0-d\0/data/config/active\0",
            dir
        ));
        for cmdline in [
            b"mostrod\0-d\0/another/instance\0".as_slice(),
            b"mostrod\0-d\0/data/config/active-old\0",
            b"mostrod\0",
            b"mostrod\0-d\0",
            b"",
        ] {
            assert!(!uses_settings_directory(cmdline, dir));
        }
    }
}
