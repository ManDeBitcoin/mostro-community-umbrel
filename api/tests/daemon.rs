use mostro_community_api::{
    adapters::Integrations,
    config::Configuration,
    daemon::{DaemonState, activate, deactivate, report},
    identity,
    store::Store,
};
use nostr::{Keys, SecretKey, ToBech32};
use std::{fs, os::unix::fs::PermissionsExt};

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
    assert_eq!(rep_active.state, DaemonState::ActiveReady);
    assert_eq!(rep_active.active_revision, Some(1));
    assert_eq!(
        rep_active.active_settings_hash.as_deref(),
        Some(activated.settings_sha256.as_str())
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
