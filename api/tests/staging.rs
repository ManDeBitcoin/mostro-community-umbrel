use mostro_community_api::{config::Configuration, staging::stage, store::Store};
use std::{fs, os::unix::fs::PermissionsExt};

fn config() -> Configuration {
    serde_json::from_str(include_str!("fixtures/community.json")).unwrap()
}

#[test]
fn stages_a_private_inert_revision_once() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("config");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let mut store = Store::open(root.clone()).unwrap();
    store.save(config()).unwrap();

    let staged = stage(&root, "https://127.0.0.1:10009").unwrap();
    assert_eq!(staged.revision, 1);
    assert_eq!(staged.state, "staged_only");
    assert_eq!(
        fs::metadata(&staged.directory)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let settings_path = staged.directory.join("settings.toml");
    assert_eq!(
        fs::metadata(&settings_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let doc: toml::Value = toml::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
    assert_eq!(
        doc["lightning"]["lnd_grpc_host"].as_str(),
        Some("https://127.0.0.1:10009")
    );
    assert_eq!(
        doc["lightning"]["lnd_cert_file"].as_str(),
        Some("/lnd/tls.cert")
    );
    assert_eq!(
        doc["lightning"]["lnd_macaroon_file"].as_str(),
        Some("/lnd/mostro.macaroon")
    );
    assert_eq!(doc["nostr"]["nsec_privkey"].as_str(), Some(""));
    assert_eq!(doc["rpc"]["enabled"].as_bool(), Some(false));
    assert!(!staged.directory.join("mostro.db").exists());
    assert!(stage(&root, "https://127.0.0.1:10009").is_err());
    assert!(
        fs::read_to_string(settings_path)
            .unwrap()
            .contains("127.0.0.1:10009")
    );
}

#[test]
fn rejects_unsafe_parent_and_invalid_origin_before_staging() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("config");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    Store::open(root.clone()).unwrap().save(config()).unwrap();
    assert!(stage(&root, "http://127.0.0.1:10009").is_err());
    assert!(stage(&root, "https://127.0.0.1").is_err());
    assert!(!root.join("staging").exists());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(stage(&root, "https://127.0.0.1:10009").is_err());
}
