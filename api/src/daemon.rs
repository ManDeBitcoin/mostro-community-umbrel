//! Daemon orchestration, runtime validation and safe activation.
//! Ensures Mostro daemon only starts when all cryptographic and network prerequisites are satisfied.
use crate::{
    adapters::Integrations,
    config::{BondApply, Configuration, render_settings},
    identity,
    store::Document,
};
use futures_util::{SinkExt, StreamExt};
use nostr::{EventBuilder, Kind, Tag, event::tag::TagKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::protocol::Message;
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
        if is_mostrod_running(&active_dir) {
            DaemonState::ActiveRunning
        } else {
            DaemonState::ActiveReady
        }
    } else if can_activate {
        DaemonState::ConfiguredStandby
    } else {
        DaemonState::Unconfigured
    };

    if state == DaemonState::ActiveReady {
        warnings.push("Configuración guardada, pero ejecución del daemon sin verificar. En Umbrel el daemon está en otro contenedor; guardar settings.toml no confirma su arranque ni la versión que recibe Mostrix.".into());
    }
    if active_revision.is_some() && active_revision != draft_revision {
        warnings.push("Hay cambios en el borrador que no están en la configuración activa.".into());
    }

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

    notify_standby(root);

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(broadcast_instance_info(root.to_path_buf(), config.clone()));
    }

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
    let _ = fs::remove_file(root.join(".standby_wake"));
    let _ = fs::remove_file(active_dir.join(".standby_wake"));
    let _ = fs::remove_file(Path::new("/data/.standby_wake"));
    let _ = fs::remove_file(Path::new("/data/config/.standby_wake"));
    let _ = fs::remove_file(Path::new("/data/config/active/.standby_wake"));
    let _ = fs::remove_file(active_dir.join("mostro.pid"));
    let _ = fs::remove_file(active_dir.join("mostro.heartbeat"));

    notify_standby(root);

    for pid in mostrod_pids(&active_dir) {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    Ok(())
}

fn notify_standby(root: &Path) {
    let _ = File::create(root.join(".standby_wake"));
    let _ = File::create(root.join("active").join(".standby_wake"));
    let _ = File::create(Path::new("/data/.standby_wake"));
    let _ = File::create(Path::new("/data/config/.standby_wake"));
    let _ = File::create(Path::new("/data/config/active/.standby_wake"));
}

