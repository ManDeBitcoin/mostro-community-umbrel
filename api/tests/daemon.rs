use mostro_community_api::{
    adapters::Integrations,
    config::Configuration,
    daemon::{
        DaemonState, MOSTRO_VERSION, activate, deactivate, report, report_with_node_info,
        sync_active_settings,
    },
    identity,
    orders::NodeInfo,
    store::Store,
};
use nostr::{Keys, SecretKey, ToBech32};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// A private CONFIG_DIR with a saved draft and an imported identity.
fn configured_root(temp: &tempfile::TempDir, seed: u8) -> (PathBuf, Store) {
    let root = temp.path().join("config");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let mut store = Store::open(root.clone()).unwrap();
    store.save(config()).unwrap();
    let keys = Keys::new(SecretKey::from_slice(&[seed; 32]).unwrap());
    identity::import(
        &root,
        &keys.secret_key().to_bech32().unwrap(),
        &keys.public_key().to_bech32().unwrap(),
    )
    .unwrap();
    (root, store)
}

fn announced(version: &str, created_at: u64) -> NodeInfo {
    NodeInfo {
        event_id: "a".repeat(64),
        created_at,
        name: Some("Comunidad de prueba".into()),
        mostro_version: Some(version.into()),
        protocol_version: Some("2".into()),
        tags: BTreeMap::from([("mostro_version".to_string(), version.to_string())]),
    }
}

/// What the container entrypoint leaves while mostrod is alive.
fn mark_alive(active_dir: &Path) {
    fs::write(active_dir.join("mostro.pid"), "4242\n").unwrap();
    fs::write(active_dir.join("mostro.heartbeat"), "").unwrap();
}

fn config() -> Configuration {
    serde_json::from_str(include_str!("fixtures/community.json")).unwrap()
}

#[tokio::test]
async fn reports_unconfigured_daemon_state() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("config");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();

    let rep = report(&root, &Integrations::from_env()).await;
    assert_eq!(rep.state, DaemonState::Unconfigured);
    assert!(!rep.identity_present);
    assert!(rep.npub.is_none());
    assert!(rep.draft_revision.is_none());
    assert!(rep.active_revision.is_none());
    assert!(!rep.can_activate);
    assert!(!rep.warnings.is_empty());
}

