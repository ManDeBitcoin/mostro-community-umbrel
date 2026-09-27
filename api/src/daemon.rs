//! Daemon orchestration, runtime validation and safe activation.
//! Ensures Mostro daemon only starts when all cryptographic and network prerequisites are satisfied.
use crate::{adapters::Integrations, config::render_settings, identity, store::Document};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
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

fn write_private(path: &Path, contents: &[u8]) -> Result<(), &'static str> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "No se pudo crear el archivo de configuración activa")?;
    file.write_all(contents)
        .and_then(|()| file.sync_all())
        .map_err(|_| "No se pudo escribir el archivo de configuración activa")
}

pub async fn report(root: &Path, integrations: &Integrations) -> DaemonReport {
    let npub = identity::inspect(root).unwrap_or(None);
    let identity_present = npub.is_some();

    let document_path = root.join("community.json");
    let draft_doc: Option<Document> = fs::read(&document_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let draft_revision = draft_doc.as_ref().map(|d| d.revision);

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

    let can_activate = identity_present && draft_revision.is_some();
    let state = if active_settings_path.is_some() {
        DaemonState::ActiveReady
    } else if can_activate {
        DaemonState::ConfiguredStandby
    } else {
        DaemonState::Unconfigured
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
    }
}

pub fn activate(root: &Path, lnd_grpc_origin: &str) -> Result<ActivationResult, &'static str> {
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

    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let status = ActiveStatus {
        revision: document.revision,
        settings_sha256: settings_sha256.clone(),
        lnd_grpc_origin: lnd_grpc_origin.to_string(),
        activated_at_unix: now_unix,
    };

    write_private(&settings_file, settings.as_bytes())?;
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
    Ok(())
}