pub async fn broadcast_instance_info(root: PathBuf, config: Configuration) {
    let Ok(Some(keys)) = identity::load_identity_keys(&root) else {
        return;
    };
    let pubkey_hex = keys.public_key().to_hex();
    let fee_str = format!("{}", config.market.fee_bps as f64 / 10000.0);
    let bond_pct_str = format!("{}", config.safety.bond_bps as f64 / 10000.0);
    let bond_apply_str = match config.safety.bond_apply_to {
        BondApply::Make => "make",
        BondApply::Take => "take",
        BondApply::Both => "both",
    };

    let mut preserved_tags = Vec::new();
    for relay in &config.nostr.relays {
        let connect_fut = connect_async(relay);
        if let Ok(Ok((mut ws, _))) = tokio::time::timeout(Duration::from_secs(2), connect_fut).await
        {
            let req = serde_json::json!(["REQ", "prev_info", {
                "authors": [pubkey_hex],
                "kinds": [38385],
                "limit": 1
            }])
            .to_string();
            if ws.send(Message::Text(req.into())).await.is_ok() {
                let fetch_fut = async {
                    while let Some(Ok(msg)) = ws.next().await {
                        if let Message::Text(text) = msg
                            && let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&text)
                        {
                            if arr.len() >= 3 && arr[0] == "EVENT" {
                                if let Ok(ev) =
                                    serde_json::from_value::<nostr::Event>(arr[2].clone())
                                {
                                    return Some(ev);
                                }
                            } else if arr.len() >= 2 && arr[0] == "EOSE" {
                                break;
                            }
                        }
                    }
                    None
                };
                if let Ok(Some(prev_ev)) =
                    tokio::time::timeout(Duration::from_millis(800), fetch_fut).await
                {
                    for tag in prev_ev.tags {
                        let slice = tag.as_slice();
                        if let Some(key) = slice.first()
                            && (key.starts_with("lnd_") || key == "mostro_commit_hash")
                        {
                            preserved_tags.push(tag);
                        }
                    }
                    let _ = ws.close(None).await;
                    break;
                }
            }
            let _ = ws.close(None).await;
        }
    }

    let mut tags = vec![
        Tag::identifier(&pubkey_hex),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("mostro_version")),
            vec!["0.18.8".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("max_order_amount")),
            vec![config.market.max_trade_sats.to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("min_order_amount")),
            vec![config.market.min_trade_sats.to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("expiration_hours")),
            vec!["24".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("expiration_seconds")),
            vec!["900".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("fiat_currencies_accepted")),
            vec![config.market.fiat_currencies.join(",")],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("max_orders_per_response")),
            vec!["10".to_string()],
        ),
        Tag::custom(TagKind::Custom(Cow::Borrowed("fee")), vec![fee_str]),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("pow")),
            vec![config.safety.pow.to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("pow_first_contact")),
            vec![config.safety.pow_first_contact.to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("protocol_version")),
            vec!["2".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("hold_invoice_cltv_delta")),
            vec!["144".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("y")),
            vec!["mostro".to_string(), config.community.name.clone()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("z")),
            vec!["info".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("invoice_expiration_window")),
            vec!["3600".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("hold_invoice_expiration_window")),
            vec!["300".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("bond_enabled")),
            vec![config.safety.bond_enabled.to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("bond_amount_pct")),
            vec![bond_pct_str],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("bond_base_amount_sats")),
            vec![config.safety.base_bond_sats.to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("bond_apply_to")),
            vec![bond_apply_str.to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("bond_slash_on_waiting_timeout")),
            vec![config.safety.automatic_timeout_slash.to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("bond_slash_node_share_pct")),
            vec!["0.5".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("bond_payout_claim_window_days")),
            vec!["15".to_string()],
        ),
        Tag::custom(
            TagKind::Custom(Cow::Borrowed("maintenance_mode")),
            vec!["false".to_string()],
        ),
    ];

    tags.extend(preserved_tags);

    let Ok(event) = EventBuilder::new(Kind::Custom(38385), "")
        .tags(tags)
        .sign_with_keys(&keys)
    else {
        return;
    };

    let msg = serde_json::json!(["EVENT", event]).to_string();

    for relay in &config.nostr.relays {
        let relay_url = relay.clone();
        let msg = msg.clone();
        tokio::spawn(async move {
            if let Ok(Ok((mut ws, _))) =
                tokio::time::timeout(Duration::from_secs(3), connect_async(&relay_url)).await
            {
                let _ = ws.send(Message::Text(msg.into())).await;
                let _ = ws.close(None).await;
            }
        });
    }
}

fn uses_settings_directory(cmdline: &[u8], settings_dir: &Path) -> bool {
    let args: Vec<&[u8]> = cmdline.split(|byte| *byte == 0).collect();
    args.windows(2)
        .any(|pair| pair[0] == b"-d" && pair[1] == settings_dir.as_os_str().as_bytes())
}

fn is_mostrod_running(settings_dir: &Path) -> bool {
    if !mostrod_pids(settings_dir).is_empty() {
        return true;
    }
    let pid_file = settings_dir.join("mostro.pid");
    if pid_file.is_file() {
        return true;
    }
    let hb_file = settings_dir.join("mostro.heartbeat");
    if let Ok(meta) = fs::metadata(&hb_file)
        && let Ok(modified) = meta.modified()
        && let Ok(elapsed) = SystemTime::now().duration_since(modified)
        && elapsed.as_secs() < 30
    {
        return true;
    }
    false
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