#[tokio::test]
async fn lifecycle_standby_to_activated_to_deactivated() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("config");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();

    let mut store = Store::open(root.clone()).unwrap();
    store.save(config()).unwrap();

    let keys = Keys::new(SecretKey::from_slice(&[7; 32]).unwrap());
    let secret = keys.secret_key().to_bech32().unwrap();
    let public = keys.public_key().to_bech32().unwrap();
    identity::import(&root, &secret, &public).unwrap();

    let rep = report(&root, &Integrations::from_env()).await;
    assert_eq!(rep.state, DaemonState::ConfiguredStandby);
    assert!(rep.identity_present);
    assert_eq!(rep.npub.as_deref(), Some(public.as_str()));
    assert_eq!(rep.draft_revision, Some(1));
    assert!(rep.active_revision.is_none());
    assert!(rep.can_activate);

    let activated = activate(&root, "https://127.0.0.1:10009").unwrap();
    assert_eq!(activated.revision, 1);
    assert_eq!(activated.settings_sha256.len(), 64);
    assert!(activated.settings_path.is_file());

    let active_dir = root.join("active");
    assert_eq!(
        fs::metadata(&active_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let settings_path = active_dir.join("settings.toml");
    assert_eq!(
        fs::metadata(&settings_path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let settings_str = fs::read_to_string(&settings_path).unwrap();
    assert!(!settings_str.contains("nsec1"));
    assert!(settings_str.contains("https://127.0.0.1:10009"));
    assert!(settings_str.contains("fee = 0.006"));

    let rep_active = report(&root, &Integrations::from_env()).await;
    assert!(matches!(
        rep_active.state,
        DaemonState::ActiveReady | DaemonState::ActiveRunning
    ));
    assert_eq!(rep_active.active_revision, Some(1));
    assert_eq!(
        rep_active.active_settings_hash.as_deref(),
        Some(activated.settings_sha256.as_str())
    );
    if rep_active.state == DaemonState::ActiveReady {
        assert!(
            rep_active
                .warnings
                .iter()
                .any(|warning| warning.contains("ejecución del daemon sin verificar"))
        );
    }

    let mut updated = config();
    updated.market.max_trade_sats += 1;
    store.save(updated).unwrap();
    let changed = report(&root, &Integrations::default()).await;
    assert_eq!(changed.draft_revision, Some(2));
    assert_eq!(changed.active_revision, Some(1));
    assert!(
        changed
            .warnings
            .iter()
            .any(|warning| warning.contains("cambios en el borrador"))
    );

    deactivate(&root).unwrap();
    assert!(!settings_path.exists());
    assert!(!active_dir.join("status.json").exists());

    let rep_after = report(&root, &Integrations::from_env()).await;
    assert_eq!(rep_after.state, DaemonState::ConfiguredStandby);
    assert!(rep_after.active_revision.is_none());
    assert!(rep_after.active_settings_hash.is_none());
}

#[tokio::test]
async fn activation_fails_without_identity_or_invalid_origin() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("config");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();

    let mut store = Store::open(root.clone()).unwrap();
    store.save(config()).unwrap();

    let err = activate(&root, "https://127.0.0.1:10009").unwrap_err();
    assert_eq!(
        err,
        "No se puede activar el demonio sin una identidad privada importada"
    );

    let keys = Keys::new(SecretKey::from_slice(&[8; 32]).unwrap());
    let secret = keys.secret_key().to_bech32().unwrap();
    let public = keys.public_key().to_bech32().unwrap();
    identity::import(&root, &secret, &public).unwrap();

    assert!(activate(&root, "http://127.0.0.1:10009").is_err());
    assert!(activate(&root, "https://127.0.0.1").is_err());
    assert!(activate(&root, "not-a-url").is_err());
}

#[tokio::test]
async fn saving_an_equivalent_draft_does_not_restart_the_daemon() {
    let temp = tempfile::tempdir().unwrap();
    let (root, mut store) = configured_root(&temp, 31);
    let origin = "https://127.0.0.1:10009";
    let wake = root.join(".standby_wake");
    let settings = root.join("active").join("settings.toml");

    // The first activation writes the settings and wakes the daemon.
    let first = activate(&root, origin).unwrap();
    assert!(first.settings_changed);
    assert!(wake.exists());
    let rendered = fs::read(&settings).unwrap();
    fs::remove_file(&wake).unwrap();

    // A change that never reaches settings.toml (a payment method label)
    // leaves the daemon alone; only the active revision moves on.
    let mut relabelled = config();
    relabelled.payment_methods[0].label = "Transferencia SEPA".into();
    store.save(relabelled).unwrap();
    let synced = sync_active_settings(&root, origin).unwrap();
    assert!(!synced.settings_changed);
    assert_eq!(synced.revision, 2);
    assert!(
        !wake.exists(),
        "an unchanged settings.toml must not restart mostrod"
    );
    assert_eq!(fs::read(&settings).unwrap(), rendered);
    let rep = report(&root, &Integrations::default()).await;
    assert_eq!(rep.active_revision, Some(2));
    assert!(
        !rep.warnings
            .iter()
            .any(|w| w.contains("cambios en el borrador"))
    );

    // A change that does reach settings.toml restarts it.
    let mut repriced = config();
    repriced.market.fee_bps = 80;
    store.save(repriced).unwrap();
    let synced = sync_active_settings(&root, origin).unwrap();
    assert!(synced.settings_changed);
    assert!(wake.exists());
    assert!(
        fs::read_to_string(&settings)
            .unwrap()
            .contains("fee = 0.008")
    );
    fs::remove_file(&wake).unwrap();

    // An explicit activation always restarts, even with nothing to change.
    let again = activate(&root, origin).unwrap();
    assert!(!again.settings_changed);
    assert!(wake.exists());

    // Nothing is left behind by the atomic write.
    let leftovers: Vec<_> = fs::read_dir(root.join("active"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert_eq!(
        fs::metadata(&settings).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn reports_the_version_the_daemon_announces_when_it_is_recent() {
    let temp = tempfile::tempdir().unwrap();
    let (root, _store) = configured_root(&temp, 32);
    activate(&root, "https://127.0.0.1:10009").unwrap();
    let integrations = Integrations::default();

    // Nothing on the relays: only the packaged binary (or the pin) is known.
    let rep = report(&root, &integrations).await;
    assert_ne!(rep.version_source, "announced");
    assert_eq!(rep.mostro_version, rep.packaged_version);
    assert!(rep.announced.is_none());
    assert!(!rep.announced_fresh);
    assert_eq!(rep.announced_age_secs, None);
    if rep.version_source == "pinned" {
        assert_eq!(rep.packaged_version, MOSTRO_VERSION);
    }

    // A recent info event from the daemon is the authoritative version.
    let rep =
        report_with_node_info(&root, &integrations, Some(announced("0.19.2", now() - 30))).await;
    assert_eq!(rep.mostro_version, "0.19.2");
    assert_eq!(rep.version_source, "announced");
    assert!(rep.announced_fresh);
    assert!(
        rep.announced_age_secs
            .is_some_and(|age| (30..40).contains(&age))
    );
    // This panel does not see a daemon running, yet one is announcing the
    // identity: a second instance must not be started.
    assert_eq!(rep.state, DaemonState::ActiveReady);
    assert!(
        rep.warnings
            .iter()
            .any(|w| w.contains("otra instancia de Mostro usa esta misma clave"))
    );

    // An old announcement proves nothing about the present.
    let rep = report_with_node_info(
        &root,
        &integrations,
        Some(announced("0.19.0", now() - 3600)),
    )
    .await;
    assert_ne!(rep.version_source, "announced");
    assert_eq!(rep.mostro_version, rep.packaged_version);
    assert!(!rep.announced_fresh);
    assert_eq!(
        rep.announced
            .as_ref()
            .and_then(|a| a.mostro_version.as_deref()),
        Some("0.19.0")
    );
    assert!(
        !rep.warnings
            .iter()
            .any(|w| w.contains("otra instancia de Mostro usa esta misma clave"))
    );
}

#[tokio::test]
async fn running_state_needs_a_live_heartbeat_and_a_stable_process() {
    let temp = tempfile::tempdir().unwrap();
    let (root, _store) = configured_root(&temp, 33);
    activate(&root, "https://127.0.0.1:10009").unwrap();
    let active = root.join("active");
    let integrations = Integrations::default();

    // A pid file left by a hard kill does not mean the daemon is running.
    fs::write(active.join("mostro.pid"), "4242\n").unwrap();
    let rep = report(&root, &integrations).await;
    assert_eq!(rep.state, DaemonState::ActiveReady);

    // The entrypoint's heartbeat does.
    mark_alive(&active);
    let rep =
        report_with_node_info(&root, &integrations, Some(announced("0.19.2", now() - 5))).await;
    assert_eq!(rep.state, DaemonState::ActiveRunning);
    assert!(!rep.warnings.iter().any(|w| w.contains("sin verificar")));
    assert!(
        !rep.warnings
            .iter()
            .any(|w| w.contains("otra instancia de Mostro usa esta misma clave"))
    );

    // A daemon announcing another version than the packaged one is flagged.
    let rep =
        report_with_node_info(&root, &integrations, Some(announced("0.17.5", now() - 5))).await;
    assert_eq!(rep.mostro_version, "0.17.5");
    assert!(
        rep.warnings
            .iter()
            .any(|w| w.contains("anuncia la versión 0.17.5"))
    );

    // The daemon died two seconds after starting and was just respawned: the
    // heartbeat is fresh, but it is not a running node.
    fs::write(
        active.join("mostro.last_exit"),
        format!("{} 1 2\n", now() - 3),
    )
    .unwrap();
    let rep = report(&root, &integrations).await;
    assert_eq!(rep.state, DaemonState::ActiveReady);
    let exit = rep.last_exit.expect("last exit");
    assert_eq!((exit.code, exit.uptime_secs), (1, 2));
    assert!(
        rep.warnings
            .iter()
            .any(|w| w.contains("terminó con código 1"))
    );

    // An old exit followed by a healthy run is history, not a crash loop.
    fs::write(
        active.join("mostro.last_exit"),
        format!("{} 1 2\n", now() - 900),
    )
    .unwrap();
    let rep = report(&root, &integrations).await;
    assert_eq!(rep.state, DaemonState::ActiveRunning);
    assert!(rep.last_exit.is_some());

    // Deactivation clears the runtime markers.
    deactivate(&root).unwrap();
    assert!(!active.join("mostro.last_exit").exists());
    assert!(!active.join("mostro.heartbeat").exists());
}

#[tokio::test]
async fn warns_when_payouts_cannot_pay_any_routing_fee() {
    let temp = tempfile::tempdir().unwrap();
    let (root, mut store) = configured_root(&temp, 34);
    let rep = report(&root, &Integrations::default()).await;
    assert!(!rep.warnings.iter().any(|w| w.contains("enrutamiento")));

    let mut free_routes_only = config();
    free_routes_only.market.max_routing_fee_bps = 0;
    store.save(free_routes_only).unwrap();
    let rep = report(&root, &Integrations::default()).await;
    assert!(rep.warnings.iter().any(|w| w.contains("enrutamiento es 0")));
}

/// Verified on regtest against mostrod v0.19.2: with `pow_first_contact`
/// above `pow`, a client that does not mine it gets no answer at all.
#[tokio::test]
async fn warns_when_first_contact_pow_can_lock_clients_out() {
    let temp = tempfile::tempdir().unwrap();
    let (root, mut store) = configured_root(&temp, 35);
    let warned = |rep: &mostro_community_api::daemon::DaemonReport| {
        rep.warnings.iter().any(|w| w.contains("pow_first_contact"))
    };

    for (pow, first_contact, expected) in [(0, 0, false), (8, 8, false), (0, 8, true)] {
        let mut draft = config();
        draft.safety.pow = pow;
        draft.safety.pow_first_contact = first_contact;
        store.save(draft).unwrap();
        let rep = report(&root, &Integrations::default()).await;
        assert_eq!(
            warned(&rep),
            expected,
            "pow {pow}, first contact {first_contact}"
        );
    }
}
